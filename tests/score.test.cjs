const {test} = require('node:test');
const assert = require('node:assert/strict');
const S = require('../qb_synergy_dashboard/score.js');
const thresholds = {score:1,qualified:30,weekly:1};
function row(id, targets=30, overrides={}) {
  return {qbId:'q',receiverId:id,team:'T',position:'WR',targets,first_downs:10,explosives:3,
    epa_per_target:.3,success_rate:.5,cpoe:2,yac_over_expected_per_reception:1,qb_epa_lift:.2,
    target_share:.3,money_down_target_share:.2,red_zone_target_share:.2,
    interception_rate:0,money_down_failure_rate:.4,...overrides};
}
const apply=rows=>S.apply({pairs:rows,thresholds});
test('qualification boundaries and identical shared calculation',()=>{
  const data=apply([row('1',1),row('14',14),row('15',15),row('29',29),row('30',30)]);
  for(const r of data.pairs)assert.equal(typeof r.synergyScore,'number');
  assert.equal(S.ranked(data.pairs).length,1);
  assert.equal(S.ranked(data.pairs,{minimum:1}).length,5);
  for(const r of data.pairs)assert.equal(S.calculate(data,r),r.synergyScore);
});
test('missing inputs suppress scores and do not become zero',()=>{
  assert.equal(apply([row('r',30,{cpoe:null})]).pairs[0].synergyScore,null);
  assert.equal(S.number(null),null);
  assert.equal(S.number(0),0);
  assert.equal(typeof apply([row('r',1,{yac_over_expected_per_reception:null})]).pairs[0].synergyScore,'number');
  assert.equal(typeof S.apply({pairs:[row('r',1)]}).pairs[0].synergyScore,'number');
});
test('zero receptions earn zero YAC points and still produce season and weekly scores',()=>{
  for(const weekly of [false,true]) {
    const pairs=[row('miss',1,{receptions:0,first_downs:0,explosives:0,epa_per_target:-.8,
      success_rate:0,cpoe:-75,yac_over_expected_per_reception:null,qb_epa_lift:-.4}),
      row('catch',5,{receptions:4,yac_over_expected_per_reception:2})];
    S.apply({pairs,thresholds},{weekly});
    const miss=pairs[0],yac=miss.scoreDetail.components.find(c=>c.label==='YAC over expected / rec');
    assert.equal(typeof miss.synergyScore,'number');
    assert.equal(yac.points,0);assert.equal(yac.weight,7);
    assert.match(yac.note,/No receptions/);
    assert.equal(miss.yac_over_expected_per_reception,null);
    assert.equal(miss.scoreYacoe,null);
    assert.equal(pairs[1].scoreYacoe,2);
    assert.equal(miss.synergyScore,Math.max(0,Math.round(miss.scoreDetail.components.reduce((n,c)=>n+c.points,0)-miss.scoreDetail.penalty)));
    assert.equal(S.ranked(pairs,{minimum:1}).length,2);
  }
});
test('an all-incomplete peer pool scores without invented YAC observations',()=>{
  const pairs=[row('a',1,{receptions:0,yac_over_expected_per_reception:null}),
    row('b',2,{receptions:0,yac_over_expected_per_reception:0})];
  apply(pairs);
  for(const r of pairs){
    assert.equal(typeof r.synergyScore,'number');
    assert.equal(r.scoreYacoe,null);
    assert.equal(r.scoreDetail.components.find(c=>c.label==='YAC over expected / rec').points,0);
  }
});
test('a catch with missing YAC data receives a score with explicitly unavailable YAC credit',()=>{
  const caught=row('caught',1,{receptions:1,yac_over_expected_per_reception:null});
  const unknown=row('unknown',1,{receptions:null,yac_over_expected_per_reception:null});
  const otherMissing=row('other',1,{receptions:0,cpoe:null,yac_over_expected_per_reception:null});
  apply([caught,unknown,otherMissing]);
  assert.equal(otherMissing.synergyScore,null);
  for(const r of [caught,unknown]){
    assert.equal(typeof r.synergyScore,'number');
    const yac=r.scoreDetail.components.find(c=>c.label==='YAC over expected / rec');
    assert.equal(yac.points,0);assert.equal(yac.modelUnavailable,true);
    assert.match(yac.note,/YAC model unavailable/);
    assert.equal(r.yac_over_expected_per_reception,null);
  }
});
test('RB peers cannot change WR/TE score',()=>{
  const wr=apply([row('a'),row('b',40,{epa_per_target:.7})]).pairs[0].synergyScore;
  const withRb=apply([row('a'),row('b',40,{epa_per_target:.7}),row('c',50,{position:'RB',epa_per_target:9})]);
  assert.equal(withRb.pairs[0].synergyScore,wr);
});
test('weekly pools and stabilization are independent from season scores',()=>{
  const week1={pairs:[row('a',1),row('b',2)],thresholds};
  S.apply(week1,{weekly:true});const score=week1.pairs[0].synergyScore;
  S.apply({pairs:[row('x',20,{epa_per_target:20})],thresholds},{weekly:true});
  assert.equal(week1.pairs[0].synergyScore,score);assert.notEqual(score,null);
  assert.notEqual(week1.pairs[1].synergyScore,null);
  assert.equal(week1.pairs[0].scoreDetail.minimum,1);
  assert.equal(week1.pairs[0].scoreDetail.peers,2);
  assert.equal(typeof apply([row('a',1)]).pairs[0].synergyScore,'number');
});
test('one-target weekly scores require real targets and complete inputs in every scope',()=>{
  for(const scopeThresholds of [thresholds,{score:1,qualified:5,weekly:1},undefined]) {
    const pairs=[row('zero',0),row('one',1),row('missing',1,{cpoe:null})];
    S.apply({pairs,thresholds:scopeThresholds},{weekly:true});
    assert.equal(pairs[0].synergyScore??null,null);
    assert.equal(typeof pairs[1].synergyScore,'number');
    assert.equal(pairs[1].scoreDetail.minimum,1);
    assert.equal(pairs[2].synergyScore,null);
  }
});
test('recent view uses its own raw rows, without changing season rows',()=>{
  const season=apply([row('a',60)]);const recent=apply([row('a',10)]);
  assert.notEqual(season.pairs[0].synergyScore,null);assert.notEqual(recent.pairs[0].synergyScore,null);
  assert.equal(S.ranked(season.pairs).length,1);assert.equal(S.ranked(recent.pairs).length,0);
  assert.equal(recent.pairs[0].targets,10);assert.equal(season.pairs[0].targets,60);
});
test('playoff scores start at one target and qualify at five',()=>{
  const data=S.apply({pairs:[row('a',1),row('b',4),row('c',5)],thresholds:{score:1,qualified:5,weekly:1}});
  assert.equal(S.ranked(data.pairs,{minimum:1}).length,3);
  assert.deepEqual(S.ranked(data.pairs,{minimum:5}).map(r=>r.receiverId),['c']);
});
test('rank changes use matching filters, stable identity and new qualification',()=>{
  const previous=[{...row('a'),synergyScore:80},{...row('b',14),synergyScore:null}];
  const current=[{...row('a'),synergyScore:70},{...row('b'),synergyScore:90}];
  const changes=S.rankChanges(current,previous,{position:'WR',minimum:30});
  assert.equal(changes.get(S.id(current[0])),-1);assert.equal(changes.get(S.id(current[1])),'New');
  assert.equal(S.rankChanges(current,previous,{position:'RB',minimum:30}).size,0);
});

function observed(id,position='WR',overrides={}) {
  return {qbId:'q',receiverId:id,team:'T',position,targets:20,receptions:10,first_downs:4,explosives:2,
    interceptions:0,successful_targets:10,success_targets:20,cpoe_targets:20,modeled_receptions:10,
    money_down_targets:4,money_down_failures:0,red_zone_targets:2,qb_targets:100,
    qb_money_down_targets:20,qb_red_zone_targets:10,epa_per_target:.3,cpoe:2,
    yac_over_expected_per_reception:1,qb_epa_lift:.2,...overrides};
}
const component=(r,key)=>r.scoreDetail.components.find(c=>c.key===key);

test('ties use midpoint ranks and missing values are never observations',()=>{
  assert.equal(S.percentile([0,0,0,0,1],0),40);
  assert.equal(S.percentile([0,0,0,0,0],0),50);
  assert.equal(S.percentile([7],7),50);
  assert.equal(S.percentile([null,undefined,'',0,2],0),25);
  assert.equal(S.percentile([],1),null);
  for(const value of [null,undefined,'',' ',true,false,[],{},Infinity,NaN]) assert.equal(S.number(value),null);
});

for(const position of ['WR','TE','RB','FB']) for(const weekly of [false,true]) {
  test(`${position} ${weekly?'weekly':'season'}: zero events earn no credit in any applicable category`,()=>{
    const r=observed('zero',position,{targets:1,receptions:0,modeled_receptions:0,first_downs:0,explosives:0,
      successful_targets:0,success_targets:1,cpoe_targets:1,money_down_targets:0,money_down_failures:0,
      red_zone_targets:0,epa_per_target:-.5,cpoe:-50,yac_over_expected_per_reception:null,qb_epa_lift:-.3});
    const other=observed('other',position);
    S.apply({pairs:[r,other],thresholds},{weekly});
    assert.equal(typeof r.synergyScore,'number');
    for(const key of ['scoreSuccess','scoreFirstDown','scoreExplosive','money_down_target_share','red_zone_target_share','scoreYacoe']) {
      assert.equal(component(r,key).points,0,key);
      assert.ok(component(r,key).note,key);
    }
    assert.equal(r.money_down_failure_rate,null);
    assert.equal(r.scoreDetail.moneyPenalty,0);
    assert.equal(r.scoreDetail.turnoverPenalty,0);
    for(const c of r.scoreDetail.components) assert.ok(c.points>=0&&c.points<=c.weight,c.label);
  });
}

test('all-zero usage pools receive zero points, all-positive ties receive half credit',()=>{
  const rows=[observed('a','RB',{red_zone_targets:0,explosives:0}),observed('b','RB',{red_zone_targets:0,explosives:0})];
  apply(rows);
  for(const r of rows){
    assert.equal(component(r,'red_zone_target_share').points,0);
    assert.equal(component(r,'scoreExplosive').points,0);
    for(const key of ['scoreEpa','scoreSuccess','scoreCpoe','scoreFirstDown','scoreYacoe','target_share','money_down_target_share','scoreQbLift']) {
      const c=component(r,key);assert.equal(c.points,c.weight/2);
    }
  }
});

test('signed zero metrics retain relative credit against negative values',()=>{
  const zero=observed('zero','TE',{epa_per_target:0,cpoe:0,yac_over_expected_per_reception:0,qb_epa_lift:0});
  const negative=observed('negative','WR',{epa_per_target:-1,cpoe:-5,yac_over_expected_per_reception:-2,qb_epa_lift:-1});
  apply([zero,negative]);
  for(const key of ['scoreEpa','scoreCpoe','scoreYacoe','scoreQbLift']) {
    assert.equal(component(zero,key).percentile,75);
    assert.ok(component(zero,key).points>component(negative,key).points);
    assert.ok(!component(zero,key).zeroEvent);
  }
});

test('undefined opportunities stay unavailable, earn zero, and stay out of peer distributions',()=>{
  const no=observed('none','WR',{money_down_targets:0,money_down_failures:0,red_zone_targets:0,qb_money_down_targets:0,qb_red_zone_targets:0});
  const yes=observed('yes');apply([no,yes]);
  for(const key of ['money_down_target_share','red_zone_target_share']) {
    assert.equal(no[key],null);assert.equal(component(no,key).points,0);
    assert.equal(component(no,key).noOpportunities,true);assert.equal(component(yes,key).peers,1);
  }
  assert.equal(no.scoreDetail.moneyPenalty,0);
  assert.equal(yes.scoreDetail.penalties[1].peers,1);
  assert.notEqual(no.synergyScore,null);
});

test('positive penalty ties cannot escape penalties in a lone or identical peer pool',()=>{
  for(const size of [1,2,4]) {
    const rows=Array.from({length:size},(_,i)=>observed(String(i),'RB',{interceptions:10,money_down_failures:4}));
    apply(rows);
    for(const r of rows){
      assert.equal(r.scoreDetail.turnoverPenalty,1.5);assert.equal(r.scoreDetail.moneyPenalty,1);
      assert.ok(r.synergyScore<50);assert.ok(r.scoreDetail.flags.some(f=>f.code==='small-pool'));
    }
  }
});

test('integer hundredths round half points up and preserve just-below-half values',()=>{
  for(const [cents,expected] of [[3949,39],[3950,40],[3951,40],[7349,73],[7350,74],[-50,0],[10000,100]]) {
    assert.equal(S.totalScore(cents),expected);
  }
  const data=apply([observed('a'),observed('b','TE',{cpoe:4,interceptions:1,money_down_failures:1})]);
  for(const r of data.pairs) {
    const d=r.scoreDetail;
    assert.equal(d.componentCents,d.components.reduce((n,c)=>n+c.cents,0));
    assert.equal(d.penaltyCents,d.penalties.reduce((n,c)=>n+c.cents,0));
    assert.equal(r.synergyScore,Math.max(0,Math.floor((d.componentCents-d.penaltyCents+50)/100)));
  }
});

test('YAC and CPOE stabilization uses observations, not unmodeled targets',()=>{
  const first=observed('a','WR',{targets:20,modeled_receptions:1,cpoe_targets:2,cpoe:10,yac_over_expected_per_reception:5});
  const moreTargets={...first,targets:200};
  apply([first,observed('b')]);apply([moreTargets,observed('b')]);
  assert.equal(first.scoreYacoe,moreTargets.scoreYacoe);
  assert.equal(first.scoreCpoe,moreTargets.scoreCpoe);
  assert.equal(component(first,'scoreYacoe').observations,1);
  assert.ok(first.scoreDetail.flags.some(f=>f.label==='Partial YAC coverage'));
  assert.ok(first.scoreDetail.flags.some(f=>f.label==='Partial CPOE coverage'));
});

test('an entirely missing success model is not a measured zero success rate',()=>{
  const r=observed('unknown','WR',{success_targets:0,successful_targets:0});apply([r,observed('other')]);
  assert.equal(r.success_rate,null);assert.equal(component(r,'scoreSuccess').points,null);
  assert.equal(r.synergyScore,null);
});

test('QB lift confidence is limited by its other-receiver comparison sample',()=>{
  const first=observed('a','WR',{targets:20,qb_targets:21,qb_epa_lift:2});
  const moreOwnTargets={...first,targets:200,qb_targets:201};
  apply([first,observed('b')]);apply([moreOwnTargets,observed('b')]);
  assert.equal(component(first,'scoreQbLift').observations,1);
  assert.equal(first.scoreQbLift,moreOwnTargets.scoreQbLift);
  assert.ok(first.scoreDetail.flags.some(f=>f.code==='small-qb-reference'));
  const noOthers=observed('none','WR',{qb_targets:20,qb_epa_lift:null});apply([noOthers]);
  assert.equal(noOthers.synergyScore,null);
});

test('reapplying after lost eligibility clears stale scores and unsupported positions never enter pools',()=>{
  const r=observed('r');apply([r]);assert.notEqual(r.synergyScore,null);
  r.targets=0;apply([r]);assert.equal(r.synergyScore,null);assert.equal(r.scoreDetail,null);
  const valid=observed('valid'),unknown=observed('unknown','CB',{epa_per_target:99});
  apply([valid,unknown]);assert.equal(unknown.synergyScore,null);assert.equal(valid.scoreDetail.peers,1);
});

test('WR and TE share a pool, FB and RB share a pool, and positions cannot contaminate another group',()=>{
  const a=observed('a','WR'), b=observed('b','TE',{epa_per_target:5});
  apply([a,b]);assert.equal(a.scoreDetail.peers,2);assert.equal(component(a,'scoreEpa').percentile,25);
  const before=a.synergyScore;
  const rb=observed('rb','RB'), fb=observed('fb','FB',{epa_per_target:90});
  apply([a,b,rb,fb]);assert.equal(a.synergyScore,before);assert.equal(rb.scoreDetail.peers,2);
  assert.equal(S.ranked([a,b,rb,fb],{position:'RB',minimum:1}).length,2);
});

test('scores are deterministic across input order and repeat calculations',()=>{
  const rows=Array.from({length:20},(_,i)=>observed(String(i),i%3===0?'RB':i%3===1?'WR':'TE',
    {epa_per_target:i/7,cpoe:i-8,interceptions:i%4,money_down_failures:i%5}));
  const one=apply(structuredClone(rows)).pairs, two=apply(structuredClone(rows).reverse()).pairs;
  const scores=new Map(one.map(r=>[S.id(r),r.synergyScore]));
  for(const r of two) assert.equal(r.synergyScore,scores.get(S.id(r)));
  apply(two);for(const r of two) assert.equal(r.synergyScore,scores.get(S.id(r)));
});

test('mathematically identical efficiency values stay tied at every sample size',()=>{
  for(const position of ['WR','TE','RB'])for(const weekly of [false,true]) {
    const rows=[1,2,3,15,30,80].map((n,i)=>observed(String(i),position,{targets:n,receptions:n,modeled_receptions:n,
      cpoe_targets:n,success_targets:n,successful_targets:0,first_downs:0,explosives:0,qb_targets:1000,
      epa_per_target:.3,cpoe:.3,yac_over_expected_per_reception:.3,qb_epa_lift:.3}));
    S.apply({pairs:rows,thresholds},{weekly});
    for(const r of rows)for(const key of ['scoreEpa','scoreCpoe','scoreYacoe','scoreQbLift']) {
      assert.equal(r[key],.3,`${position} ${weekly} ${r.targets} ${key}`);
      assert.equal(component(r,key).percentile,50);
    }
  }
});

for(const position of ['WR','TE','RB']) test(`${position}: improving each component cannot reduce its own points`,()=>{
  const changes=[['scoreEpa',{epa_per_target:2}],['scoreSuccess',{successful_targets:20}],['scoreCpoe',{cpoe:10}],
    ['scoreFirstDown',{first_downs:8}],['scoreYacoe',{yac_over_expected_per_reception:8}],
    ['target_share',{qb_targets:30}],['money_down_target_share',{money_down_targets:10}],
    ['red_zone_target_share',{red_zone_targets:8}],['scoreQbLift',{qb_epa_lift:5}],['scoreExplosive',{explosives:8}]];
  for(const [key,change] of changes){
    const baseline=observed('a',position), improved=observed('a',position,change);
    apply([baseline,observed('b',position)]);apply([improved,observed('b',position)]);
    assert.ok(component(improved,key).points>=component(baseline,key).points,key);
  }
});

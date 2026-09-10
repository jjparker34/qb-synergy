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
  assert.equal(apply([row('r',1,{yac_over_expected_per_reception:null})]).pairs[0].synergyScore,null);
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
test('a catch with missing YAC data is distinct from no catches',()=>{
  const caught=row('caught',1,{receptions:1,yac_over_expected_per_reception:null});
  const unknown=row('unknown',1,{receptions:null,yac_over_expected_per_reception:null});
  const otherMissing=row('other',1,{receptions:0,cpoe:null,yac_over_expected_per_reception:null});
  apply([caught,unknown,otherMissing]);
  for(const r of [caught,unknown,otherMissing])assert.equal(r.synergyScore,null);
  for(const r of [caught,unknown])assert.equal(r.scoreDetail.components.find(c=>c.label==='YAC over expected / rec').points,null);
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
    const pairs=[row('zero',0),row('one',1),row('missing',1,{yac_over_expected_per_reception:null})];
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

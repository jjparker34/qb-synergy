/* Publication gate: audit every component, position group, window, and snapshot. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const S=require('../qb_synergy_dashboard/score.js');
const site=path.join(__dirname,'../qb_synergy_dashboard');
const read=file=>JSON.parse(fs.readFileSync(path.join(site,file),'utf8'));
const report={methodVersion:S.methodVersion,files:0,views:0,scoreInstances:0,unavailable:0,
  zeroEventChecks:0,noOpportunityChecks:0,arithmeticChecks:0,aggregationChecks:0,teamRedZoneChecks:0,
  positions:{},scopes:[],examples:[]};
const countFields=['targets','receptions','yards','td','interceptions','first_downs','explosives',
  'red_zone_targets','money_down_targets','money_down_failures','modeled_receptions','cpoe_targets','success_targets','successful_targets'];
const zeros={scoreSuccess:'successful_targets',scoreFirstDown:'first_downs',scoreExplosive:'explosives',
  money_down_target_share:'money_down_targets',red_zone_target_share:'red_zone_targets',target_share:'targets'};
const sourceKeys={scoreEpa:'epa_per_target',scoreSuccess:'success_rate',scoreCpoe:'cpoe',scoreFirstDown:'firstDownRate',
  scoreYacoe:'yac_over_expected_per_reception',scoreQbLift:'qb_epa_lift',scoreExplosive:'explosiveRate'};
const observations={scoreEpa:'targets',scoreSuccess:'success_targets',scoreCpoe:'cpoe_targets',
  scoreFirstDown:'targets',scoreYacoe:'modeled_receptions',scoreQbLift:'targets',scoreExplosive:'targets'};
const nearest=(numerator,denominator)=>Number((2n*numerator+denominator)/(2n*denominator));
const close=(a,b,message)=>assert.ok(a===null&&b===null || typeof a==='number'&&typeof b==='number'&&Math.abs(a-b)<1e-9,message);
const expectedWeights=[23,16,6,8,7,14,7,4,12,3];
assert.deepEqual(S.components.map(c=>c[3]),expectedWeights,'Scoring weights changed');

function inspect(raw,thresholds,context,weekly=false,teamRedZone) {
  assert.ok(teamRedZone&&typeof teamRedZone==='object',`${context}: missing team red-zone totals`);
  for(const total of Object.values(teamRedZone))assert.ok(Number.isInteger(total)&&total>=0,`${context}: invalid team red-zone total`);
  const eligibleTotals={};
  for(const r of raw) {
    assert.equal(r.team_red_zone_targets,teamRedZone[r.team],`${context}: incorrect team red-zone denominator`);
    const expected=r.team_red_zone_targets>0?r.red_zone_targets/r.team_red_zone_targets:null;
    assert.ok(expected===null?r.red_zone_target_share===null:typeof r.red_zone_target_share==='number'&&Math.abs(expected-r.red_zone_target_share)<=1e-7,`${context}: incorrect team red-zone share`);
    eligibleTotals[r.team]=(eligibleTotals[r.team]||0)+r.red_zone_targets;
    report.teamRedZoneChecks++;
  }
  for(const [team,total] of Object.entries(eligibleTotals))assert.ok(total<=teamRedZone[team],`${context}: receiver totals exceed team targets`);
  const rows=structuredClone(raw);S.apply({pairs:rows,thresholds},{weekly});report.views++;
  const min=thresholds[weekly?'weekly':'score'];
  for(const group of ['WR_TE','RB']) {
    const peers=rows.filter(r=>S.group(r)===group&&r.targets>=min);
    const metricSamples=Object.fromEntries([...S.components.map(c=>c[2]),'interception_rate','money_down_failure_rate']
      .map(key=>[key,peers.map(r=>S.number(r[key])).filter(n=>n!==null)]));
    const countFor=(r,key)=>key==='scoreQbLift'?Math.max(0,Math.min(r.targets,r.qb_targets-r.targets)):r[observations[key]];
    const baselines=Object.fromEntries(Object.entries(sourceKeys).map(([key,rawKey])=>{
      const available=peers.filter(r=>countFor(r,key)>0&&S.number(r[rawKey])!==null);
      return [key,available.length?available.reduce((sum,r)=>sum+r[rawKey],0)/available.length:null];
    }));
    // Independent reference: average ordinal positions in sorted arrays, with exact rational rounding.
    const bounds=Object.fromEntries(Object.entries(metricSamples).map(([key,sample])=>{
      const ranks=new Map();
      [...sample].sort((a,b)=>a-b).forEach((v,i)=>{const rank=ranks.get(v)||[i,i];rank[1]=i;ranks.set(v,rank);});
      return [key,ranks];
    }));
    for(const r of peers) {
      const position=r.listedPosition==='FB'?'FB':r.position;
      const stats=report.positions[position]??={group,instances:0,scored:0,zeroEventChecks:0,components:{}};
      stats.instances++;
      const detail=r.scoreDetail,label=`${context}: ${S.id(r)}`;
      assert.equal(detail.peers,peers.length,label);
      assert.equal(detail.components.length,10,label);
      for(const c of detail.components) {
        const counter=stats.components[c.label]??={observed:0,unavailable:0,zeroCredit:0};
        c.points===null?counter.unavailable++:counter.observed++;
        const metricKey=sourceKeys[c.key];
        if(metricKey) {
          const baseline=baselines[c.key],n=countFor(r,c.key),k=weekly?8:40;
          const expected=n>0&&S.number(r[metricKey])!==null&&baseline!==null ? (n*r[metricKey]+k*baseline)/(n+k):null;
          close(c.value,expected,`${label}: ${c.label} stabilization`);
          assert.equal(c.observations,n,`${label}: ${c.label} observation count`);
        }
        if(zeros[c.key]&&r[zeros[c.key]]===0&&!(c.key==='scoreSuccess'&&r.success_targets===0)) {
          assert.equal(c.points,0,`${label}: zero event earned ${c.label} credit`);
          report.zeroEventChecks++;stats.zeroEventChecks++;counter.zeroCredit++;
        }
        if(c.noOpportunities) {
          assert.equal(c.rawValue,null,label);assert.equal(c.points,0,label);report.noOpportunityChecks++;
        }
        if(c.key==='scoreYacoe'&&(r.receptions===0||r.modeled_receptions===0))assert.equal(c.points,0,`${label}: unavailable YAC credit`);
        if(c.cents!==null) {
          assert.ok(Number.isInteger(c.cents)&&c.cents>=0&&c.cents<=c.weight*100,`${label}: component bounds`);
          assert.equal(c.points,c.cents/100,label);
        }
        const values=metricSamples[c.key];assert.equal(c.peers,values.length,label);
        if(!c.note&&c.points!==null) {
          const [first,last]=bounds[c.key].get(c.value);
          const pct=nearest(BigInt(100*(first+last+1)),BigInt(2*values.length));
          assert.equal(c.cents,c.weight*pct,`${label}: ${c.label} percentile arithmetic`);
          report.arithmeticChecks++;
        }
      }
      for(const p of detail.penalties) {
        const values=metricSamples[p.key];assert.equal(p.peers,values.length,label);
        if(p.value===0||p.noOpportunities)assert.equal(p.cents,0,`${label}: penalty without events`);
        else if(p.cents!==null) {
          const [first,last]=bounds[p.key].get(p.value);
          const expected=nearest(BigInt(p.weight*100*(first+last+1)),BigInt(2*values.length));
          assert.equal(p.cents,expected,`${label}: penalty tie/rounding arithmetic`);
          assert.ok(p.cents>=0&&p.cents<=p.weight*100,label);report.arithmeticChecks++;
        }
      }
      if(r.modeled_receptions<r.receptions)assert.ok(detail.flags.some(f=>f.code==='coverage-scoreYacoe'),`${label}: missing coverage flag`);
      if(peers.length<10)assert.ok(detail.flags.some(f=>f.code==='small-pool'),`${label}: missing peer flag`);
      if(r.synergyScore!==null) {
        const cents=detail.components.reduce((sum,c)=>sum+BigInt(c.cents),0n)-detail.penalties.reduce((sum,p)=>sum+BigInt(p.cents),0n);
        const expected=cents<=0n?0:Math.min(100,nearest(cents,100n));
        assert.equal(r.synergyScore,expected,`${label}: final rounding`);
        assert.ok(Number.isInteger(r.synergyScore)&&r.synergyScore>=0&&r.synergyScore<=100,label);
        report.scoreInstances++;stats.scored++;report.arithmeticChecks++;
      } else {
        assert.ok(detail.components.some(c=>c.points===null)||detail.penalties.some(p=>p.points===null),`${label}: unexplained unavailable score`);
        report.unavailable++;
      }
      if(context==='2026 REG season'&&['Brady Russell','Eli Raridon'].includes(r.receiverFullName)) {
        report.examples.push({context,name:`${r.qbFullName} -> ${r.receiverFullName}`,targets:r.targets,score:r.synergyScore,
          flags:detail.flags,components:detail.components.map(c=>({key:c.key,raw:c.rawValue,points:c.points,weight:c.weight}))});
      }
    }
  }
  assert.equal(rows.filter(r=>r.targets>=min).length,rows.filter(r=>r.scoreDetail).length,`${context}: unsupported position`);
  return rows;
}

function assertWindow(actual,weeks,label,teamRedZone) {
  const totals=new Map();
  const teamTotals={};
  for(const weekly of weeks)for(const [team,total] of Object.entries(weekly.teamRedZoneTargets))teamTotals[team]=(teamTotals[team]||0)+total;
  assert.deepEqual(teamRedZone,teamTotals,`${label}: team red-zone totals do not reconcile with weekly context`);
  report.teamRedZoneChecks+=Object.keys(teamTotals).length;
  for(const weekly of weeks)for(const r of weekly.pairs) {
    const entry=totals.get(S.id(r))||Object.fromEntries(countFields.map(key=>[key,0]));
    for(const key of countFields)entry[key]+=r[key];totals.set(S.id(r),entry);
  }
  assert.equal(actual.length,totals.size,`${label}: connection aggregation`);
  for(const r of actual)for(const key of countFields) {
    assert.equal(r[key],totals.get(S.id(r))?.[key],`${label}: ${S.id(r)} ${key} does not reconcile with weekly rows`);
    report.aggregationChecks++;
  }
}

const manifest=read('data/manifest.json');
for(const season of manifest.seasons)for(const scope of ['REG','POST','ALL']) {
  const d=read(`data/${season}/${scope}.json`);report.files++;
  assert.equal(d.methodVersion,S.methodVersion,`${season} ${scope}: rebuild required`);
  assert.deepEqual(d.thresholds,{score:1,qualified:scope==='POST'?5:30,weekly:1});
  const rows=inspect(d.pairs,d.thresholds,`${season} ${scope} season`,false,d.teamRedZoneTargets);
  inspect(d.recent,d.thresholds,`${season} ${scope} recent`,false,d.recentTeamRedZoneTargets);
  for(const w of d.weekly)inspect(w.pairs,d.thresholds,`${season} ${scope} week ${w.week}`,true,w.teamRedZoneTargets);
  assertWindow(d.pairs,d.weekly,`${season} ${scope} season`,d.teamRedZoneTargets);
  assertWindow(d.recent,d.weekly.filter(w=>w.week>=d.latestIncludedWeek-3),`${season} ${scope} recent`,d.recentTeamRedZoneTargets);
  for(const week of d.snapshotWeeks) {
    const s=read(`data/${season}/snapshots/${scope}-${week}.json`);report.files++;
    assert.equal(s.methodVersion,S.methodVersion);assert.equal(s.throughWeek,week);
    inspect(s.pairs,s.thresholds,`${season} ${scope} snapshot ${week}`,false,s.teamRedZoneTargets);
    inspect(s.recent,s.thresholds,`${season} ${scope} snapshot ${week} recent`,false,s.recentTeamRedZoneTargets);
    assertWindow(s.pairs,d.weekly.filter(w=>w.week<=week),`${season} ${scope} snapshot ${week}`,s.teamRedZoneTargets);
    assertWindow(s.recent,d.weekly.filter(w=>w.week<=week&&w.week>=week-3),`${season} ${scope} snapshot ${week} recent`,s.recentTeamRedZoneTargets);
  }
  report.scopes.push({season,scope,connections:d.pairs.length,scored:rows.filter(r=>r.synergyScore!==null).length,
    games:d.gameIds.length,completedWeek:d.latestCompletedWeek,excludedConversions:d.excludedTwoPointTargets});
}
if(process.argv.includes('--output')) {
  const output=path.resolve(process.argv[process.argv.indexOf('--output')+1]);
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2));
}
if(process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`\n### Score audit ${S.methodVersion} passed\n\n${report.files} datasets/snapshots, ${report.views} views, ${report.scoreInstances} score instances.\n\n${report.zeroEventChecks} zero-event checks, ${report.arithmeticChecks} arithmetic checks, ${report.aggregationChecks} cross-window aggregation checks, and ${report.teamRedZoneChecks} team red-zone checks passed. WR, TE, RB, and FB checked.\n\n`);
}
console.log(JSON.stringify({methodVersion:report.methodVersion,files:report.files,views:report.views,scoreInstances:report.scoreInstances,
  unavailable:report.unavailable,zeroEventChecks:report.zeroEventChecks,noOpportunityChecks:report.noOpportunityChecks,
  arithmeticChecks:report.arithmeticChecks,aggregationChecks:report.aggregationChecks,teamRedZoneChecks:report.teamRedZoneChecks,scopes:report.scopes},null,2));

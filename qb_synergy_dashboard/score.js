/* Shared by the explorer, rankings, weekly history, snapshots, and publication audit. */
(function (root) {
  'use strict';
  const methodVersion = '2026.4';
  const components = [
    ['Outcome', 'EPA / target', 'scoreEpa', 23], ['Outcome', 'Success rate', 'scoreSuccess', 16],
    ['Outcome', 'CPOE', 'scoreCpoe', 6], ['Outcome', 'First-down rate', 'scoreFirstDown', 8],
    ['Outcome', 'YAC over expected / rec', 'scoreYacoe', 7], ['Trust', 'Target share', 'target_share', 14],
    ['Trust', '3rd/4th target share', 'money_down_target_share', 7],
    ['Trust', 'Team red-zone target share', 'red_zone_target_share', 4],
    ['Duo lift', 'QB EPA lift', 'scoreQbLift', 12], ['Duo lift', 'Explosive rate', 'scoreExplosive', 3]
  ];
  const inputs = {
    scoreEpa: ['epa_per_target', 'targets'], scoreSuccess: ['success_rate', 'success_targets'],
    scoreCpoe: ['cpoe', 'cpoe_targets'], scoreFirstDown: ['firstDownRate', 'targets'],
    scoreYacoe: ['yac_over_expected_per_reception', 'modeled_receptions'],
    scoreQbLift: ['qb_epa_lift', 'targets'], scoreExplosive: ['explosiveRate', 'targets']
  };
  const zeroEvents = {
    scoreSuccess: ['successful_targets', 'No successful targets'],
    scoreFirstDown: ['first_downs', 'No receiving first downs'],
    scoreExplosive: ['explosives', 'No plays gaining 20+ receiving yards'],
    target_share: ['targets', 'No targets'],
    money_down_target_share: ['money_down_targets', 'No 3rd/4th-down targets'],
    red_zone_target_share: ['red_zone_targets', 'No red-zone targets']
  };
  const opportunities = {money_down_target_share:'qb_money_down_targets', red_zone_target_share:'team_red_zone_targets'};
  const number = v => (typeof v === 'number' || typeof v === 'string' && v.trim() !== '') && Number.isFinite(Number(v)) ? Number(v) : null;
  const group = row => ['RB','FB'].includes(row.position) ? 'RB' : ['WR','TE'].includes(row.position) ? 'WR_TE' : null;
  const id = row => `${row.qbId}:${row.receiverId}:${row.team}`;
  const divide = (a, b) => number(a) !== null && number(b) > 0 ? a / b : null;
  // Integer ratios give an explicit half-up rule without binary half-point drift.
  const roundRatio = (numerator, denominator) => Math.floor((2 * numerator + denominator) / (2 * denominator));
  const totalScore = cents => Math.max(0, Math.min(100, roundRatio(cents, 100)));
  function color(value) {
    if (number(value) === null) return 'rgb(162 172 174)';
    const t = Math.max(0, Math.min(1, value / 100));
    const start = [155, 93, 229], end = [170, 245, 106];
    return `rgb(${start.map((v, i) => Math.round(v + (end[i] - v) * t)).join(' ')})`;
  }
  function distribution(sample, value) {
    const values = sample.map(number).filter(v => v !== null), n = values.length, v = number(value);
    if (v === null || !n) return null;
    const below = values.filter(n => n < v).length, tied = values.filter(n => n === v).length;
    return {numerator: 100 * (2 * below + tied), denominator: 2 * n, peers:n, tied};
  }
  function percentile(sample, value) {
    const rank = distribution(sample, value);
    return rank ? rank.numerator / rank.denominator : null;
  }
  function indexRanks(sample) {
    const counts = new Map();
    for (const value of sample) counts.set(value,(counts.get(value)||0)+1);
    const ranks = new Map(); let below = 0;
    for (const value of [...counts.keys()].sort((a,b)=>a-b)) {
      const tied = counts.get(value);
      ranks.set(value,{numerator:100*(2*below+tied),denominator:2*sample.length,peers:sample.length,tied});
      below += tied;
    }
    return ranks;
  }
  function observations(row, key) {
    if (key === 'scoreQbLift' && Object.hasOwn(row,'qb_targets')) {
      const own=number(row.targets),other=number(row.qb_targets)===null?null:row.qb_targets-own;
      return own>0&&other>0?Math.min(own,other):0;
    }
    const count = inputs[key]?.[1] || opportunities[key] || 'targets';
    // Coverage is mandatory in published v3 data. Legacy callers can still pass raw fixtures.
    if (Object.hasOwn(row, count)) return number(row[count]);
    return key === 'scoreYacoe' ? number(row.receptions) : number(row.targets);
  }
  function apply(data, options = {}) {
    const weekly = options.weekly || false;
    const min = weekly ? data.thresholds?.weekly ?? 1 : data.thresholds?.score ?? 1;
    const k = weekly ? 8 : 40;
    const rows = data.pairs;
    for (const row of rows) {
      row.synergyScore = null; row.scoreDetail = null;
      row.firstDownRate = divide(row.first_downs, row.targets);
      row.explosiveRate = divide(row.explosives, row.targets);
      // Recompute count-based rates without treating 0/0 as an observed zero.
      for (const [key, numerator, denominator] of [
        ['target_share','targets','qb_targets'], ['money_down_rate','money_down_targets','targets'],
        ['money_down_target_share','money_down_targets','qb_money_down_targets'],
        ['red_zone_target_share','red_zone_targets','team_red_zone_targets'],
        ['money_down_failure_rate','money_down_failures','money_down_targets'],
        ['interception_rate','interceptions','targets'], ['success_rate','successful_targets','success_targets']
      ]) if (Object.hasOwn(row,numerator) && Object.hasOwn(row,denominator)) row[key] = divide(row[numerator],row[denominator]);
      for (const key of Object.keys(inputs)) row[key] = null;
    }
    for (const g of ['WR_TE', 'RB']) {
      const peers = rows.filter(row => group(row) === g && number(row.targets) > 0).sort((a,b)=>id(a).localeCompare(id(b)));
      const eligible = peers.filter(row => row.targets >= min);
      for (const [target, [source]] of Object.entries(inputs)) {
        const available = eligible.filter(r => observations(r,target) > 0 && number(r[source]) !== null);
        const anchor=available.length?number(available[0][source]):null;
        const baseline = available.length ? anchor + available.reduce((sum,r)=>sum + (number(r[source])-anchor),0) / available.length : null;
        for (const row of peers) {
          const n = observations(row,target), blend = n / (n + k);
          row[target] = number(row[source]) === null || !(n > 0) || baseline === null ? null
            : Number((baseline + blend * (number(row[source])-baseline)).toFixed(12));
        }
      }
      const samples = Object.fromEntries([...components.map(c=>c[2]),'interception_rate','money_down_failure_rate']
        .map(key=>[key,eligible.map(row=>number(row[key])).filter(v=>v!==null)]));
      const ranks = Object.fromEntries(Object.entries(samples).map(([key,values])=>[key,indexRanks(values)]));
      const rankFor = (key,value) => number(value) === null ? null : ranks[key].get(number(value)) || distribution(samples[key],value);
      for (const row of peers) {
        const detail = components.map(([section,label,key,weight]) => {
          const rawKey = inputs[key]?.[0] || key;
          const rawValue = number(row[rawKey]), n = observations(row,key);
          const rank = rankFor(key,row[key]);
          const result = {key,group:section,label,weight,rawValue,value:number(row[key]),observations:n,
            percentile:rank ? rank.numerator / rank.denominator : null,peers:samples[key].length,points:null,cents:null};
          let reason = null;
          if (key === 'scoreYacoe' && (number(row.receptions) === 0 || rawValue === null || !(n > 0))) {
            result.modelUnavailable = number(row.receptions) !== 0;
            reason = result.modelUnavailable ? 'YAC model unavailable' : 'No receptions';
          } else if (opportunities[key] && number(row[opportunities[key]]) === 0) {
            result.noOpportunities = true; reason = key === 'red_zone_target_share' ? 'No team red-zone targets' : 'No QB opportunities in this area';
          } else if (zeroEvents[key] && rawValue !== null && (number(row[zeroEvents[key][0]]) === 0 || rawValue === 0)) {
            result.zeroEvent = true; reason = zeroEvents[key][1];
          }
          if (reason) {
            result.cents = 0; result.note = `${reason}: 0 of ${weight} points.`;
          } else if (rank) {
            result.cents = weight * roundRatio(rank.numerator,rank.denominator);
          }
          result.points = result.cents === null ? null : result.cents / 100;
          return result;
        });
        const penalties = [['interception_rate',3],['money_down_failure_rate',2]].map(([key,weight]) => {
          const noOpportunities = key === 'money_down_failure_rate' && number(row.money_down_targets) === 0;
          const value = number(row[key]), rank = rankFor(key,value);
          // A measured zero (or no attempts to fail) is never a penalty. Positive ties are neutral ranks.
          const cents = noOpportunities || value === 0 ? 0 : rank ? roundRatio(weight * rank.numerator,rank.denominator) : null;
          return {key,weight,value,peers:samples[key].length,noOpportunities,
            percentile:rank ? rank.numerator / rank.denominator : null,cents,points:cents===null?null:cents/100};
        });
        const valid = row.targets >= min && eligible.length > 0 && detail.every(c=>c.cents!==null) && penalties.every(p=>p.cents!==null);
        const componentCents = detail.every(c=>c.cents!==null) ? detail.reduce((sum,c)=>sum+c.cents,0) : null;
        const penaltyCents = penalties.every(p=>p.cents!==null) ? penalties.reduce((sum,p)=>sum+p.cents,0) : null;
        row.synergyScore = valid ? totalScore(componentCents - penaltyCents) : null;
        const flags = [];
        if (eligible.length < 10) flags.push({code:'small-pool',label:'Small comparison pool',note:`${eligible.length} eligible ${g==='RB'?'RB/FB':'WR/TE'} connections; percentile ranks can move sharply.`});
        const otherTargets=number(row.qb_targets)===null?null:row.qb_targets-row.targets;
        if(otherTargets!==null&&otherTargets<5)flags.push({code:'small-qb-reference',label:'Limited QB comparison',
          note:`QB EPA lift has ${otherTargets} other-receiver targets on this team; its stabilization uses the smaller of the two target counts.`});
        const coverage = [
          ['scoreYacoe','modeled_receptions','receptions','YAC'], ['scoreCpoe','cpoe_targets','targets','CPOE'],
          ['scoreSuccess','success_targets','targets','Success']
        ];
        for (const [key,count,total,label] of coverage) {
          if (number(row[total]) > 0 && number(row[count]) !== null && row[count] < row[total]) {
            flags.push({code:`coverage-${key}`,label:row[count]===0?`${label} model unavailable`:`Partial ${label} coverage`,
              note:`${label} covers ${row[count]} of ${row[total]} ${total==='receptions'?'receptions':'targets'}; stabilization uses ${row[count]} observations.`});
          }
        }
        row.scoreDetail = {methodVersion,total:row.synergyScore,components:detail,penalties,componentCents,penaltyCents,
          turnoverPenalty:penalties[0].points,moneyPenalty:penalties[1].points,
          penalty:penaltyCents===null?null:penaltyCents/100,minimum:min,peers:eligible.length,weekly,stabilization:k,flags};
      }
    }
    return data;
  }
  function calculate(data, row, withDetail = false, options = {}) {
    apply(data,options);
    return withDetail ? row.scoreDetail : row.synergyScore;
  }
  function ranked(rows, {position = 'ALL', minimum = 30} = {}) {
    return rows.filter(r => (position === 'ALL' || (position==='RB'?group(r)==='RB':r.position===position)) && r.targets >= minimum && number(r.synergyScore) !== null)
      .sort((a,b)=>b.synergyScore-a.synergyScore || b.targets-a.targets || id(a).localeCompare(id(b)));
  }
  function rankChanges(current, previous, options) {
    const before = new Map(ranked(previous, options).map((r,i)=>[id(r),i+1]));
    return new Map(ranked(current, options).map((r,i)=>[id(r),before.has(id(r))?before.get(id(r))-(i+1):'New']));
  }
  root.QBSynergyScore = {methodVersion,apply,calculate,ranked,rankChanges,number,group,id,percentile,components,color,totalScore};
  if (typeof module !== 'undefined') module.exports = root.QBSynergyScore;
})(globalThis);

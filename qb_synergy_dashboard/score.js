/* Shared by every view and Node verification. Missing inputs never become zero. */
(function (root) {
  'use strict';
  const components = [
    ['Outcome', 'EPA / target', 'scoreEpa', 23], ['Outcome', 'Success rate', 'scoreSuccess', 16],
    ['Outcome', 'CPOE', 'scoreCpoe', 6], ['Outcome', 'First-down rate', 'scoreFirstDown', 8],
    ['Outcome', 'YAC over expected / rec', 'scoreYacoe', 7], ['Trust', 'Target share', 'target_share', 14],
    ['Trust', '3rd/4th target share', 'money_down_target_share', 7],
    ['Trust', 'Red-zone target share', 'red_zone_target_share', 4],
    ['Duo lift', 'QB EPA lift', 'scoreQbLift', 12], ['Duo lift', 'Explosive rate', 'scoreExplosive', 3]
  ];
  const raw = [['epa_per_target', 'scoreEpa'], ['success_rate', 'scoreSuccess'], ['cpoe', 'scoreCpoe'],
    ['firstDownRate', 'scoreFirstDown'], ['yac_over_expected_per_reception', 'scoreYacoe'],
    ['qb_epa_lift', 'scoreQbLift'], ['explosiveRate', 'scoreExplosive']];
  const number = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
  const group = row => row.position === 'RB' ? 'RB' : 'WR_TE';
  function color(value) {
    if (number(value) === null) return 'rgb(162 172 174)';
    const t = Math.max(0, Math.min(1, value / 100));
    const start = [155, 93, 229], end = [170, 245, 106];
    return `rgb(${start.map((v, i) => Math.round(v + (end[i] - v) * t)).join(' ')})`;
  }
  const id = row => `${row.qbId}:${row.receiverId}:${row.team}`;
  const divide = (a, b) => number(a) !== null && number(b) > 0 ? a / b : null;
  const percentile = (sample, value, strict = false) => {
    if (number(value) === null || !sample.length) return null;
    return 100 * sample.filter(n => strict ? n < value : n <= value).length / sample.length;
  };
  function apply(data, options = {}) {
    const weekly = options.weekly || false;
    const min = weekly ? data.thresholds?.weekly ?? 1 : data.thresholds?.score ?? 15;
    const k = weekly ? 8 : 40;
    const rows = data.pairs;
    for (const row of rows) {
      row.firstDownRate = divide(row.first_downs, row.targets);
      row.explosiveRate = divide(row.explosives, row.targets);
      // No opportunities is a real zero for usage/penalties, not missing model data.
      if (row.qb_money_down_targets === 0) row.money_down_target_share = 0;
      if (row.qb_red_zone_targets === 0) row.red_zone_target_share = 0;
      if (row.money_down_targets === 0) row.money_down_failure_rate = 0;
    }
    for (const g of ['WR_TE', 'RB']) {
      const peers = rows.filter(row => group(row) === g && row.targets > 0);
      for (const [source, target] of raw) {
        const available = peers.map(r => number(r[source])).filter(v => v !== null);
        const baseline = available.length ? available.reduce((a, b) => a + b, 0) / available.length : null;
        for (const row of peers) {
          const blend = row.targets / (row.targets + k);
          row[target] = number(row[source]) === null || baseline === null ? null : blend * row[source] + (1 - blend) * baseline;
        }
      }
      const eligible = peers.filter(row => row.targets >= min);
      const samples = Object.fromEntries([...components.map(c => c[2]), 'interception_rate', 'money_down_failure_rate']
        .map(key => [key, eligible.map(row => number(row[key])).filter(v => v !== null)]));
      for (const row of peers) {
        const detail = components.map(([section, label, key, weight]) => {
          const pct = percentile(samples[key], row[key]);
          return {group: section, label, weight, points: pct === null ? null : weight * Math.round(pct) / 100};
        });
        const turnover = percentile(samples.interception_rate, row.interception_rate, true);
        const failedDown = percentile(samples.money_down_failure_rate, row.money_down_failure_rate, true);
        const valid = row.targets >= min && eligible.length && detail.every(d => d.points !== null)
          && turnover !== null && failedDown !== null;
        const turnoverPenalty = turnover === null ? null : 3 * turnover / 100;
        const moneyPenalty = failedDown === null ? null : 2 * failedDown / 100;
        row.synergyScore = valid ? Math.max(0, Math.round(detail.reduce((sum, d) => sum + d.points, 0) - turnoverPenalty - moneyPenalty)) : null;
        row.scoreDetail = {total: row.synergyScore, components: detail, turnoverPenalty, moneyPenalty,
          penalty: valid ? turnoverPenalty + moneyPenalty : null, minimum: min, peers: eligible.length};
      }
    }
    return data;
  }
  function calculate(data, row, withDetail = false) {
    if (!row.scoreDetail) apply(data);
    return withDetail ? row.scoreDetail : row.synergyScore;
  }
  function ranked(rows, {position = 'ALL', minimum = 30} = {}) {
    return rows.filter(r => (position === 'ALL' || r.position === position) && r.targets >= minimum && number(r.synergyScore) !== null)
      .sort((a, b) => b.synergyScore - a.synergyScore || b.targets - a.targets || id(a).localeCompare(id(b)));
  }
  function rankChanges(current, previous, options) {
    const before = new Map(ranked(previous, options).map((r, i) => [id(r), i + 1]));
    return new Map(ranked(current, options).map((r, i) => [id(r), before.has(id(r)) ? before.get(id(r)) - (i + 1) : 'New']));
  }
  root.QBSynergyScore = {apply, calculate, ranked, rankChanges, number, group, id, percentile, components, color};
  if (typeof module !== 'undefined') module.exports = root.QBSynergyScore;
})(globalThis);

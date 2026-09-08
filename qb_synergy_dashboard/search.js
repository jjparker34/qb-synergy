/* Match team aliases as complete phrases before searching player-name fragments. */
(function (root) {
  'use strict';
  const normalize = text => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  const extra = {
    LA: ['LAR', 'LA Rams'], LAC: ['LA Chargers', 'Bolts'], JAX: ['JAC', 'Jags'],
    WAS: ['WSH'], SF: ['Niners', 'Forty Niners'], TB: ['Bucs'], NE: ['Pats'],
    GB: ['Pack'], NYG: ['NY', 'NY Giants'], NYJ: ['NY', 'NY Jets']
  };
  function find(rows, term, teams, limit = 7) {
    const query = normalize(term);
    if (!query) return [];
    const aliases = new Map();
    for (const [code, [name, alternate]] of Object.entries(teams)) {
      const parts = name.split(' ');
      for (const text of [code, alternate, name, parts.at(-1), parts.slice(0,-1).join(' '), ...(extra[code] || [])]) {
        const alias = normalize(text);
        if (!aliases.has(alias)) aliases.set(alias, new Set());
        aliases.get(alias).add(code);
      }
    }
    const phrase = aliases.has(query) ? query : [...aliases.keys()].sort((a,b) => b.length-a.length)
      .find(alias => ` ${query} `.includes(` ${alias} `));
    const teamCodes = phrase ? aliases.get(phrase) : null;
    const remaining = phrase ? ` ${query} `.replace(` ${phrase} `, ' ').trim() : query;
    const words = remaining.split(' ').filter(Boolean);
    return rows.filter(row => {
      if (teamCodes && !teamCodes.has(row.team)) return false;
      const text = normalize(`${row.qbFullName || row.qb} ${row.receiverFullName || row.receiver} ${row.qb} ${row.receiver} ${teams[row.team]?.[0] || row.team} ${row.team} ${row.position}`);
      return words.every(word => text.includes(word));
    }).sort((a,b) => b.targets-a.targets || String(a.receiverId).localeCompare(String(b.receiverId))).slice(0,limit);
  }
  root.QBSynergySearch = {find, normalize};
  if (typeof module !== 'undefined') module.exports = root.QBSynergySearch;
})(globalThis);

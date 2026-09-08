const {test}=require('node:test');
const assert=require('node:assert/strict');
const search=require('../qb_synergy_dashboard/search.js');
global.window=globalThis;
require('../qb_synergy_dashboard/teams.js');
const rows=require('../qb_synergy_dashboard/data/2025/REG.json').pairs;
test('team abbreviations exclude substring collisions in player names',()=>{
  for(const code of Object.keys(QBTeams)){
    const hits=search.find(rows,code,QBTeams);
    assert.ok(hits.length,code);
    assert.ok(hits.every(row=>row.team===code),code);
  }
});
test('full names, cities, nicknames, alternate abbreviations and common aliases',()=>{
  for(const [term,team] of [['Chiefs','KC'],['Green Bay Packers','GB'],['New England','NE'],
    ['LAR','LA'],['LA Rams','LA'],['JAC','JAX'],['WSH','WAS'],['Niners','SF'],['Bucs','TB'],['Pats','NE']]){
    const hits=search.find(rows,term,QBTeams);
    assert.ok(hits.length,term);assert.ok(hits.every(row=>row.team===team),term);
  }
  assert.ok(search.find(rows,'New York',QBTeams,1000).every(r=>['NYJ','NYG'].includes(r.team)));
});
test('mixed team and player queries keep both constraints',()=>{
  const hits=search.find(rows,'  gB   Doubs ',QBTeams);
  assert.ok(hits.length);assert.ok(hits.every(r=>r.team==='GB'&&r.receiverFullName.includes('Doubs')));
  assert.equal(search.find(rows,'Patriots Nacua',QBTeams).length,0);
});
test('player search and empty states remain usable',()=>{
  assert.ok(search.find(rows,'Travis Hunter',QBTeams).some(r=>r.receiverFullName==='Travis Hunter'));
  assert.equal(search.find(rows,'',QBTeams).length,0);
  assert.equal(search.find([],'Chiefs',QBTeams).length,0);
  assert.equal(search.find(rows,'not-a-real-team',QBTeams).length,0);
});

/* The two pages share data loading, scoring, filtering, and link semantics. */
(() => {
  'use strict';
  const S = window.QBSynergyScore, TEAM = window.QBTeams;
  const $ = selector => document.querySelector(selector);
  const page = document.body.dataset.page;
  const query = new URLSearchParams(location.search);
  const scopeLabels = {REG: 'Regular season', POST: 'Playoffs', ALL: 'Combined'};
  let season, scope = scopeLabels[query.get('scope')] ? query.get('scope') : 'REG';
  let timeWindow = query.get('window') === 'last4' ? 'last4' : 'season';
  let data, view, selected, manifest, snapshotPair = [], snapshotError = false;
  let rankState = {position: 'ALL', qualification: 'qualified', minimum: 0, rows: '25', metrics: 'core', sort: 'synergyScore', direction: -1};
  let treeState = {position: 'ALL', limit: 'ALL'};
  let scoreAnimation;
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (v, digits = 0) => S.number(v) === null ? '—' : Number(v).toLocaleString('en-US', {minimumFractionDigits: digits, maximumFractionDigits: digits});
  const pct = v => S.number(v) === null ? '—' : `${fmt(v * 100, 1)}%`;
  const dec = v => S.number(v) === null ? '—' : `${v > 0 ? '+' : ''}${fmt(v, 2)}`;
  const teamName = r => TEAM[r.team]?.[0] || r.team;
  const full = (r, role) => r[`${role}FullName`] || r[role];
  const pairName = r => `${full(r, 'qb')} → ${full(r, 'receiver')}`;
  const windowLabel = () => timeWindow === 'last4' && data.latestIncludedWeek ? `Weeks ${data.recentStartWeek}–${data.latestIncludedWeek}` : 'Season to date';
  const photo = (r, role, className = '') => `<img class="${className}" src="${esc(r[`${role}Photo`] || 'player-placeholder.svg')}" alt="${esc(full(r, role))}" loading="lazy">`;
  const status = r => r.targets < data.thresholds.score ? `Raw stats · ${data.thresholds.score} targets to score`
    : S.number(r.synergyScore) === null ? 'Score unavailable · missing inputs'
    : r.targets < data.thresholds.qualified ? 'Provisional' : 'Qualified';
  function url(name, row, changes = {}) {
    const params = new URLSearchParams({season: String(season), scope, window: timeWindow});
    if (row) {params.set('qb', row.qbId); params.set('receiver', row.receiverId); params.set('team', row.team);}
    for (const [key, value] of Object.entries(changes)) params.set(key, value);
    return `${name}?${params}`;
  }
  async function json(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Data request failed (${response.status})`);
    return response.json();
  }
  function scoreView(source) {
    return S.apply({thresholds: data.thresholds, pairs: structuredClone(timeWindow === 'last4' ? source.recent : source.pairs)});
  }
  function choose(row) {
    if (page === 'rankings') {location.href = url('index.html', row); return;}
    selected = row;
    history.replaceState({}, '', url('index.html', row));
    renderExplorer();
  }
  function renderSearch() {
    const term = $('#pairSearch').value.trim();
    if (!term) {$('#searchResults').innerHTML='';return;}
    if (!view) {$('#searchResults').innerHTML='<p class="search-hit">Loading season data…</p>';return;}
    const hits = window.QBSynergySearch.find(view.pairs, term, TEAM);
    const archive = manifest.seasons.find(s=>s!==season);
    const emptyMessage = !view.pairs.length ? `<p class="search-hit">No ${season} ${esc(scopeLabels[scope].toLowerCase())} connections are available in this view.${archive?`<br><a href="${url(page==='explorer'?'index.html':'top-connections.html',null,{season:archive,scope:'REG',window:'season',search:term})}">Search the ${archive} archive →</a>`:''}</p>`
      : `<p class="search-hit">No matching players or teams in ${season} · ${esc(scopeLabels[scope])} · ${esc(windowLabel())}.</p>`;
    $('#searchResults').innerHTML = hits.map((r,i) => `<button class="search-hit" data-hit="${i}">${esc(pairName(r))}<small>${esc(teamName(r))} (${esc(r.team)}) · ${r.position} · ${fmt(r.targets)} targets</small></button>`).join('') || emptyMessage;
    $('#searchResults').querySelectorAll('button').forEach(b => b.onclick = () => {
      $('#pairSearch').value = ''; $('#searchResults').innerHTML = ''; choose(hits[Number(b.dataset.hit)]);
    });
  }
  document.addEventListener('error', event => {
    if (event.target.tagName === 'IMG' && !event.target.src.endsWith('/player-placeholder.svg')) event.target.src = 'player-placeholder.svg';
  }, true);
  function formatDate(date) {
    return date ? new Date(date).toLocaleString('en-US', {month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}) : 'Unavailable';
  }
  function renderContext() {
    document.title = `${page === 'explorer' ? 'Duo Explorer' : 'Top Connections'} · ${season} — QB Synergy`;
    const coverage = data.latestIncludedWeek ? `Through Week ${data.latestIncludedWeek}${data.latestIncludedWeek !== data.latestCompletedWeek ? ' (partial)' : ''}` : 'Awaiting season data';
    $('#coverage').textContent = `${season} · ${scopeLabels[scope]} · ${windowLabel()} · ${coverage}`;
    $('#freshness').innerHTML = `<a href="${url('methodology.html')}">Methodology</a><a href="https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html" target="_blank" rel="noreferrer">nflverse data</a><br>Data built ${esc(formatDate(data.generatedAt))}<br>Source checked ${esc(formatDate(data.sourceCheckedAt))} · Completed through ${data.latestCompletedWeek ? `Week ${data.latestCompletedWeek}` : 'no completed weeks'} · Method ${esc(data.methodVersion)}`;
    $('#methodLink').href = url('methodology.html');
    document.querySelectorAll('[data-nav]').forEach(a => {
      a.href = url(a.dataset.nav === 'explorer' ? 'index.html' : 'top-connections.html', selected);
      if (a.dataset.nav === page) a.setAttribute('aria-current', 'page');
    });
    $('#season').innerHTML = manifest.seasons.map(s => `<option ${s === season ? 'selected' : ''}>${s}</option>`).join('');
    $('#scope').value = scope; $('#window').value = timeWindow;
    for (const key of ['season', 'scope', 'window']) $(`#${key}`).onchange = e => {
      location.href = url(page === 'explorer' ? 'index.html' : 'top-connections.html', selected, {[key]: e.target.value});
    };
    $('#viewControls').open = matchMedia('(min-width:761px)').matches;
    $('#targetPicker').open = matchMedia('(min-width:761px)').matches;
    $('#targetPicker').hidden = page !== 'explorer' || !selected;
  }
  function empty() {
    $('#targetPicker').hidden = true;
    const available = manifest.seasons.filter(s => s !== season);
    $('#content').innerHTML = `<section class="empty"><h2>${scope === 'POST' ? 'No playoff connections yet' : `No ${season} connections yet`}</h2><p>${scope === 'POST' ? 'Playoff results will appear after postseason games are available.' : 'The dashboard will populate after nflverse publishes receiver-tagged pass attempts.'}</p><p>Automatic source checks run Tuesday and Thursday.</p>${available.map(s => `<a href="${url(page === 'explorer' ? 'index.html' : 'top-connections.html', null, {season:s,scope:'REG'})}">Explore the ${s} season →</a>`).join('<br>')}</section>`;
  }
  function scoreDetail(row) {
    const detail = row.scoreDetail;
    const sections = ['Outcome', 'Trust', 'Duo lift'];
    return `<details class="score-explanation"><summary>How this score is calculated</summary><div class="score-detail-grid">${sections.map(section => `<section><h3>${section}</h3>${detail.components.filter(c=>c.group===section).map(c=>`<p><span>${esc(c.label)}</span><b>${fmt(c.points,1)} / ${c.weight}</b></p>`).join('')}</section>`).join('')}</div><p>Negative-play penalty: ${fmt(detail.penalty,1)} / 5. ${detail.peers} eligible ${S.group(row)==='RB'?'RB':'WR/TE'} peers; ${detail.minimum}+ targets. Efficiency is stabilized toward the peer baseline. Missing model inputs suppress the composite rather than counting as zero. A score is a connection measure, not a player grade.</p></details>`;
  }
  function scoreRing(row) {
    return `<button class="score-ring" id="scoreRing" style="--score-color:${S.color(row.synergyScore)};--score-progress:${row.synergyScore??0}%" aria-label="Synergy Score ${fmt(row.synergyScore)} out of 100. Show calculation" aria-controls="scoreExplanation" aria-expanded="false"><span class="score-ring-inner" aria-hidden="true"><span class="score-number" id="scoreValue">${fmt(row.synergyScore)}</span><span class="score-caption">/ 100</span></span></button>`;
  }
  function animateScore(value) {
    cancelAnimationFrame(scoreAnimation);
    const ring=$('#scoreRing'),label=$('#scoreValue'),details=$('.score-explanation');
    details.id='scoreExplanation';
    ring.onclick=()=>{details.open=!details.open;};
    details.addEventListener('toggle',()=>ring.setAttribute('aria-expanded',String(details.open)));
    if(S.number(value)===null||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    ring.classList.add('is-loading');
    label.textContent='0';ring.style.setProperty('--score-progress','0%');
    const started=performance.now(),duration=1250;
    const step=now=>{
      if(!ring.isConnected)return;
      const progress=Math.min(1,(now-started)/duration),ease=1-Math.pow(1-progress,3);
      label.textContent=Math.round(value*ease);
      ring.style.setProperty('--score-progress',`${value*ease}%`);
      if(progress<1)scoreAnimation=requestAnimationFrame(step);
      else ring.classList.remove('is-loading');
    };
    scoreAnimation=requestAnimationFrame(step);
  }
  function drawHistory(row) {
    const weeks = data.weekly || [];
    if (!weeks.length) return '';
    const points = weeks.map(w => ({week:w.week, row:w.pairs.find(r=>S.id(r)===S.id(row))}));
    const first = data.firstWeek, last = data.latestIncludedWeek, W=640, H=145, L=28, R=15, T=12, B=24;
    const x = week => L + (week-first)/Math.max(1,last-first)*(W-L-R), y = score => T+(100-score)/100*(H-T-B);
    let path = '', previous = null;
    for (const p of points) {
      if (!p.row || S.number(p.row.synergyScore) === null) {previous=null;continue;}
      path += `${previous === p.week-1 ? 'L':'M'}${x(p.week)},${y(p.row.synergyScore)} `;previous=p.week;
    }
    return `<section class="trend"><div class="section-head"><h2>Weekly synergy</h2><p>Weekly results · ${data.thresholds.weekly}+ targets<br>Gaps indicate a bye, low sample, or missing inputs</p></div><svg class="history" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly Synergy Score, using peers from each individual week">${[0,50,100].map(n=>`<line x1="${L}" x2="${W-R}" y1="${y(n)}" y2="${y(n)}"/><text x="0" y="${y(n)+4}">${n}</text>`).join('')}<path d="${path}"/>${points.filter(p=>p.row && S.number(p.row.synergyScore)!==null).map(p=>`<circle tabindex="0" role="img" aria-label="Week ${p.week}: ${p.row.synergyScore} score, ${p.row.targets} targets" cx="${x(p.week)}" cy="${y(p.row.synergyScore)}" r="4" style="fill:${S.color(p.row.synergyScore)}"><title>Week ${p.week}: ${p.row.synergyScore} · ${p.row.targets} targets</title></circle>`).join('')}${Array.from({length:last-first+1},(_,i)=>first+i).filter(w=>w===first||w===last||(w-first)%2===0).map(w=>`<text x="${x(w)}" y="${H-4}" text-anchor="middle">${w}</text>`).join('')}</svg><p id="historyReadout" class="section-note">Select or focus a point for its week and target count.</p></section>`;
  }
  function renderExplorer() {
    const row = selected;
    if (!row) {empty(); return;}
    const stats = [['Targets',fmt(row.targets)],['Receptions',fmt(row.receptions)],['Yards',fmt(row.yards)],['Touchdowns',fmt(row.td)],['EPA / target',dec(row.epa_per_target)],['Passer rating',fmt(row.passer_rating,1)]];
    const metrics = [['EPA / target','epa_per_target',dec],['Success rate','success_rate',pct],['Target share','target_share',pct],['3rd/4th target rate','money_down_rate',pct],['Avg. target depth','air_yards',n=>`${fmt(n,1)} yd`],['YAC / reception','yac_per_reception',n=>`${fmt(n,1)} yd`],['YAC over expected / rec','yac_over_expected_per_reception',dec],['Explosive rate','explosiveRate',pct],['First-down rate','firstDownRate',pct],['CPOE','cpoe',n=>S.number(n)===null?'—':`${dec(n)} pp`]];
    const peerMinimum = view.pairs.some(r=>S.group(r)===S.group(row)&&r.targets>=data.thresholds.qualified) ? data.thresholds.qualified : data.thresholds.score;
    const peers = view.pairs.filter(r=>S.group(r)===S.group(row)&&r.targets>=peerMinimum);
    $('#content').innerHTML = `<section class="duo" aria-label="Selected connection"><div class="player">${photo(row,'qb','portrait')}<div><span class="position">Quarterback</span><h2>${esc(full(row,'qb'))}</h2><p>${esc(teamName(row))}</p></div></div><div class="score-block">${scoreRing(row)}<p class="score-label">Synergy Score</p><p class="score-status">${status(row)}<br>${fmt(row.targets)} targets · ${fmt(row.games)} games</p></div><div class="player receiver">${photo(row,'receiver','portrait')}<div><span class="position">${row.position}</span><h2>${esc(full(row,'receiver'))}</h2><p>${esc(windowLabel())}</p></div></div></section>${scoreDetail(row)}${drawHistory(row)}<section class="stats-row" aria-label="Connection statistics">${stats.map(([label,value])=>`<div class="stat"><b>${value}</b><span>${label}</span></div>`).join('')}</section><div class="detail-grid"><section><div class="section-head"><h2>Advanced profile</h2><button class="glossary-button">Stats glossary</button></div><p class="section-note">Percentiles among ${peerMinimum}+ target ${S.group(row)==='RB'?'RB':'WR/TE'} connections in this view. YAC over expectation covers ${fmt(row.modeled_receptions)} of ${fmt(row.receptions)} receptions.</p>${metrics.map(([label,key,format])=>{
      const sample=peers.map(r=>S.number(r[key])).filter(n=>n!==null),p=S.percentile(sample,row[key]);
      return `<div class="metric"><span>${label}</span><div class="track"><i style="width:${p??0}%;background:${S.color(p)}"></i></div><span class="metric-value">${S.number(row[key])===null?'—':format(row[key])}<small>${p===null?'Unavailable':`${Math.round(p)}th percentile`}</small></span></div>`;
    }).join('')}</section><section><div class="section-head"><h2>QB target tree</h2></div><div class="rank-filters"><label>Position<select id="treePosition">${['ALL','WR','TE','RB'].map(p=>`<option value="${p}" ${treeState.position===p?'selected':''}>${p==='ALL'?'All positions':p}</option>`).join('')}</select></label><label>Rows<select id="treeLimit">${['5','10','ALL'].map(p=>`<option value="${p}" ${treeState.limit===p?'selected':''}>${p==='ALL'?'All rows':p}</option>`).join('')}</select></label></div><div id="treeTable"></div></section></div>`;
    const pairs = view.pairs.filter(r=>r.qbId===row.qbId).sort((a,b)=>b.targets-a.targets);
    $('#targetCount').textContent = `(${pairs.length})`;
    $('#pairList').innerHTML = pairs.map((r,i)=>`<button class="pair ${S.id(row)===S.id(r)?'active':''}" data-pair="${i}" ${S.id(row)===S.id(r)?'aria-pressed="true"':'aria-pressed="false"'}>${photo(r,'receiver')}<span><span class="pair-name">${esc(full(r,'receiver'))}</span><small>${r.position} · ${r.team} · ${fmt(r.targets)} targets</small></span><b style="color:${S.color(r.synergyScore)}">${fmt(r.synergyScore)}</b></button>`).join('');
    $('#pairList').querySelectorAll('button').forEach(b=>b.onclick=()=>choose(pairs[Number(b.dataset.pair)]));
    $('#treePosition').onchange=e=>{treeState.position=e.target.value;renderTree(pairs);};
    $('#treeLimit').onchange=e=>{treeState.limit=e.target.value;renderTree(pairs);};
    renderTree(pairs); bindGlossary(); animateScore(row.synergyScore);
    document.querySelectorAll('.history circle').forEach(point=>{
      const read=()=>$('#historyReadout').textContent=point.getAttribute('aria-label');
      point.onfocus=read;point.onclick=read;point.onmouseenter=read;
    });
  }
  function renderTree(pairs) {
    let rows=pairs.filter(r=>treeState.position==='ALL'||r.position===treeState.position);
    if(treeState.limit!=='ALL') rows=rows.slice(0,Number(treeState.limit));
    $('#treeTable').innerHTML=`<div class="table-scroll" tabindex="0" aria-label="QB targets, scroll for more stats"><table class="data-table tree"><thead><tr><th class="identity">Target</th><th>Tgt</th><th>Rec</th><th>Yds</th><th>EPA</th></tr></thead><tbody>${rows.map((r,i)=>`<tr class="${S.id(r)===S.id(selected)?'selected':''}"><td class="identity"><button class="connection-button" data-tree="${i}"><span>${esc(full(r,'receiver'))}<small>${r.position} · ${r.team}</small></span></button></td><td>${fmt(r.targets)}</td><td>${fmt(r.receptions)}</td><td>${fmt(r.yards)}</td><td>${dec(r.epa)}</td></tr>`).join('')}</tbody></table>${rows.length?'':'<p class="empty">No targets match this filter.</p>'}</div>`;
    $('#treeTable').querySelectorAll('[data-tree]').forEach(b=>b.onclick=()=>choose(rows[Number(b.dataset.tree)]));
  }
  function qualificationMinimum() {
    return rankState.qualification==='raw'?1:Math.max(rankState.minimum, data.thresholds[rankState.qualification==='provisional'?'score':'qualified']);
  }
  function rankingRows(source) {
    return source.filter(r=>(rankState.position==='ALL'||r.position===rankState.position)&&r.targets>=qualificationMinimum());
  }
  function setupRankings() {
    $('#content').innerHTML = `<section id="feature" class="feature"></section><section aria-label="Connection rankings"><div class="section-head"><h2>Connection rankings</h2></div><details class="rank-controls" id="rankControls"><summary>Ranking filters</summary><div class="rank-control-body"><div class="rank-filters">
      <label>Position<select id="rankPosition"><option value="ALL">All positions</option><option>WR</option><option>TE</option><option>RB</option></select></label>
      <label>Qualification<select id="rankQualification"><option value="qualified">Qualified (${data.thresholds.qualified}+)</option><option value="provisional">Include provisional (${data.thresholds.score}+)</option><option value="raw">All connections (raw)</option></select></label>
      <label>Minimum targets<select id="rankMinimum"><option value="0">View minimum</option><option>50</option><option>75</option><option>100</option></select></label>
      <label>Rows<select id="rankRows"><option>10</option><option selected>25</option><option>50</option><option value="ALL">All rows</option></select></label>
      <label>Metrics<select id="rankMetrics"><option value="core">Core</option><option value="advanced">Advanced</option></select></label></div><button class="glossary-button">Stats glossary</button></div></details><p class="rank-summary" id="rankSummary"></p><div id="rankingTable"></div><p id="changesNote" class="changes-note"></p></section><div class="chart-grid"><details class="chart-panel" id="trustPanel"><summary>Trust × efficiency</summary><p>Target share and EPA per target. Dashed lines show this filtered group's averages.</p><div class="scatter" id="trustChart"></div><p class="chart-readout" id="trustReadout">Focus or select a point to identify a connection.</p><button id="trustOpen" hidden>Open selected connection</button></details><details class="chart-panel" id="skillPanel"><summary>QB × receiver skill</summary><p>CPOE and YAC over expected per reception. Bubble size represents targets; color represents Synergy Score.</p><div class="scatter" id="skillChart"></div><p class="chart-readout" id="skillReadout">Focus or select a point to identify a connection.</p><button id="skillOpen" hidden>Open selected connection</button></details></div>`;
    rankState.qualification=view.pairs.some(r=>r.targets>=data.thresholds.qualified)?'qualified':view.pairs.some(r=>r.targets>=data.thresholds.score)?'provisional':'raw';
    $('#rankQualification').value=rankState.qualification;
    for(const key of ['Position','Qualification','Minimum','Rows','Metrics']) $(`#rank${key}`).onchange=e=>{rankState[key.toLowerCase()]=key==='Minimum'?Number(e.target.value):e.target.value;renderRankings();};
    for(const id of ['trustPanel','skillPanel','rankControls']) $(`#${id}`).open=matchMedia('(min-width:761px)').matches;
    bindGlossary();renderRankings();
  }
  function renderRankings() {
    const filtered=rankingRows(view.pairs);
    const ranking=S.ranked(view.pairs,{position:rankState.position,minimum:qualificationMinimum()});
    const ranks=new Map(ranking.map((r,i)=>[S.id(r),i+1]));
    const sorted=[...filtered].sort((a,b)=>{
      const av=rankState.sort==='name'?pairName(a):S.number(a[rankState.sort]),bv=rankState.sort==='name'?pairName(b):S.number(b[rankState.sort]);
      if(av===null)return bv===null?0:1;if(bv===null)return -1;
      return (typeof av==='string'?av.localeCompare(bv):av-bv)*rankState.direction || b.targets-a.targets || S.id(a).localeCompare(S.id(b));
    });
    const rows=rankState.rows==='ALL'?sorted:sorted.slice(0,Number(rankState.rows));
    const leader=ranking[0];$('#feature').hidden=!leader;
    if(leader) $('#feature').innerHTML=`<div><p>${rankState.qualification==='provisional'?'Leading connection · provisional pool':'Leading connection'}</p><h2><a href="${url('index.html',leader)}">${esc(pairName(leader))}</a></h2><p>${esc(teamName(leader))} · ${leader.position} · ${fmt(leader.targets)} targets · <span class="feature-score" style="color:${S.color(leader.synergyScore)}">${leader.synergyScore} Synergy Score</span></p></div><div class="feature-photos">${photo(leader,'qb')}${photo(leader,'receiver')}</div>`;
    const extra=rankState.metrics==='advanced' ? [['EPA/T','epa_per_target',dec],['CPOE','cpoe',dec],['Success','success_rate',pct],['Catch','catch_rate',pct],['YACOE/rec','yac_over_expected_per_reception',dec],['3rd/4th','money_down_rate',pct]]
      : [['Targets','targets',fmt],['Share','target_share',pct],['EPA/T','epa_per_target',dec],['Yards','yards',fmt],['TD','td',fmt]];
    let changes=new Map();
    if(snapshotPair.length===2) changes=S.rankChanges(snapshotPair[1].view.pairs,snapshotPair[0].view.pairs,{position:rankState.position,minimum:qualificationMinimum()});
    const header=(label,key,cls='')=>`<th class="${cls}" scope="col" aria-sort="${rankState.sort===key?(rankState.direction<0?'descending':'ascending'):'none'}"><button data-sort="${key}" class="${rankState.sort===key?'active':''}">${label}${rankState.sort===key?(rankState.direction<0?' ↓':' ↑'):''}</button></th>`;
    $('#rankSummary').textContent=`${rows.length} of ${filtered.length} connections · ${windowLabel()} · ${qualificationMinimum()}+ targets${rankState.qualification==='raw'?' · Unscored connections show raw stats only':''}`;
    $('#rankingTable').innerHTML=`<div class="table-scroll" tabindex="0" aria-label="Rankings, scroll horizontally for more statistics"><table class="data-table leaderboard"><thead><tr><th class="rank" scope="col">Rank</th>${header('Connection','name','identity')}${header('Score','synergyScore','score')}<th scope="col">Δ rank*</th>${extra.map(([label,key])=>header(label,key)).join('')}</tr></thead><tbody>${rows.map((r,i)=>{const delta=changes.get(S.id(r));return `<tr><td class="rank">${ranks.get(S.id(r))??'—'}</td><td class="identity"><button class="connection-button" data-duo="${i}">${photo(r,'receiver')}<span>${esc(r.qb)} → ${esc(r.receiver)}<small>${r.team} · ${r.position} · ${status(r)}</small></span></button></td><td class="score" style="color:${S.color(r.synergyScore)}">${fmt(r.synergyScore)}</td><td>${delta===undefined?'—':delta==='New'?'New':delta===0?'0':delta>0?`↑ ${delta}`:`↓ ${-delta}`}</td>${extra.map(([,key,format])=>`<td>${format(r[key])}</td>`).join('')}</tr>`;}).join('')}</tbody></table>${rows.length?'':'<p class="empty">No connections match these filters.</p>'}</div>`;
    $('#changesNote').textContent=snapshotPair.length===2?`* Corrected rank change: completed Week ${snapshotPair[1].throughWeek} vs Week ${snapshotPair[0].throughWeek}, using this view’s position and target minimum. Partial-week results above are excluded from this comparison.`:snapshotError?'* Weekly comparison could not load. Current rankings remain available.':'* Rank changes appear after two completed weeks. Newly eligible connections display “New.”';
    $('#rankingTable').querySelectorAll('[data-duo]').forEach(b=>b.onclick=()=>choose(rows[Number(b.dataset.duo)]));
    $('#rankingTable').querySelectorAll('[data-sort]').forEach(b=>b.onclick=()=>{const key=b.dataset.sort;rankState.direction=rankState.sort===key?-rankState.direction:key==='name'?1:-1;rankState.sort=key;renderRankings();});
    scatter('trust',filtered,'target_share','epa_per_target','Target share','EPA / target',pct,dec);
    scatter('skill',filtered,'yac_over_expected_per_reception','cpoe','YACOE / reception','CPOE',dec,dec);
  }
  function scatter(name, input, xKey, yKey, xLabel, yLabel, xFormat, yFormat) {
    const rows=input.filter(r=>S.number(r[xKey])!==null&&S.number(r[yKey])!==null);
    $(`#${name}Open`).hidden=true;
    $(`#${name}Readout`).textContent='Focus or select a point to identify a connection.';
    if(!rows.length){$(`#${name}Chart`).innerHTML='<p class="empty">No available metrics for these filters.</p>';return;}
    const W=560,H=290,L=48,R=18,T=18,B=42;
    const extent=key=>{const values=rows.map(r=>r[key]),min=Math.min(0,...values),max=Math.max(...values),pad=(max-min||1)*.1;return [min-pad,max+pad];};
    const [xmin,xmax]=extent(xKey),[ymin,ymax]=extent(yKey),sx=v=>L+(v-xmin)/(xmax-xmin)*(W-L-R),sy=v=>T+(ymax-v)/(ymax-ymin)*(H-T-B);
    const mean=key=>rows.reduce((sum,r)=>sum+r[key],0)/rows.length;
    $(`#${name}Chart`).innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(xLabel)} versus ${esc(yLabel)}"><line x1="${L}" x2="${W-R}" y1="${H-B}" y2="${H-B}"/><line x1="${L}" x2="${L}" y1="${T}" y2="${H-B}"/><line class="average" x1="${sx(mean(xKey))}" x2="${sx(mean(xKey))}" y1="${T}" y2="${H-B}"/><line class="average" x1="${L}" x2="${W-R}" y1="${sy(mean(yKey))}" y2="${sy(mean(yKey))}"/>${[0,.5,1].map(t=>`<text x="${sx(xmin+t*(xmax-xmin))}" y="${H-B+17}" text-anchor="middle">${xFormat(xmin+t*(xmax-xmin))}</text><text x="${L-5}" y="${sy(ymin+t*(ymax-ymin))+4}" text-anchor="end">${yFormat(ymin+t*(ymax-ymin))}</text>`).join('')}<text x="${W-R}" y="${H-3}" text-anchor="end">${xLabel} →</text><text x="${L}" y="12">↑ ${yLabel}</text>${rows.map((r,i)=>`<g class="dot" data-point="${i}" tabindex="0" role="button" aria-label="${esc(pairName(r))}: ${xFormat(r[xKey])} ${xLabel}, ${yFormat(r[yKey])} ${yLabel}"><circle cx="${sx(r[xKey])}" cy="${sy(r[yKey])}" r="${Math.min(8,3+Math.sqrt(r.targets)/4)}" fill="${S.color(r.synergyScore)}" opacity=".85"/><title>${esc(pairName(r))}</title></g>`).join('')}</svg>`;
    $(`#${name}Chart`).querySelectorAll('[data-point]').forEach(dot=>{
      const row=rows[Number(dot.dataset.point)],show=()=>{$(`#${name}Readout`).textContent=`${pairName(row)} · ${xFormat(row[xKey])} ${xLabel} · ${yFormat(row[yKey])} ${yLabel}`;$(`#${name}Open`).hidden=false;$(`#${name}Open`).onclick=()=>choose(row);};
      dot.onmouseenter=show;dot.onfocus=show;dot.onclick=show;dot.ondblclick=()=>choose(row);
      dot.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();choose(row);}else if(e.key===' '){e.preventDefault();show();}};
    });
  }
  const glossary=[['Synergy Score','Weighted connection score: outcomes 60%, trust 25%, duo lift 15%, minus up to 5 penalty points. WR/TE and RB are separate peer groups.'],['EPA / target','Expected points added per receiver-tagged pass attempt. Positive values add expected scoring value.'],['CPOE','Completion percentage over expectation, in percentage points.'],['Target share','Share of the quarterback’s receiver-tagged targets directed to this player.'],['Success rate','Percentage of targets with positive EPA.'],['YACOE / rec','Yards after catch above expectation per reception.'],['QB EPA lift','EPA per target to this receiver minus the QB’s EPA per target to other receivers.'],['3rd/4th','Share of this duo’s targets occurring on third or fourth down.'],['Explosive rate','Share of targets gaining at least 20 receiving yards.'],['Provisional','Enough targets to calculate a score, but below the qualification threshold.'],['Rank change','Difference between rankings through the last two completed weeks, recalculated with corrected source data.'],['Last 4 weeks','Results in the four calendar NFL weeks ending with the latest included week. Byes do not extend the window.']];
  function bindGlossary(){document.querySelectorAll('.glossary-button').forEach(b=>b.onclick=()=>$('#glossary').showModal());}
  async function start() {
    $('#glossaryList').innerHTML=glossary.map(([term,definition])=>`<div><dt>${term}</dt><dd>${definition}</dd></div>`).join('');
    $('#closeGlossary').onclick=()=>$('#glossary').close();
    $('#pairSearch').oninput=renderSearch;
    $('#pairSearch').onkeydown=e=>{if(e.key==='Escape'){$('#searchResults').innerHTML='';}else if(e.key==='Enter'){$('#searchResults button')?.click();}else if(e.key==='ArrowDown'){e.preventDefault();$('#searchResults button')?.focus();}};
    $('#searchResults').onkeydown=e=>{const buttons=[...$('#searchResults').querySelectorAll('button')],i=buttons.indexOf(document.activeElement);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();buttons[(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}if(e.key==='Escape'){$('#searchResults').innerHTML='';$('#pairSearch').focus();}};
    manifest=await json('data/manifest.json');
    const requestedSeason=Number(query.get('season'));
    season=manifest.seasons.includes(requestedSeason)?requestedSeason:!query.has('season')&&(query.has('qb')||query.has('receiver'))?2025:manifest.activeSeason;
    // Old duo URLs used combined scope when no scope was supplied.
    if(!query.has('season')&&query.has('qb')&&!query.has('scope'))scope='ALL';
    data=await json(`data/${season}/${scope}.json`);
    view=scoreView(data);
    for(const week of data.weekly||[])S.apply({pairs:week.pairs,thresholds:data.thresholds},{weekly:true});
    const requested=view.pairs.find(r=>r.qbId===query.get('qb')&&r.receiverId===query.get('receiver')&&(!query.get('team')||query.get('team')===r.team));
    const missingSelection=page==='explorer'&&query.has('qb')&&query.has('receiver')&&!requested;
    selected=missingSelection?null:requested||[...view.pairs].sort((a,b)=>b.targets-a.targets)[0];
    renderContext();
    if(query.get('search'))$('#pairSearch').value=query.get('search');
    renderSearch();
    if(!view.pairs.length){empty();return;}
    if(missingSelection){
      $('#content').innerHTML=`<section class="empty"><h2>No targets for this connection in this view</h2><p>The selected players have no recorded connection in this season, scope, and time window. Search for another connection or change the view.</p><a href="${url('index.html')}">Browse connections in this view →</a></section>`;
      return;
    }
    if(page==='explorer'){history.replaceState({},'',url('index.html',selected));renderExplorer();}
    else {
      setupRankings();
      const weeks=(data.snapshotWeeks||[]).slice(-2);
      if(weeks.length===2){try{snapshotPair=await Promise.all(weeks.map(async week=>{const snapshot=await json(`data/${season}/snapshots/${scope}-${week}.json`);return {...snapshot,view:scoreView(snapshot)};}));}catch(error){snapshotError=true;console.error(error);}renderRankings();}
    }
  }
  start().catch(error=>{console.error(error);$('#coverage').textContent='Data could not be loaded';$('#content').innerHTML='<section class="empty"><h2>Unable to load the dashboard</h2><p>Please retry. The last published data has not been replaced.</p><button id="retry">Retry</button></section>';$('#retry').onclick=()=>location.reload();});
})();

import { state } from './state.js';
import { fmtDate, fmtDuration, findSelf } from './format.js';
import { sortedGames } from './game-filters.js';

// ================= HISTORIQUE (list + detail) =================
export function renderList(){
  const mapVal = document.getElementById('mapFilter').value;
  const outVal = document.getElementById('outcomeFilter').value;

  const list = document.getElementById('gameList');
  list.innerHTML = '';

  sortedGames().forEach(g=>{
    if (mapVal && (!g.map || g.map.name !== mapVal)) return;
    const self = findSelf(g);
    const outcome = self ? self.data.outcome : null;
    if (outVal && outcome !== outVal) return;

    const t1 = (g.data.teamOne && g.data.teamOne.score) || 0;
    const t2 = (g.data.teamTwo && g.data.teamTwo.score) || 0;
    const total = (t1 + t2) || 1;
    const aPct = Math.round((t1/total)*100);
    const rPct = 100-aPct;

    const row = document.createElement('div');
    row.className = 'game-row' + (g.id === state.activeGameId ? ' active' : '');
    row.innerHTML = `
      <div class="top-line">
        <span class="map-name">${(g.map && g.map.name) || '?'}</span>
        <span class="outcome-tag ${outcome==='Victory'?'win':outcome==='Defeat'?'loss':'na'}">
          ${outcome==='Victory'?'Victoire':outcome==='Defeat'?'Défaite':'—'}
        </span>
      </div>
      <div class="meta-line">
        <span>${(g.mode && g.mode.identifier) || ''}</span>
        <span>${fmtDate(g.createdAt)} · ${fmtDuration(g.data.duration)}</span>
      </div>
      <div class="score-line">
        <span style="color:var(--alliance)">${t1}</span>
        <div class="score-bar"><div class="a" style="width:${aPct}%"></div><div class="r" style="width:${rPct}%"></div></div>
        <span style="color:var(--rebels)">${t2}</span>
      </div>
    `;
    row.addEventListener('click', ()=>{
      state.activeGameId = g.id;
      renderList();
      renderDetail(g);
    });
    list.appendChild(row);
  });

  if (!list.children.length){
    list.innerHTML = '<div style="padding:20px;color:var(--muted);font-size:13px;">Aucune partie ne correspond à ce filtre.</div>';
  }
}

// Construit le tableau des joueurs d'une équipe pour la vue détail d'un match (mise en valeur du meilleur de l'équipe par colonne).
export function renderMatchRosterTable(teamPlayers, teamKey){
  teamPlayers = teamPlayers.slice().sort((a,b)=>b.data.score - a.data.score);

  // Le meilleur de l'équipe sur chaque colonne numérique est mis en valeur dans la
  // couleur de l'équipe — repère visuel rapide, à défaut d'avoir les stats "maison"
  // d'EVA (SDK / Rating EBP / HS) qui ne sont pas exposées par l'historique de parties.
  const bestScore = Math.max(0, ...teamPlayers.map(p => p.data.score||0));
  const bestDmg = Math.max(0, ...teamPlayers.map(p => p.data.inflictedDamage||0));
  const bestAcc = Math.max(0, ...teamPlayers.map(p => p.data.firedAccuracy||0));
  const bestKD = Math.max(0, ...teamPlayers.map(p => p.data.deaths ? p.data.kills/p.data.deaths : (p.data.kills||0)));
  const bestKDA = Math.max(0, ...teamPlayers.map(p => p.data.deaths ? (p.data.kills+(p.data.assists||0))/p.data.deaths : (p.data.kills+(p.data.assists||0))));
  const bestClass = teamKey === 'alliance' ? 'best-alliance' : 'best-rebels';

  const rows = teamPlayers.map((p,i)=>{
    const d = p.data;
    const kdNum = d.deaths ? d.kills/d.deaths : (d.kills||0);
    const kd = kdNum.toFixed(2);
    const kdaNum = d.deaths ? (d.kills+(d.assists||0))/d.deaths : (d.kills+(d.assists||0));
    const kda = kdaNum.toFixed(2);
    const isMe = p.userId == state.currentUid;
    const acc = d.firedAccuracy||0;
    return `
      <tr class="${isMe?'me':''}">
        <td><span class="match-rank-circle">${i+1}</span></td>
        <td class="name-cell">${d.niceName}${isMe?' <span style="color:var(--gold);font-size:11px;">(toi)</span>':''}</td>
        <td class="num">${d.kills} / ${d.deaths} / ${d.assists||0}</td>
        <td class="num ${d.score===bestScore && bestScore>0 ? bestClass : ''}">${d.score}</td>
        <td class="num ${(d.inflictedDamage||0)===bestDmg && bestDmg>0 ? bestClass : ''}">${(d.inflictedDamage||0).toLocaleString('fr-FR')}</td>
        <td class="num ${acc===bestAcc && bestAcc>0 ? bestClass : ''}">${Math.round(acc*100)}%</td>
        <td class="num ${kdNum===bestKD && bestKD>0 ? bestClass : (kdNum>=1?'kd-good':'kd-bad')}">${kd}</td>
        <td class="num ${kdaNum===bestKDA && bestKDA>0 ? bestClass : (kdaNum>=1?'kd-good':'kd-bad')}">${kda}</td>
      </tr>`;
  }).join('');

  return `
    <div class="table-scroll"><table class="match-roster">
      <thead><tr>
        <th></th><th>Joueur</th><th class="num">K / D / A</th><th class="num">Score</th><th class="num">Dégâts</th><th class="num">Précision</th><th class="num">K/D</th><th class="num">KDA</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// Affiche le détail complet d'une partie (bandeau de score, blocs d'équipe colorés, tableaux).
export function renderDetail(g){
  const alliance = (g.players||[]).filter(p=>p.data.team === 'ALLIANCE');
  const rebels = (g.players||[]).filter(p=>p.data.team === 'REBELS');
  const t1 = (g.data.teamOne && g.data.teamOne.score) || 0;
  const t2 = (g.data.teamTwo && g.data.teamTwo.score) || 0;
  const total = (t1 + t2) || 1;
  const aPct = Math.round((t1/total)*100);
  const rPct = 100-aPct;
  const self = findSelf(g);

  document.getElementById('detail').innerHTML = `
    <div class="match-header">
      <div>
        <h2>${(g.map && g.map.name) || '?'}</h2>
        <div class="tags">
          <span>${(g.mode && g.mode.identifier) || ''}</span>
          <span>${(g.terrain && g.terrain.name) || ''}</span>
          <span>${fmtDuration(g.data.duration)}</span>
        </div>
      </div>
      <div class="date">${fmtDate(g.createdAt)}</div>
    </div>

    <div class="scoreboard">
      <div class="team-score alliance">
        <div class="name">Alliance</div>
        <div class="pts">${t1}</div>
      </div>
      <div class="vs">VS</div>
      <div class="team-score rebels">
        <div class="name">Rebels</div>
        <div class="pts">${t2}</div>
      </div>
    </div>
    <div class="big-bar"><div class="a" style="width:${aPct}%"></div><div class="r" style="width:${rPct}%"></div></div>

    ${self ? `<div style="margin-bottom:20px;font-size:13px;color:var(--muted);">
        Ton résultat : <strong style="color:${self.data.outcome==='Victory'?'var(--win)':'var(--loss)'}">${self.data.outcome==='Victory'?'Victoire':'Défaite'}</strong>
        · ${self.data.kills} kills · ${self.data.deaths} morts · ${self.data.inflictedDamage||0} dégâts infligés
      </div>` : ''}

    <div class="match-team-block alliance">
      <div class="match-team-header"><span class="dot"></span>Alliance<span class="count">${alliance.length} joueur(s)</span></div>
      ${renderMatchRosterTable(alliance, 'alliance')}
    </div>
    <div class="match-team-block rebels">
      <div class="match-team-header"><span class="dot"></span>Rebels<span class="count">${rebels.length} joueur(s)</span></div>
      ${renderMatchRosterTable(rebels, 'rebels')}
    </div>
  `;
}

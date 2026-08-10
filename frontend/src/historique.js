import { state } from './state.js';
import { fmtDate, fmtDuration, findSelf, resolvePlayerName, hasFullMatchData } from './format.js';
import { canonicalUid } from './player-links.js';
import { sortedGames } from './game-filters.js';
import { apiSend, loadFromServer } from './api.js';
import { rebuildPlayerIndex } from './player-index.js';
import { showApp } from './shell.js';

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

    const gd = g.data || {}; // certaines parties importées n'ont pas (encore) de résumé de match complet
    const full = hasFullMatchData(g);
    const t1 = (gd.teamOne && gd.teamOne.score) || 0;
    const t2 = (gd.teamTwo && gd.teamTwo.score) || 0;
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
        <span>${fmtDate(g.createdAt)} · ${fmtDuration(gd.duration)}</span>
      </div>
      ${full ? `<div class="score-line">
        <span style="color:var(--alliance)">${t1}</span>
        <div class="score-bar"><div class="a" style="width:${aPct}%"></div><div class="r" style="width:${rPct}%"></div></div>
        <span style="color:var(--rebels)">${t2}</span>
      </div>` : ''}
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
    const isMe = canonicalUid(p.userId) === canonicalUid(state.currentUid);
    const acc = d.firedAccuracy||0;
    const name = d.niceName || resolvePlayerName(p.userId);
    return `
      <tr class="${isMe?'me':''}">
        <td><span class="match-rank-circle">${i+1}</span></td>
        <td class="name-cell">${name}${isMe?' <span style="color:var(--gold);font-size:11px;">(toi)</span>':''}</td>
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

// Bouton de suppression d'une partie — admin uniquement (voir requireAdmin côté
// serveur, ce masquage n'est que du confort d'affichage). Utile pour corriger un
// import buggé : supprimer la partie puis réimporter le fichier corrigé.
function deleteButtonHtml() {
  if (!state.currentUser || state.currentUser.role !== 'admin') return '';
  return `<button class="btn small danger" id="deleteGameBtn" title="Supprimer cette partie (tu pourras la réimporter ensuite)">🗑 Supprimer</button>`;
}

// Supprime la partie côté serveur puis recharge tout l'état (même logique qu'après
// un import, voir import.js) — pas de fusion locale, on redemande la vérité au serveur.
async function deleteGame(g) {
  const label = `${(g.map && g.map.name) || '?'} · ${fmtDate(g.createdAt)}`;
  if (!confirm(`Supprimer définitivement cette partie (${label}) de la base ? Tu pourras la réimporter ensuite si besoin.`)) return;
  try {
    await apiSend('DELETE', `/api/games/${g.id}`);
  } catch (e) {
    alert('Erreur lors de la suppression de la partie : ' + e.message);
    return;
  }
  await loadFromServer();
  rebuildPlayerIndex();
  showApp();
}

function wireDeleteButton(g) {
  const btn = document.getElementById('deleteGameBtn');
  if (btn) btn.addEventListener('click', () => deleteGame(g));
}

// Construit une vue détail réduite pour les parties qui n'ont plus que outcome/K/D/A
// par joueur (nouveau format d'historique EVA, juillet 2026 — plus de score d'équipe,
// dégâts, précision ni assignation Alliance/Rebels). Un seul classement plutôt que deux
// blocs d'équipe, puisqu'on ne sait plus qui était dans quelle équipe.
function renderSimpleMatchDetail(g, self) {
  const roster = (g.players || []).slice().sort((a, b) => (b.data.kills || 0) - (a.data.kills || 0));
  const rows = roster.map(p => {
    const d = p.data;
    const kdNum = d.deaths ? d.kills / d.deaths : (d.kills || 0);
    const kdaNum = d.deaths ? (d.kills + (d.assists || 0)) / d.deaths : (d.kills + (d.assists || 0));
    const isMe = canonicalUid(p.userId) === canonicalUid(state.currentUid);
    const name = resolvePlayerName(p.userId);
    return `
      <tr class="${isMe ? 'me' : ''}">
        <td>${p.isMvp ? '<span title="MVP" style="color:var(--gold);">★</span>' : ''}</td>
        <td class="name-cell">${name}${isMe ? ' <span style="color:var(--gold);font-size:11px;">(toi)</span>' : ''}</td>
        <td class="num ${d.outcome === 'Victory' ? 'win' : 'loss'}">${d.outcome === 'Victory' ? 'Victoire' : 'Défaite'}</td>
        <td class="num">${d.kills || 0} / ${d.deaths || 0} / ${d.assists || 0}</td>
        <td class="num ${kdNum >= 1 ? 'kd-good' : 'kd-bad'}">${kdNum.toFixed(2)}</td>
        <td class="num ${kdaNum >= 1 ? 'kd-good' : 'kd-bad'}">${kdaNum.toFixed(2)}</td>
      </tr>`;
  }).join('');

  return `
    <div class="match-header">
      <div>
        <h2>${(g.map && g.map.name) || '?'}</h2>
        <div class="tags"><span>${(g.mode && g.mode.identifier) || ''}</span></div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="date">${fmtDate(g.createdAt)}</div>
        ${deleteButtonHtml()}
      </div>
    </div>

    <div class="evolution-hint" style="margin-bottom:16px;">
      Détail réduit : EVA ne fournit plus le score d'équipe, les dégâts, la précision ni
      l'assignation Alliance/Rebels pour cette partie — seuls le résultat et K/D/A par
      joueur sont disponibles.
    </div>

    ${self ? `<div style="margin-bottom:20px;font-size:13px;color:var(--muted);">
        Ton résultat : <strong style="color:${self.data.outcome==='Victory'?'var(--win)':'var(--loss)'}">${self.data.outcome==='Victory'?'Victoire':'Défaite'}</strong>
        · ${self.data.kills||0} kills · ${self.data.deaths||0} morts · ${self.data.assists||0} assists
      </div>` : ''}

    <div class="table-scroll"><table class="match-roster">
      <thead><tr>
        <th></th><th>Joueur</th><th class="num">Résultat</th><th class="num">K / D / A</th><th class="num">K/D</th><th class="num">KDA</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// Nom affiché pour une équipe : jolie casse pour le cas standard ALLIANCE/REBELS,
// tel quel pour un nom d'équipe personnalisé (parties privées type clan war, ex:
// "HASHIRAS"/"ARISE" vus dans un import).
const KNOWN_TEAM_NAMES = { ALLIANCE: 'Alliance', REBELS: 'Rebels' };
function teamDisplayName(key) {
  if (key == null) return '?';
  return KNOWN_TEAM_NAMES[String(key).toUpperCase()] || key;
}

// Affiche le détail complet d'une partie (bandeau de score, blocs d'équipe colorés, tableaux) —
// ou une vue réduite (renderSimpleMatchDetail) si cette partie n'a plus ces infos (voir hasFullMatchData).
export function renderDetail(g){
  const self = findSelf(g);
  if (!hasFullMatchData(g)) {
    document.getElementById('detail').innerHTML = renderSimpleMatchDetail(g, self);
    wireDeleteButton(g);
    return;
  }

  const gd = g.data || {}; // certaines parties importées n'ont pas (encore) de résumé de match complet
  // Les deux "clés" d'équipe utilisées pour regrouper les joueurs : normalement
  // gd.teamOne.name/gd.teamTwo.name valent "ALLIANCE"/"REBELS", mais certaines
  // captures les ont à null (bug ponctuel du collecteur), et une partie privée peut
  // porter un nom d'équipe personnalisé (ex: "HASHIRAS"/"ARISE") — jamais de valeur
  // supposée en dur, toujours dérivée de ce que la partie porte réellement.
  let teamAKey = gd.teamOne && gd.teamOne.name;
  let teamBKey = gd.teamTwo && gd.teamTwo.name;
  if (teamAKey == null || teamBKey == null) {
    const distinctTeams = Array.from(new Set((g.players || []).map(p => p.data && p.data.team).filter(t => t != null)));
    teamAKey = distinctTeams[0] ?? null;
    teamBKey = distinctTeams[1] ?? null;
  }
  const alliance = (g.players||[]).filter(p=>p.data.team === teamAKey);
  const rebels = (g.players||[]).filter(p=>p.data.team === teamBKey);
  const t1 = (gd.teamOne && gd.teamOne.score) || 0;
  const t2 = (gd.teamTwo && gd.teamTwo.score) || 0;
  const total = (t1 + t2) || 1;
  const aPct = Math.round((t1/total)*100);
  const rPct = 100-aPct;

  document.getElementById('detail').innerHTML = `
    <div class="match-header">
      <div>
        <h2>${(g.map && g.map.name) || '?'}</h2>
        <div class="tags">
          <span>${(g.mode && g.mode.identifier) || ''}</span>
          <span>${(g.terrain && g.terrain.name) || ''}</span>
          <span>${fmtDuration(gd.duration)}</span>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="date">${fmtDate(g.createdAt)}</div>
        ${deleteButtonHtml()}
      </div>
    </div>

    <div class="scoreboard">
      <div class="team-score alliance">
        <div class="name">${teamDisplayName(teamAKey)}</div>
        <div class="pts">${t1}</div>
      </div>
      <div class="vs">VS</div>
      <div class="team-score rebels">
        <div class="name">${teamDisplayName(teamBKey)}</div>
        <div class="pts">${t2}</div>
      </div>
    </div>
    <div class="big-bar"><div class="a" style="width:${aPct}%"></div><div class="r" style="width:${rPct}%"></div></div>

    ${self ? `<div style="margin-bottom:20px;font-size:13px;color:var(--muted);">
        Ton résultat : <strong style="color:${self.data.outcome==='Victory'?'var(--win)':'var(--loss)'}">${self.data.outcome==='Victory'?'Victoire':'Défaite'}</strong>
        · ${self.data.kills} kills · ${self.data.deaths} morts · ${self.data.inflictedDamage||0} dégâts infligés
      </div>` : ''}

    <div class="match-team-block alliance">
      <div class="match-team-header"><span class="dot"></span>${teamDisplayName(teamAKey)}<span class="count">${alliance.length} joueur(s)</span></div>
      ${renderMatchRosterTable(alliance, 'alliance')}
    </div>
    <div class="match-team-block rebels">
      <div class="match-team-header"><span class="dot"></span>${teamDisplayName(teamBKey)}<span class="count">${rebels.length} joueur(s)</span></div>
      ${renderMatchRosterTable(rebels, 'rebels')}
    </div>
  `;
  wireDeleteButton(g);
}

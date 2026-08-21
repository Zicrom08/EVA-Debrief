import { state } from './state.js';
import { fmtDate, fmtDuration, findSelf, resolvePlayerName, hasFullMatchData, findMvp, deriveTeams, fmtDelta } from './format.js';
import { canonicalUid } from './player-links.js';
import { sortedGames } from './game-filters.js';
import { computeMatchRatings } from './profil/compute.js';
import { computeMmrHistory, gamesForMmrScope } from './rank.js';
import { apiSend, loadFromServer } from './api.js';
import { rebuildPlayerIndex } from './player-index.js';
import { showApp } from './shell.js';

// ================= HISTORIQUE (list + detail) =================
export function renderList(){
  const mapVal = document.getElementById('mapFilter').value;
  const outVal = document.getElementById('outcomeFilter').value;

  const list = document.getElementById('gameList');
  list.innerHTML = '';

  // Gain/perte de MMR du joueur SÉLECTIONNÉ, partie par partie — voir rank.js. Portée
  // indépendante des filtres carte/mode/période affichés ici (gamesForMmrScope() suit
  // uniquement la sélection de saison, jamais une période libre, voir CLAUDE.md sur
  // game-filters.js) : calculé une seule fois pour toute la liste plutôt que par ligne.
  // Une partie peut n'avoir aucune entrée (voir hasFullMatchData/deriveTeams dans
  // computeMmrHistory) — le badge est alors simplement omis pour cette ligne.
  const mmrHistory = computeMmrHistory(gamesForMmrScope());
  const playerMmrHistory = mmrHistory.historyByUid.get(canonicalUid(state.currentUid)) || [];
  const mmrDeltaByGameId = new Map(playerMmrHistory.map(h => [h.gameId, h]));

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
    const mvp = findMvp(g);
    const mvpName = mvp ? resolvePlayerName(mvp.userId) : null;
    const mmrEntry = mmrDeltaByGameId.get(g.id);

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
      ${mvpName || mmrEntry ? `<div class="mvp-line">
        ${mvpName ? `<span class="mvp-name"><span class="mvp-icon" title="MVP">★</span>${mvpName}</span>` : ''}
        ${mmrEntry ? `<span class="mmr-delta ${mmrEntry.delta>=0?'mmr-gain':'mmr-loss'}" title="Variation de MMR sur cette partie">${fmtDelta(mmrEntry.delta, 0)} MMR</span>` : ''}
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

// Colonnes triables du tableau de roster complet (score, dégâts, précision, K/D, KDA,
// Rating) — décrivent à la fois l'en-tête cliquable et la valeur utilisée pour trier (voir
// sortRosterPlayers/sortHeaderHtml). La colonne "K / D / A" (triplet affiché tel quel) se
// trie sur les kills, comme les tableaux de stats esport habituels.
const ROSTER_SORT_COLUMNS = [
  { key: 'kills', label: 'K / D / A', getValue: p => p.data.kills || 0 },
  { key: 'score', label: 'Score', getValue: p => p.data.score || 0 },
  { key: 'dmg', label: 'Dégâts', getValue: p => p.data.inflictedDamage || 0 },
  { key: 'acc', label: 'Précision', getValue: p => p.data.firedAccuracy || 0 },
  { key: 'kd', label: 'K/D', getValue: p => p.data.deaths ? p.data.kills / p.data.deaths : (p.data.kills || 0) },
  { key: 'kda', label: 'KDA', getValue: p => p.data.deaths ? (p.data.kills + (p.data.assists || 0)) / p.data.deaths : (p.data.kills + (p.data.assists || 0)) },
  {
    key: 'rating', label: 'Rating',
    title: 'Score de performance façon HLTV, calculé par rapport à la moyenne des joueurs de cette partie — 1.00 = performance moyenne du match (cliquer pour trier)',
    getValue: (p, ratings) => (ratings && ratings.get(canonicalUid(p.userId))) ?? -Infinity,
  },
];

// Même principe pour la vue détail réduite (voir renderSimpleMatchDetail) : ni score, ni
// dégâts, ni précision, ni Rating (indisponibles sur ce format, voir hasFullMatchData).
const SIMPLE_ROSTER_SORT_COLUMNS = [
  { key: 'kills', label: 'K / D / A', getValue: p => p.data.kills || 0 },
  { key: 'kd', label: 'K/D', getValue: p => p.data.deaths ? p.data.kills / p.data.deaths : (p.data.kills || 0) },
  { key: 'kda', label: 'KDA', getValue: p => p.data.deaths ? (p.data.kills + (p.data.assists || 0)) / p.data.deaths : (p.data.kills + (p.data.assists || 0)) },
];

// Trie `players` selon `sort` (voir state.matchRosterSort) contre `columns` (l'un des deux
// tableaux ci-dessus). Retombe sur la première colonne du tableau si `sort.key` ne
// correspond à aucune colonne connue de CE tableau — cas normal en passant d'une partie à
// détail complet à une partie réduite (ou vice-versa) sans réinitialiser l'état de tri.
function sortRosterPlayers(players, columns, sort, ratings) {
  const col = columns.find(c => c.key === sort.key) || columns[0];
  const mult = sort.dir === 'asc' ? 1 : -1;
  return players.slice().sort((a, b) => mult * (col.getValue(a, ratings) - col.getValue(b, ratings)));
}

// En-tête de colonne cliquable avec indicateur de tri actif (▼ décroissant / ▲ croissant).
function sortHeaderHtml(col, sort) {
  const active = sort.key === col.key;
  const arrow = active ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : '';
  const title = col.title || `Trier par ${col.label}`;
  return `<th class="num sortable${active ? ' active' : ''}" data-sort-key="${col.key}" title="${title}">${col.label}${arrow}</th>`;
}

// Reclique un en-tête triable (l'un ou l'autre tableau, voir ROSTER_SORT_COLUMNS /
// SIMPLE_ROSTER_SORT_COLUMNS) : même colonne -> inverse la direction, colonne différente ->
// re-sélectionne en décroissant (comportement standard "meilleur en premier"). Un seul état
// de tri partagé entre alliance/rebels (et entre parties) — voir state.matchRosterSort dans
// state.js — donc re-rendre toute la vue détail pour que les deux tableaux restent alignés.
function wireRosterSortHeaders(g) {
  document.querySelectorAll('#detail th[data-sort-key]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      const current = state.matchRosterSort;
      state.matchRosterSort = { key, dir: current.key === key && current.dir === 'desc' ? 'asc' : 'desc' };
      renderDetail(g);
    });
  });
}

// Construit le tableau des joueurs d'une équipe pour la vue détail d'un match (tri par
// colonne cliquable — voir state.matchRosterSort/ROSTER_SORT_COLUMNS —, mise en valeur du
// meilleur de l'équipe par colonne, icône MVP sur le meilleur joueur toutes équipes
// confondues — voir findMvp() dans format.js — et un Rating façon HLTV par joueur — voir
// computeMatchRatings() dans profil/compute.js, `ratings` est une Map userId canonique ->
// rating pour CETTE partie, calculée une seule fois par renderDetail() et partagée entre
// les deux appels (alliance + rebels)).
export function renderMatchRosterTable(teamPlayers, teamKey, mvpUid, ratings){
  const sort = state.matchRosterSort;
  teamPlayers = sortRosterPlayers(teamPlayers, ROSTER_SORT_COLUMNS, sort, ratings);

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
    const isMvp = mvpUid != null && canonicalUid(p.userId) === mvpUid;
    const acc = d.firedAccuracy||0;
    const name = d.niceName || resolvePlayerName(p.userId);
    const rating = ratings ? ratings.get(canonicalUid(p.userId)) : null;
    return `
      <tr class="${isMe?'me':''}">
        <td><span class="match-rank-circle">${i+1}</span></td>
        <td class="name-cell">${isMvp?'<span class="mvp-icon" title="MVP">★</span>':''}${name}${isMe?' <span style="color:var(--gold);font-size:11px;">(toi)</span>':''}</td>
        <td class="num">${d.kills} / ${d.deaths} / ${d.assists||0}</td>
        <td class="num ${d.score===bestScore && bestScore>0 ? bestClass : ''}">${d.score}</td>
        <td class="num ${(d.inflictedDamage||0)===bestDmg && bestDmg>0 ? bestClass : ''}">${(d.inflictedDamage||0).toLocaleString('fr-FR')}</td>
        <td class="num ${acc===bestAcc && bestAcc>0 ? bestClass : ''}">${Math.round(acc*100)}%</td>
        <td class="num ${kdNum===bestKD && bestKD>0 ? bestClass : (kdNum>=1?'kd-good':'kd-bad')}">${kd}</td>
        <td class="num ${kdaNum===bestKDA && bestKDA>0 ? bestClass : (kdaNum>=1?'kd-good':'kd-bad')}">${kda}</td>
        <td class="num ${rating==null ? '' : (rating>=1?'kd-good':'kd-bad')}">${rating==null ? '–' : rating.toFixed(2)}</td>
      </tr>`;
  }).join('');

  return `
    <div class="table-scroll"><table class="match-roster">
      <thead><tr>
        <th></th><th>Joueur</th>${ROSTER_SORT_COLUMNS.map(col => sortHeaderHtml(col, sort)).join('')}
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
  const sort = state.matchRosterSort;
  const roster = sortRosterPlayers(g.players || [], SIMPLE_ROSTER_SORT_COLUMNS, sort, null);
  const mvp = findMvp(g);
  const mvpUid = mvp ? canonicalUid(mvp.userId) : null;
  const rows = roster.map(p => {
    const d = p.data;
    const kdNum = d.deaths ? d.kills / d.deaths : (d.kills || 0);
    const kdaNum = d.deaths ? (d.kills + (d.assists || 0)) / d.deaths : (d.kills + (d.assists || 0));
    const isMe = canonicalUid(p.userId) === canonicalUid(state.currentUid);
    const isMvp = mvpUid != null && canonicalUid(p.userId) === mvpUid;
    const name = resolvePlayerName(p.userId);
    return `
      <tr class="${isMe ? 'me' : ''}">
        <td>${isMvp ? '<span class="mvp-icon" title="MVP">★</span>' : ''}</td>
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
        <th></th><th>Joueur</th><th class="num">Résultat</th>${SIMPLE_ROSTER_SORT_COLUMNS.map(col => sortHeaderHtml(col, sort)).join('')}
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
    wireRosterSortHeaders(g);
    return;
  }

  const gd = g.data || {}; // certaines parties importées n'ont pas (encore) de résumé de match complet
  const { teamAKey, teamBKey, teamA: alliance, teamB: rebels } = deriveTeams(g);
  const mvp = findMvp(g);
  const mvpUid = mvp ? canonicalUid(mvp.userId) : null;
  const ratings = computeMatchRatings(g);
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
      ${renderMatchRosterTable(alliance, 'alliance', mvpUid, ratings)}
    </div>
    <div class="match-team-block rebels">
      <div class="match-team-header"><span class="dot"></span>${teamDisplayName(teamBKey)}<span class="count">${rebels.length} joueur(s)</span></div>
      ${renderMatchRosterTable(rebels, 'rebels', mvpUid, ratings)}
    </div>
  `;
  wireDeleteButton(g);
  wireRosterSortHeaders(g);
}

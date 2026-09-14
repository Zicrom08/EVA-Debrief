import { state } from './state.js';
import { apiSend } from './api.js';
import { fmtDate, resolvePlayerName } from './format.js';
import { canonicalUid } from './player-links.js';
import { computeMatchRatings } from './profil/compute.js';

// Ce module ne DOIT jamais importer historique.js (qui importe lui-même shell.js, lequel
// touche `document` au chargement du module — voir CLAUDE.md sur les modules testables sans
// DOM) : ça rendrait resolveGroupGames() ci-dessous impossible à tester via `node --test`
// (crash à l'import, pas de DOM en Node). À la place, un évènement custom sur `document`
// (voir notifyGroupsChanged()) permet à historique.js d'écouter et de se re-rendre
// lui-même (liste + éventuellement le panneau détail) sans que ce fichier ait besoin de le
// connaître.
function notifyGroupsChanged() {
  document.dispatchEvent(new CustomEvent('gamegroups:changed'));
}

// ================= GROUPES DE PARTIES (training/scrim) — privés au compte connecté =================
// Simples enveloppes autour de l'API — le contrôle d'accès (readonly exclu) et l'isolation
// stricte par compte (même un admin ne voit pas les groupes des autres) vivent entièrement
// côté serveur, voir backend/db.js::getGroupsForUser()/updateGroup()/deleteGroup() et les
// routes /api/game-groups* dans backend/server.js.
export async function createGameGroup(name, gameIds) {
  return apiSend('POST', '/api/game-groups', { name, gameIds });
}
export async function updateGameGroup(id, patch) {
  return apiSend('PUT', `/api/game-groups/${id}`, patch);
}
export async function deleteGameGroup(id) {
  return apiSend('DELETE', `/api/game-groups/${id}`);
}

// Games d'un groupe encore présentes dans la base — un id de partie supprimée (voir DELETE
// /api/games/:id) est simplement filtré ici, pas de nettoyage côté serveur (inutile : une
// partie supprimée est déjà invisible partout ailleurs dans l'app). Pure, sans DOM, testée
// directement dans frontend/test/game-groups.test.js.
export function resolveGroupGames(group, gamesById) {
  return (group.gameIds || []).map(id => gamesById[id]).filter(Boolean);
}

// Groupes du compte connecté, triés du plus récemment créé au plus ancien — ordre
// d'affichage utilisé par historique.js pour les lister au-dessus des parties.
export function sortedGroups() {
  return Object.values(state.matchGroups).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ================= Agrégation par joueur sur l'ensemble des parties d'un groupe =================
// Contrairement à aggregateGames() (tendances.js), qui agrège UN SEUL joueur (state.currentUid)
// sur une liste de parties, ceci agrège CHAQUE joueur ayant participé à au moins une partie du
// groupe — c'est le pendant "aggrégé dans le temps" du roster d'un seul match (voir
// renderMatchRosterTable dans historique.js), pas une déclinaison de aggregateGames.
// Kills/deaths/assists : sommés (totaux sur le groupe). Score/dégâts/précision : moyennés par
// partie jouée (mêmes conventions que aggregateGames pour score/dégâts). Rating : moyenne des
// Ratings par match (voir computeMatchRatings dans profil/compute.js, calculé match par match
// puis moyenné — jamais recalculé globalement, un Rating n'a de sens que relatif à UN match).
export function computeGroupPlayerAggregates(games) {
  const byUid = new Map();
  games.forEach(g => {
    const ratings = computeMatchRatings(g); // Map vide si !hasFullMatchData(g)
    (g.players || []).forEach(p => {
      if (!p || !p.data) return;
      const uid = canonicalUid(p.userId);
      if (!byUid.has(uid)) {
        byUid.set(uid, { uid, n: 0, wins: 0, losses: 0, kills: 0, deaths: 0, assists: 0, dmgSum: 0, scoreSum: 0, accSum: 0, accN: 0, ratingSum: 0, ratingN: 0 });
      }
      const rec = byUid.get(uid);
      rec.n++;
      if (p.data.outcome === 'Victory') rec.wins++;
      else if (p.data.outcome === 'Defeat') rec.losses++;
      rec.kills += p.data.kills || 0;
      rec.deaths += p.data.deaths || 0;
      rec.assists += p.data.assists || 0;
      rec.dmgSum += p.data.inflictedDamage || 0;
      rec.scoreSum += p.data.score || 0;
      if (p.data.firedAccuracy != null) { rec.accSum += p.data.firedAccuracy; rec.accN++; }
      const rating = ratings.get(uid);
      if (rating != null) { rec.ratingSum += rating; rec.ratingN++; }
    });
  });
  return Array.from(byUid.values()).map(rec => ({
    uid: rec.uid,
    name: resolvePlayerName(rec.uid),
    n: rec.n,
    wins: rec.wins,
    losses: rec.losses,
    winrate: rec.n ? Math.round((rec.wins / rec.n) * 100) : 0,
    kills: rec.kills,
    deaths: rec.deaths,
    assists: rec.assists,
    kd: rec.deaths ? rec.kills / rec.deaths : rec.kills,
    kda: rec.deaths ? (rec.kills + rec.assists) / rec.deaths : (rec.kills + rec.assists),
    avgScore: rec.n ? Math.round(rec.scoreSum / rec.n) : 0,
    avgDmg: rec.n ? Math.round(rec.dmgSum / rec.n) : 0,
    avgAcc: rec.accN ? rec.accSum / rec.accN : null,
    rating: rec.ratingN ? rec.ratingSum / rec.ratingN : null,
  }));
}

// Colonnes triables du tableau agrégé — même principe que ROSTER_SORT_COLUMNS/
// SIMPLE_ROSTER_SORT_COLUMNS dans historique.js, mais sur les valeurs déjà agrégées
// ci-dessus. État de tri séparé (state.groupRosterSort) : dupliqué plutôt que réutilisé
// depuis historique.js, qui ne peut pas être importé ici (voir la note en haut du fichier).
const GROUP_ROSTER_COLUMNS = [
  { key: 'games', label: 'Parties', getValue: p => p.n },
  { key: 'winrate', label: 'Winrate', getValue: p => p.winrate },
  { key: 'kills', label: 'K / D / A', getValue: p => p.kills },
  { key: 'score', label: 'Score moy.', getValue: p => p.avgScore },
  { key: 'dmg', label: 'Dégâts moy.', getValue: p => p.avgDmg },
  { key: 'acc', label: 'Précision moy.', getValue: p => p.avgAcc ?? -Infinity },
  { key: 'kd', label: 'K/D', getValue: p => p.kd },
  { key: 'kda', label: 'KDA', getValue: p => p.kda },
  { key: 'rating', label: 'Rating moy.', getValue: p => p.rating ?? -Infinity },
];

function sortGroupRoster(players, sort) {
  const col = GROUP_ROSTER_COLUMNS.find(c => c.key === sort.key) || GROUP_ROSTER_COLUMNS[0];
  const mult = sort.dir === 'asc' ? 1 : -1;
  return players.slice().sort((a, b) => mult * (col.getValue(a) - col.getValue(b)));
}

function groupSortHeaderHtml(col, sort) {
  const active = sort.key === col.key;
  const arrow = active ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : '';
  return `<th class="num sortable${active ? ' active' : ''}" data-sort-key="${col.key}">${col.label}${arrow}</th>`;
}

// ================= Panneau détail d'un groupe — affiché dans #detail comme un match =================
// Remplace le modal d'origine : un groupe s'affiche désormais exactement là où s'affiche le
// détail d'une partie (clic sur sa ligne dans la liste, voir historique.js), avec la même
// famille de composants visuels (.match-header/table.match-roster) — juste des colonnes
// agrégées par joueur plutôt que les valeurs brutes d'un seul match.
export function renderGroupDetail(group) {
  state.activeGroupId = group.id;
  state.activeGameId = null;
  const games = resolveGroupGames(group, state.gamesById);
  const players = sortGroupRoster(computeGroupPlayerAggregates(games), state.groupRosterSort);

  const detail = document.getElementById('detail');
  detail.innerHTML = `
    <div class="match-header">
      <div>
        <h2>📦 ${group.name}</h2>
        <div class="tags"><span>${games.length} partie${games.length === 1 ? '' : 's'}</span><span>créé le ${fmtDate(group.createdAt)}</span></div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <button class="btn small" id="editGroupSelectionBtn">✏️ Modifier la sélection</button>
        <button class="btn small" id="renameGroupBtn">✎ Renommer</button>
        <button class="btn small danger" id="deleteGroupBtn">🗑 Supprimer</button>
      </div>
    </div>
    ${!players.length ? '<div class="detail-empty">Ce groupe ne contient plus aucune partie valide (toutes ont peut-être été supprimées).</div>' : `
    <div class="table-scroll"><table class="match-roster">
      <thead><tr>
        <th>Joueur</th>${GROUP_ROSTER_COLUMNS.map(col => groupSortHeaderHtml(col, state.groupRosterSort)).join('')}
      </tr></thead>
      <tbody>${players.map(p => {
        const isMe = p.uid === canonicalUid(state.currentUid);
        return `
        <tr class="${isMe ? 'me' : ''}">
          <td class="name-cell">${p.name}${isMe ? ' <span style="color:var(--gold);font-size:11px;">(toi)</span>' : ''}</td>
          <td class="num">${p.n}</td>
          <td class="num">${p.winrate}% <span style="color:var(--muted);">(${p.wins}/${p.losses})</span></td>
          <td class="num">${p.kills} / ${p.deaths} / ${p.assists}</td>
          <td class="num">${p.avgScore}</td>
          <td class="num">${p.avgDmg.toLocaleString('fr-FR')}</td>
          <td class="num">${p.avgAcc != null ? Math.round(p.avgAcc * 100) + '%' : '–'}</td>
          <td class="num ${p.kd >= 1 ? 'kd-good' : 'kd-bad'}">${p.kd.toFixed(2)}</td>
          <td class="num ${p.kda >= 1 ? 'kd-good' : 'kd-bad'}">${p.kda.toFixed(2)}</td>
          <td class="num ${p.rating == null ? '' : (p.rating >= 1 ? 'kd-good' : 'kd-bad')}">${p.rating == null ? '–' : p.rating.toFixed(2)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`}
  `;

  detail.querySelectorAll('th[data-sort-key]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      const current = state.groupRosterSort;
      state.groupRosterSort = { key, dir: current.key === key && current.dir === 'desc' ? 'asc' : 'desc' };
      renderGroupDetail(group);
    });
  });

  document.getElementById('editGroupSelectionBtn').addEventListener('click', () => {
    state.selectionMode = true;
    state.selectedGameIds = new Set((group.gameIds || []).map(String));
    state.activeGroupId = null;
    detail.innerHTML = '<div class="detail-empty">Sélectionne les parties à inclure dans ce groupe à gauche, puis clique "Créer un groupe".</div>';
    notifyGroupsChanged();
    renderSelectionBar();
  });
  document.getElementById('renameGroupBtn').addEventListener('click', async () => {
    const name = prompt('Nouveau nom du groupe :', group.name);
    if (!name || !name.trim()) return;
    try {
      const updated = await updateGameGroup(group.id, { name: name.trim() });
      state.matchGroups[group.id] = updated;
      renderGroupDetail(updated);
      notifyGroupsChanged();
    } catch (e) {
      alert('Erreur lors du renommage : ' + e.message);
    }
  });
  document.getElementById('deleteGroupBtn').addEventListener('click', async () => {
    if (!confirm(`Supprimer le groupe "${group.name}" ? Les parties elles-mêmes ne sont pas supprimées.`)) return;
    try {
      await deleteGameGroup(group.id);
      delete state.matchGroups[group.id];
      state.activeGroupId = null;
      detail.innerHTML = '<div class="detail-empty">Sélectionne une partie ou un groupe à gauche pour voir le détail des scores.</div>';
      notifyGroupsChanged();
    } catch (e) {
      alert('Erreur lors de la suppression : ' + e.message);
    }
  });
}

// ================= Mode sélection : barre d'action (compteur + créer/annuler) =================
// Mutuellement exclusif avec #toggleSelectionModeBtn (voir historique.js) : celui-ci reste
// affiché quand le mode sélection est inactif, et se masque dès qu'il l'est — sinon "☑
// Sélectionner des parties" (qui n'a plus rien à activer) et "Annuler" (juste à côté, dans
// #selectionBar) se retrouvent affichés côte à côte, deux façons redondantes et déroutantes
// de faire à peu près la même chose. Seul point d'entrée du mode sélection = ce bouton ;
// seul point de sortie une fois dedans = "Annuler" (ou "Créer un groupe" avec succès).
export function renderSelectionBar() {
  const bar = document.getElementById('selectionBar');
  const toggleBtn = document.getElementById('toggleSelectionModeBtn');
  if (!bar) return;
  if (toggleBtn) toggleBtn.style.display = state.selectionMode ? 'none' : '';
  if (!state.selectionMode) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = 'flex';
  const n = state.selectedGameIds.size;
  bar.innerHTML = `
    <span class="selection-count">${n} partie${n === 1 ? '' : 's'} sélectionnée${n === 1 ? '' : 's'}</span>
    <div class="selection-actions">
      <button class="btn small primary" id="createGroupFromSelectionBtn" ${n === 0 ? 'disabled' : ''}>Créer un groupe</button>
      <button class="btn small" id="cancelSelectionBtn">Annuler</button>
    </div>
  `;
  document.getElementById('createGroupFromSelectionBtn').addEventListener('click', async () => {
    if (!state.selectedGameIds.size) return;
    const name = prompt('Nom du groupe (ex : "Training lundi", "Scrim vs TeamX") :');
    if (!name || !name.trim()) return;
    try {
      const group = await createGameGroup(name.trim(), Array.from(state.selectedGameIds));
      state.matchGroups[group.id] = group;
      state.selectionMode = false;
      state.selectedGameIds = new Set();
      notifyGroupsChanged();
      renderSelectionBar();
    } catch (e) {
      alert('Erreur lors de la création du groupe : ' + e.message);
    }
  });
  document.getElementById('cancelSelectionBtn').addEventListener('click', () => {
    state.selectionMode = false;
    state.selectedGameIds = new Set();
    notifyGroupsChanged();
    renderSelectionBar();
  });
}

import { state } from './state.js';
import { apiSend } from './api.js';
import { aggregateGames } from './tendances.js';
import { fmtDate } from './format.js';

// Ce module ne DOIT jamais importer historique.js (qui importe lui-même shell.js, lequel
// touche `document` au chargement du module — voir CLAUDE.md sur les modules testables sans
// DOM) : ça rendrait resolveGroupGames() ci-dessous impossible à tester via `node --test`
// (crash à l'import, pas de DOM en Node). À la place, un évènement custom sur `document`
// (voir notifyGamesSelectionChanged()) permet à historique.js d'écouter et de se re-rendre
// lui-même sans que ce fichier ait besoin de le connaître.
function notifyGamesSelectionChanged() {
  document.dispatchEvent(new CustomEvent('gamegroups:refresh'));
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

// ================= Panneau des groupes (liste des "catégories" du compte connecté) =================
export function renderGroupPanel() {
  const container = document.getElementById('matchGroupPanel');
  if (!container) return;
  const groups = Object.values(state.matchGroups).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (!groups.length) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = `
    <div class="match-group-panel">
      ${groups.map(g => {
        const n = resolveGroupGames(g, state.gamesById).length;
        return `
          <div class="match-group-chip" data-group-id="${g.id}">
            <div class="match-group-chip-main">
              <span class="match-group-name">${g.name}</span>
              <span class="match-group-count">${n} partie${n === 1 ? '' : 's'}</span>
            </div>
            <div class="match-group-actions">
              <button class="btn tiny" data-action="recap" title="Voir le récap">📊</button>
              <button class="btn tiny" data-action="edit" title="Modifier la sélection de parties">✏️</button>
              <button class="btn tiny" data-action="rename" title="Renommer">✎</button>
              <button class="btn tiny danger" data-action="delete" title="Supprimer">🗑</button>
            </div>
          </div>`;
      }).join('')}
    </div>`;

  container.querySelectorAll('.match-group-chip').forEach(chip => {
    const id = chip.dataset.groupId;
    const group = state.matchGroups[id];
    if (!group) return;
    chip.querySelector('[data-action="recap"]').addEventListener('click', () => openGroupRecapModal(group));
    chip.querySelector('[data-action="edit"]').addEventListener('click', () => {
      state.selectionMode = true;
      state.selectedGameIds = new Set((group.gameIds || []).map(String));
      notifyGamesSelectionChanged();
      renderGroupPanel();
      renderSelectionBar();
    });
    chip.querySelector('[data-action="rename"]').addEventListener('click', async () => {
      const name = prompt('Nouveau nom du groupe :', group.name);
      if (!name || !name.trim()) return;
      try {
        await updateGameGroup(group.id, { name: name.trim() });
        state.matchGroups[group.id] = { ...group, name: name.trim() };
        renderGroupPanel();
      } catch (e) {
        alert('Erreur lors du renommage : ' + e.message);
      }
    });
    chip.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (!confirm(`Supprimer le groupe "${group.name}" ? Les parties elles-mêmes ne sont pas supprimées.`)) return;
      try {
        await deleteGameGroup(group.id);
        delete state.matchGroups[group.id];
        renderGroupPanel();
      } catch (e) {
        alert('Erreur lors de la suppression : ' + e.message);
      }
    });
  });
}

// ================= Mode sélection : barre d'action (compteur + créer/annuler) =================
export function renderSelectionBar() {
  const bar = document.getElementById('selectionBar');
  if (!bar) return;
  if (!state.selectionMode) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = 'flex';
  const n = state.selectedGameIds.size;
  bar.innerHTML = `
    <span class="selection-count">${n} partie${n === 1 ? '' : 's'} sélectionnée${n === 1 ? '' : 's'}</span>
    <button class="btn small primary" id="createGroupFromSelectionBtn" ${n === 0 ? 'disabled' : ''}>Créer un groupe</button>
    <button class="btn small" id="cancelSelectionBtn">Annuler</button>
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
      notifyGamesSelectionChanged();
      renderGroupPanel();
      renderSelectionBar();
    } catch (e) {
      alert('Erreur lors de la création du groupe : ' + e.message);
    }
  });
  document.getElementById('cancelSelectionBtn').addEventListener('click', () => {
    state.selectionMode = false;
    state.selectedGameIds = new Set();
    notifyGamesSelectionChanged();
    renderGroupPanel();
    renderSelectionBar();
  });
}

// ================= Modal de récap (overlay en page, pas de window.open/confirm) =================
let modalKeydownHandler = null;

export function openGroupRecapModal(group) {
  const overlay = document.getElementById('groupRecapModal');
  const content = document.getElementById('groupRecapContent');
  if (!overlay || !content) return;

  const games = resolveGroupGames(group, state.gamesById);
  const agg = aggregateGames(games, state.currentUid);
  const created = group.createdAt ? fmtDate(group.createdAt) : '';

  content.innerHTML = `
    <h3 style="margin-top:0;">${group.name}</h3>
    <p style="color:var(--muted);font-size:12px;margin-top:-8px;">
      ${games.length} partie${games.length === 1 ? '' : 's'}${created ? ` · créé le ${created}` : ''}
    </p>
    ${!agg.n ? '<div class="detail-empty" style="margin-top:0;">Aucune partie de ce groupe n\'implique le joueur sélectionné (ou toutes ont été supprimées).</div>' : `
    <div class="profile-grid">
      <div class="cell"><div class="label">Parties</div><div class="value">${agg.n}</div></div>
      <div class="cell"><div class="label">V / D</div><div class="value"><span class="win">${agg.wins}</span> / <span class="loss">${agg.losses}</span></div></div>
      <div class="cell"><div class="label">Taux de victoire</div><div class="value">${agg.winrate}%</div></div>
      <div class="cell"><div class="label">Ratio K/D</div><div class="value">${agg.kd}</div></div>
      <div class="cell"><div class="label">KDA</div><div class="value">${agg.kda}</div></div>
      <div class="cell"><div class="label">Dégâts moyens</div><div class="value">${agg.avgDmg}</div></div>
      <div class="cell"><div class="label">Score moyen</div><div class="value">${agg.avgScore}</div></div>
      <div class="cell"><div class="label">Kills / Morts / Assists</div><div class="value" style="font-size:16px;">${agg.kills} / ${agg.deaths} / ${agg.assists}</div></div>
    </div>`}
  `;

  overlay.style.display = 'flex';
  overlay.addEventListener('click', overlayClickHandler);
  modalKeydownHandler = (e) => { if (e.key === 'Escape') closeGroupRecapModal(); };
  document.addEventListener('keydown', modalKeydownHandler);
}

// Un seul listener sur l'overlay couvre à la fois le clic à l'extérieur de la boîte ET le
// bouton ✕ (à l'intérieur, mais son clic bubble jusqu'ici) — pas besoin d'un listener séparé
// sur le bouton lui-même, donc pas de risque de l'empiler à chaque ouverture.
function overlayClickHandler(e) {
  if (e.target.id === 'groupRecapModal' || e.target.id === 'closeGroupRecapBtn') closeGroupRecapModal();
}

export function closeGroupRecapModal() {
  const overlay = document.getElementById('groupRecapModal');
  if (!overlay) return;
  overlay.style.display = 'none';
  overlay.removeEventListener('click', overlayClickHandler);
  if (modalKeydownHandler) {
    document.removeEventListener('keydown', modalKeydownHandler);
    modalKeydownHandler = null;
  }
}

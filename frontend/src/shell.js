import { state } from './state.js';
import { findPlayerInGame, roleLabel } from './format.js';
import { apiSend } from './api.js';
import { clearUiPrefs } from './ui-prefs.js';
import { filteredGamesArray } from './game-filters.js';
import { renderList } from './historique.js';
import { aggregateGames } from './tendances.js';
import { renderPlayerPicker, renderMapFilterOptions } from './player-index.js';
import { renderMapExcludePanel, renderSeasonFilterOptions, updateRangeInfo } from './filters-ui.js';

// ================= APP SHELL =================
export function showApp() {
  document.getElementById('importScreen').style.display = 'none';
  document.getElementById('headerActions').style.display = 'flex';
  document.getElementById('summary').style.display = 'grid';
  document.getElementById('tabbar').style.display = 'flex';
  document.getElementById('rangeBar').style.display = 'flex';
  const gCount = Object.keys(state.gamesById).length;
  const sCount = Object.values(state.playerStatsSnapshots).reduce((s,a)=>s+a.length,0);
  const storageNote = '🗄️ stocké sur le serveur';
  document.getElementById('brandSub').textContent =
    `${gCount} partie(s) · ${sCount} profil(s) capturé(s) · ${storageNote}`;
  applyRolePermissions();
  renderPlayerPicker();
  renderMapFilterOptions();
  renderMapExcludePanel();
  renderSeasonFilterOptions();
  updateRangeInfo();
  renderSummary();
  renderList();
  state.activeGameId = null;
  document.getElementById('detail').innerHTML =
    '<div class="detail-empty">Sélectionne une partie à gauche pour voir le détail des scores.</div>';
}

// Affiche le compte connecté et adapte l'UI à son rôle :
// - "readonly" ne peut ni importer ni réinitialiser ni gérer équipes/comptes ;
// - "contributor" peut en plus importer, mais pas réinitialiser ni gérer équipes/comptes ;
// - "admin" a accès à tout.
// Ces règles sont aussi appliquées côté serveur (voir requireImportAccess/requireAdmin
// dans server.js) — ce masquage n'est que du confort d'affichage.
function applyRolePermissions() {
  const user = state.currentUser;
  const label = document.getElementById('currentUserLabel');
  if (label) label.textContent = user ? `${user.username} (${roleLabel(user.role)})` : '';
  const isReadonly = user && user.role === 'readonly';
  const isAdmin = user && user.role === 'admin';
  document.getElementById('addMoreBtn').style.display = isReadonly ? 'none' : '';
  document.getElementById('resetBtn').style.display = isAdmin ? '' : 'none';
  document.getElementById('comptesTabBtn').style.display = isAdmin ? '' : 'none';
}

// ================= SUMMARY =================
export function renderSummary(){
  const box = document.getElementById('summary');
  if (!state.currentUid) { box.innerHTML = ''; return; }
  const games = filteredGamesArray().filter(g => findPlayerInGame(g, state.currentUid));
  if (!games.length) {
    box.innerHTML = `<div class="cell" style="grid-column:1/-1;"><div class="label">Joueur sélectionné</div>
      <div class="value" style="font-size:16px;color:var(--muted);">Aucune partie dans la période sélectionnée pour ce joueur.</div></div>`;
    return;
  }
  const agg = aggregateGames(games, state.currentUid);

  box.innerHTML = `
    <div class="cell"><div class="label">Parties jouées</div><div class="value">${agg.n}</div></div>
    <div class="cell"><div class="label">Victoires / Défaites</div>
      <div class="value"><span class="win">${agg.wins}</span> <span style="color:var(--muted)">/</span> <span class="loss">${agg.losses}</span></div></div>
    <div class="cell"><div class="label">Taux de victoire</div><div class="value">${agg.winrate}%</div></div>
    <div class="cell"><div class="label">KDA</div><div class="value">${agg.kda}</div>
      <div class="sub">${agg.kills} kills · ${agg.deaths} morts · ${agg.assists} assists</div></div>
    <div class="cell"><div class="label">Score moyen</div><div class="value">${agg.avgScore}</div></div>
    <div class="cell"><div class="label">Dégâts moyens</div><div class="value">${agg.avgDmg}</div></div>
  `;
}

document.getElementById('addMoreBtn').addEventListener('click', () => {
  document.getElementById('importScreen').style.display = 'block';
  document.getElementById('importScreen').scrollIntoView({behavior:'smooth'});
});

document.getElementById('resetBtn').addEventListener('click', async () => {
  if (!confirm('Vider TOUTES les données stockées sur le serveur (parties, profils, équipes) ? Cette action est irréversible et concerne tout le monde qui utilise ce serveur.')) return;
  try {
    await apiSend('DELETE', '/api/reset');
  } catch (e) {
    alert('Erreur lors de la réinitialisation côté serveur : ' + e.message);
    return;
  }
  state.gamesById = {}; state.players = {}; state.playerStatsSnapshots = {};
  state.customTeams = {}; state.playerLinks = {};
  state.currentUid = null; state.activeGameId = null; state.teamAId = null; state.teamBId = null; state.profileCompareUid = null;
  state.dateRangeStart = null; state.dateRangeEnd = null; state.selectedSeasonId = null;
  state.excludedMaps = new Set();
  state.excludedModes = new Set();
  state.knownModes = new Set();
  clearUiPrefs();
  document.getElementById('headerActions').style.display = 'none';
  document.getElementById('summary').style.display = 'none';
  document.getElementById('tabbar').style.display = 'none';
  document.getElementById('rangeBar').style.display = 'none';
  document.getElementById('mapExcludePanel').style.display = 'none';
  document.getElementById('mapExcludePanel').innerHTML = '';
  document.querySelectorAll('.range-presets button').forEach(b => b.classList.remove('active'));
  document.querySelector('.range-presets button[data-preset="all"]').classList.add('active');
  document.getElementById('rangeFrom').value = '';
  document.getElementById('rangeTo').value = '';
  document.getElementById('seasonFilter').innerHTML = '<option value="">Toutes les saisons</option>';
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('viewHistorique').classList.add('active');
  document.getElementById('brandSub').textContent = 'Aucune donnée importée';
  document.getElementById('importScreen').style.display = 'block';
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await fetch('/api/logout', { method: 'POST' }); } catch (e) {}
  window.location.href = '/login.html';
});

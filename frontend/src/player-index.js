import { state } from './state.js';
import { mostCommonName } from './format.js';
import { persistUiPrefs } from './ui-prefs.js';
import { renderSummary } from './shell.js';
import { renderList } from './historique.js';
import { renderTrends } from './tendances.js';
import { renderComparatif } from './comparatif.js';
import { renderProfil } from './profil/index.js';

// ================= PLAYER INDEX (from game history) =================
export function rebuildPlayerIndex() {
  state.players = {};
  Object.values(state.gamesById).forEach(g => {
    (g.players || []).forEach(p => {
      const uid = p.userId;
      if (!state.players[uid]) state.players[uid] = {
        niceNames:{}, games:0, wins:0, losses:0, kills:0, deaths:0, assists:0, dmg:0, score:0
      };
      const rec = state.players[uid];
      const name = p.data.niceName || '???';
      rec.niceNames[name] = (rec.niceNames[name]||0)+1;
      rec.games++;
      if (p.data.outcome === "Victory") rec.wins++;
      else if (p.data.outcome === "Defeat") rec.losses++;
      rec.kills += p.data.kills || 0;
      rec.deaths += p.data.deaths || 0;
      rec.assists += p.data.assists || 0;
      rec.dmg += p.data.inflictedDamage || 0;
      rec.score += p.data.score || 0;
    });
  });
  // also register state.players that only exist via profile-stat imports (no games imported yet)
  Object.entries(state.playerStatsSnapshots).forEach(([uid, snaps]) => {
    if (!state.players[uid] && snaps.length) {
      const last = snaps[snaps.length-1];
      state.players[uid] = {
        niceNames: { [last.user.displayName || last.user.username || uid]: 1 },
        games:0, wins:0, losses:0, kills:0, deaths:0, assists:0, dmg:0, score:0
      };
    }
  });
  const sorted = Object.entries(state.players).sort((a,b)=>b[1].games-a[1].games);
  if (!state.currentUid || !state.players[state.currentUid]) {
    state.currentUid = sorted.length ? sorted[0][0] : null;
  }
}

// Construit le sélecteur "Joueur" du header, trié par nombre de parties jouées.
export function renderPlayerPicker() {
  const picker = document.getElementById('playerPicker');
  picker.innerHTML = '';
  const sorted = Object.entries(state.players).sort((a,b)=>b[1].games-a[1].games);
  sorted.forEach(([uid, rec])=>{
    const opt = document.createElement('option');
    opt.value = uid;
    const label = rec.games > 0 ? `${mostCommonName(rec)} (${rec.games} parties)` : `${mostCommonName(rec)} (profil seul)`;
    opt.textContent = label;
    picker.appendChild(opt);
  });
  picker.value = state.currentUid;
  picker.onchange = () => {
    state.currentUid = picker.value;
    if (state.profileCompareUid === state.currentUid) state.profileCompareUid = null;
    state.mapDeepDiveSelection = null;
    persistUiPrefs();
    renderSummary();
    renderList();
    document.getElementById('detail').innerHTML =
      '<div class="detail-empty">Sélectionne une partie à gauche pour voir le détail des scores.</div>';
    state.activeGameId = null;
    if (document.getElementById('viewTendances').classList.contains('active')) renderTrends();
    if (document.getElementById('viewProfil').classList.contains('active')) renderProfil();
    if (document.getElementById('viewComparatif').classList.contains('active')) renderComparatif();
  };
}

// Construit le menu déroulant de filtrage par carte de l'onglet Historique.
export function renderMapFilterOptions() {
  const mapFilter = document.getElementById('mapFilter');
  const current = mapFilter.value;
  mapFilter.innerHTML = '<option value="">Toutes les cartes</option>';
  const mapNames = [...new Set(Object.values(state.gamesById).map(g => g.map && g.map.name).filter(Boolean))].sort();
  mapNames.forEach(m=>{
    const opt = document.createElement('option');
    opt.value = m; opt.textContent = m;
    mapFilter.appendChild(opt);
  });
  mapFilter.value = current;
  mapFilter.onchange = renderList;
  document.getElementById('outcomeFilter').onchange = renderList;
}

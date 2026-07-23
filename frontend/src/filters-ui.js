import { state } from './state.js';
import { fmtDateShort } from './format.js';
import { persistUiPrefs } from './ui-prefs.js';
import { filteredGamesArray } from './game-filters.js';
import { computeSeasons, findSeason, displaySeasonId } from './seasons.js';
import { renderSummary } from './shell.js';
import { renderMapFilterOptions } from './player-index.js';
import { renderList } from './historique.js';
import { renderTrends } from './tendances.js';
import { renderProfil } from './profil/index.js';
import { renderComparatif } from './comparatif.js';
import { renderEquipes } from './equipes.js';

// ================= FILTRE DE SAISON : contrôles =================
// Reconstruit la liste d'options du sélecteur de saison à partir des captures de
// profil connues (voir seasons.js). Appelé au chargement des données et à chaque
// rerender du filtre pour garder l'option sélectionnée synchronisée.
export function renderSeasonFilterOptions() {
  const sel = document.getElementById('seasonFilter');
  if (!sel) return;
  const seasons = computeSeasons();
  const options = ['<option value="">Toutes les saisons</option>'];
  seasons.slice().reverse().forEach(s => {
    const startStr = s.startTs != null ? fmtDateShort(new Date(s.startTs).toISOString()) : '…';
    const range = s.isCurrent
      ? (s.startTs != null ? `en cours depuis le ${startStr}` : 'en cours')
      : `${startStr} → ${fmtDateShort(new Date(s.endTs).toISOString())}`;
    options.push(`<option value="${s.seasonId}">Saison ${displaySeasonId(s.seasonId)} (${range})</option>`);
  });
  sel.innerHTML = options.join('');
  sel.value = state.selectedSeasonId != null ? String(state.selectedSeasonId) : '';
}

document.getElementById('seasonFilter').addEventListener('change', (e) => {
  const raw = e.target.value;
  document.querySelectorAll('.range-presets button').forEach(b => b.classList.remove('active'));
  document.getElementById('rangeFrom').value = '';
  document.getElementById('rangeTo').value = '';
  if (!raw) {
    state.selectedSeasonId = null;
    state.dateRangeStart = null; state.dateRangeEnd = null;
    document.querySelector('.range-presets button[data-preset="all"]').classList.add('active');
  } else {
    // seasonId peut être numérique ou textuel selon le jeu : on retrouve la valeur
    // d'origine plutôt que de forcer un parseInt qui casserait un id non numérique.
    const seasons = computeSeasons();
    const match = seasons.find(s => String(s.seasonId) === raw);
    const seasonId = match ? match.seasonId : raw;
    state.selectedSeasonId = seasonId;
    const season = findSeason(seasons, seasonId);
    state.dateRangeStart = season ? season.startTs : null;
    state.dateRangeEnd = season ? season.endTs : null;
  }
  applyRangeAndRerender();
});

// ================= FILTRE DE PÉRIODE : contrôles =================
document.querySelectorAll('.range-presets button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-presets button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.selectedSeasonId = null;
    const preset = btn.dataset.preset;
    if (preset === 'all') {
      state.dateRangeStart = null; state.dateRangeEnd = null;
    } else {
      const days = parseInt(preset, 10);
      const now = Date.now();
      state.dateRangeEnd = now;
      state.dateRangeStart = now - days * 24 * 3600 * 1000;
    }
    document.getElementById('rangeFrom').value = '';
    document.getElementById('rangeTo').value = '';
    applyRangeAndRerender();
  });
});
document.getElementById('rangeApplyBtn').addEventListener('click', () => {
  const fromVal = document.getElementById('rangeFrom').value;
  const toVal = document.getElementById('rangeTo').value;
  state.selectedSeasonId = null;
  state.dateRangeStart = fromVal ? new Date(fromVal + 'T00:00:00').getTime() : null;
  state.dateRangeEnd = toVal ? new Date(toVal + 'T23:59:59').getTime() : null;
  document.querySelectorAll('.range-presets button').forEach(b => b.classList.remove('active'));
  applyRangeAndRerender();
});

// ================= EXCLUSION DE CARTES (ex: cartes mal étiquetées côté jeu) =================
document.getElementById('mapExcludeToggleBtn').addEventListener('click', () => {
  const panel = document.getElementById('mapExcludePanel');
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
});

// Construit le panneau d'exclusion de cartes/modes (une case à cocher par carte/mode déjà rencontré).
export function renderMapExcludePanel() {
  const panel = document.getElementById('mapExcludePanel');
  const mapNames = [...new Set(Object.values(state.gamesById).map(g => g.map && g.map.name).filter(Boolean))].sort();

  const modeMap = new Map(); // identifier -> category
  Object.values(state.gamesById).forEach(g => {
    const id = g.mode && g.mode.identifier;
    const cat = g.mode && g.mode.category;
    if (id && !modeMap.has(id)) modeMap.set(id, cat);
  });
  const modeEntries = [...modeMap.entries()].sort((a,b) => a[0].localeCompare(b[0]));

  if (!mapNames.length && !modeEntries.length) {
    panel.innerHTML = '<span style="color:var(--muted);font-size:12px;">Aucune donnée importée.</span>';
    return;
  }

  panel.innerHTML = `
    <div style="width:100%;">
      <div class="map-exclude-hint" style="margin-bottom:8px;"><strong style="color:var(--text);">Cartes</strong> — décoche pour exclure de toutes les analyses.</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
        ${mapNames.map(name => `
          <label class="map-chip ${state.excludedMaps.has(name) ? 'excluded' : ''}">
            <input type="checkbox" data-map="${name}" ${state.excludedMaps.has(name) ? '' : 'checked'}>
            ${name}
          </label>
        `).join('')}
      </div>
      <div class="map-exclude-hint" style="margin-bottom:8px;">
        <strong style="color:var(--text);">Modes de jeu</strong> — utile quand un mode PvE (co-op contre des vagues, etc.)
        réutilise le nom d'une carte PvP : décoche le <em>mode</em> plutôt que la carte pour ne retirer que ces parties-là.
        Les modes non-PvP sont exclus automatiquement à leur première apparition.
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${modeEntries.map(([id, cat]) => `
          <label class="map-chip ${state.excludedModes.has(id) ? 'excluded' : ''}">
            <input type="checkbox" data-mode="${id}" ${state.excludedModes.has(id) ? '' : 'checked'}>
            ${id}${cat && cat !== 'Pvp' ? ` <span style="color:var(--loss);">(${cat})</span>` : ''}
          </label>
        `).join('')}
      </div>
    </div>
  `;

  panel.querySelectorAll('input[data-map]').forEach(cb => {
    cb.addEventListener('change', () => {
      const name = cb.dataset.map;
      if (cb.checked) state.excludedMaps.delete(name); else state.excludedMaps.add(name);
      persistUiPrefs();
      renderMapExcludePanel();
      applyRangeAndRerender();
    });
  });
  panel.querySelectorAll('input[data-mode]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.mode;
      if (cb.checked) state.excludedModes.delete(id); else state.excludedModes.add(id);
      persistUiPrefs();
      renderMapExcludePanel();
      applyRangeAndRerender();
    });
  });
}

// Met à jour le texte "N partie(s) au total" au-dessus de la barre de filtres.
export function updateRangeInfo() {
  const el = document.getElementById('rangeInfo');
  if (!el) return;
  const total = Object.keys(state.gamesById).length;
  if (state.dateRangeStart == null && state.dateRangeEnd == null && state.excludedMaps.size === 0 && state.selectedSeasonId == null) {
    el.textContent = `${total} partie(s) au total`;
    return;
  }
  const inRangeCount = filteredGamesArray().length;
  const fromStr = state.dateRangeStart != null ? fmtDateShort(new Date(state.dateRangeStart).toISOString()) : '…';
  const toStr = state.dateRangeEnd != null ? fmtDateShort(new Date(state.dateRangeEnd).toISOString()) : '…';
  const seasonPart = state.selectedSeasonId != null ? ` · Saison ${displaySeasonId(state.selectedSeasonId)}` : '';
  const periodPart = (state.dateRangeStart != null || state.dateRangeEnd != null) ? ` · ${fromStr} → ${toStr}${seasonPart}` : seasonPart;
  const excludePart = state.excludedMaps.size ? ` · ${state.excludedMaps.size} carte(s) exclue(s)` : '';
  el.textContent = `${inRangeCount} / ${total} partie(s) prises en compte${periodPart}${excludePart}`;
}

// Recalcule la période sélectionnée (préréglage, saison ou dates personnalisées) et redessine l'onglet actif.
export function applyRangeAndRerender() {
  renderSeasonFilterOptions();
  updateRangeInfo();
  renderSummary();
  renderMapFilterOptions();
  renderList();
  state.activeGameId = null;
  document.getElementById('detail').innerHTML =
    '<div class="detail-empty">Sélectionne une partie à gauche pour voir le détail des scores.</div>';
  const activeBtn = document.querySelector('.tab-btn.active');
  const activeTab = activeBtn ? activeBtn.dataset.tab : 'historique';
  if (activeTab === 'tendances') renderTrends();
  if (activeTab === 'profil') renderProfil();
  if (activeTab === 'comparatif') renderComparatif();
  if (activeTab === 'equipes') renderEquipes();
}

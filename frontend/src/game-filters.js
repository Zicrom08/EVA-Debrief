import { state } from './state.js';
import { findPlayerInGame } from './format.js';

// ================= FILTRE DE PÉRIODE (s'applique à Historique / Tendances / Profil / Comparatif) =================
export function inDateRange(iso) {
  const t = new Date(iso).getTime();
  if (state.dateRangeStart != null && t < state.dateRangeStart) return false;
  if (state.dateRangeEnd != null && t > state.dateRangeEnd) return false;
  return true;
}
// Vrai si la carte de cette partie est dans la liste d'exclusion.
export function isMapExcluded(g) {
  const name = g.map && g.map.name;
  return !!name && state.excludedMaps.has(name);
}
// Vrai si le mode de cette partie est dans la liste d'exclusion.
export function isModeExcluded(g) {
  const id = g.mode && g.mode.identifier;
  return !!id && state.excludedModes.has(id);
}
// Filtre global de l'app : toutes les parties respectant la période sélectionnée et les exclusions de cartes/modes.
export function filteredGamesArray() {
  return Object.values(state.gamesById).filter(g => inDateRange(g.createdAt) && !isMapExcluded(g) && !isModeExcluded(g));
}
// Parties filtrées, restreintes au joueur sélectionné, triées de la plus récente à la plus ancienne (utilisé par l'Historique).
export function sortedGames() {
  return filteredGamesArray()
    .filter(g => findPlayerInGame(g, state.currentUid))
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Certains modes (ex: "Moon of the Dead", un mode PvE en co-op contre des vagues d'ennemis)
// réutilisent le même nom de carte qu'un mode PvP classique (ex: "Ceres"), ce qui rend le
// filtre par carte insuffisant pour les séparer. On les distingue donc par mode de jeu, et on
// exclut automatiquement les modes non-PvP (catégorie différente de "Pvp") la première fois
// qu'ils apparaissent, car leur structure de score (équipe unique, vagues, etc.) n'est pas
// comparable aux parties PvP Alliance/Rebels. L'utilisateur peut les réintégrer manuellement.
export function ensureModeDefaults() {
  const seen = new Map(); // identifier -> category
  Object.values(state.gamesById).forEach(g => {
    const id = g.mode && g.mode.identifier;
    const cat = g.mode && g.mode.category;
    if (id && !seen.has(id)) seen.set(id, cat);
  });
  let changed = false;
  seen.forEach((cat, id) => {
    if (!state.knownModes.has(id)) {
      state.knownModes.add(id);
      if (cat && cat !== 'Pvp') { state.excludedModes.add(id); changed = true; }
    }
  });
  return changed;
}

// Parties filtrées pour un joueur donné, triées chronologiquement (plus ancienne en premier) — utilisé pour les graphiques de progression.
export function gamesForPlayerSorted(uid) {
  return filteredGamesArray()
    .filter(g => findPlayerInGame(g, uid))
    .slice()
    .sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
}

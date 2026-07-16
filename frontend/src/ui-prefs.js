import { state } from './state.js';

// Les données elles-mêmes (parties, profils, équipes) vivent côté serveur (voir
// backend/server.js / backend/db.js) — donc partagées entre tous les navigateurs/appareils
// qui pointent vers ce serveur, et survivent à un vidage de cache. Seules quelques
// préférences d'affichage sans enjeu (joueur sélectionné, cartes/modes exclus, équipes
// choisies pour comparaison) restent en local à ce navigateur, pour plus de confort
// au rechargement.
const UI_PREFS_KEY = 'eva_ui_prefs_v1';

// Sauvegarde les préférences d'affichage (joueur sélectionné, filtres...) dans le localStorage du navigateur — les données elles-mêmes vivent sur le serveur, ceci ne concerne que le confort d'affichage.
export function persistUiPrefs() {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({
      currentUid: state.currentUid,
      excludedMaps: Array.from(state.excludedMaps),
      excludedModes: Array.from(state.excludedModes),
      knownModes: Array.from(state.knownModes),
      teamAId: state.teamAId, teamBId: state.teamBId, profileCompareUid: state.profileCompareUid,
    }));
    state.storageAvailable = true;
  } catch (e) {
    state.storageAvailable = false;
  }
}
// Recharge les préférences d'affichage sauvegardées au démarrage.
export function restoreUiPrefs() {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state.currentUid = saved.currentUid || null;
    state.excludedMaps = new Set(saved.excludedMaps || []);
    state.excludedModes = new Set(saved.excludedModes || []);
    state.knownModes = new Set(saved.knownModes || []);
    state.teamAId = saved.teamAId || null;
    state.teamBId = saved.teamBId || null;
    state.profileCompareUid = saved.profileCompareUid || null;
  } catch (e) { /* préférences perdues, pas grave */ }
}
// Efface les préférences d'affichage locales (utilisé par le bouton Réinitialiser).
export function clearUiPrefs() {
  try { localStorage.removeItem(UI_PREFS_KEY); } catch (e) {}
}

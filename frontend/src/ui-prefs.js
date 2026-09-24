import { state } from './state.js';

// Les données elles-mêmes (parties, profils, équipes) vivent côté serveur (voir
// backend/server.js / backend/db.js) — donc partagées entre tous les navigateurs/appareils
// qui pointent vers ce serveur, et survivent à un vidage de cache. Seules quelques
// préférences d'affichage sans enjeu (joueur sélectionné, cartes/modes exclus, équipes
// choisies pour comparaison) restent en local à ce navigateur, pour plus de confort
// au rechargement.
const UI_PREFS_KEY = 'eva_ui_prefs_v1';

// Distingue une VRAIE connexion (login.html a redirigé vers l'app après un /api/login,
// /api/setup ou /api/register réussi — voir login.js::markJustLoggedIn()) d'un simple
// rafraîchissement de la page déjà connectée (F5) : le joueur sélectionné doit repartir de
// zéro seulement dans le premier cas, être restauré normalement dans le second. sessionStorage
// (pas localStorage) : ce flag ne doit survivre qu'à la PROCHAINE lecture, jamais persister au
// point de fausser un rafraîchissement ultérieur — consommé (retiré) dès sa lecture ci-dessous.
const JUST_LOGGED_IN_KEY = 'eva_just_logged_in';
export function markJustLoggedIn() {
  try { sessionStorage.setItem(JUST_LOGGED_IN_KEY, '1'); } catch (e) { /* tant pis, repli sur le comportement "rafraîchissement" */ }
}
function consumeJustLoggedIn() {
  try {
    const wasSet = sessionStorage.getItem(JUST_LOGGED_IN_KEY) === '1';
    sessionStorage.removeItem(JUST_LOGGED_IN_KEY);
    return wasSet;
  } catch (e) { return false; }
}

// Sauvegarde les préférences d'affichage (joueur sélectionné, filtres...) dans le
// localStorage du navigateur — les données elles-mêmes vivent sur le serveur, ceci ne
// concerne que le confort d'affichage.
export function persistUiPrefs() {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({
      currentUid: state.currentUid,
      excludedMaps: Array.from(state.excludedMaps),
      excludedModes: Array.from(state.excludedModes),
      knownModes: Array.from(state.knownModes),
      knownMaps: Array.from(state.knownMaps),
      teamAId: state.teamAId, teamBId: state.teamBId, profileCompareUid: state.profileCompareUid,
    }));
    state.storageAvailable = true;
  } catch (e) {
    state.storageAvailable = false;
  }
}
// Recharge les préférences d'affichage sauvegardées au démarrage — currentUid excepté juste
// après une vraie connexion (voir consumeJustLoggedIn() ci-dessus), pour repartir de zéro à
// ce moment précis seulement, jamais à un simple rafraîchissement de la page.
export function restoreUiPrefs() {
  const justLoggedIn = consumeJustLoggedIn();
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!justLoggedIn) state.currentUid = saved.currentUid || null;
    state.excludedMaps = new Set(saved.excludedMaps || []);
    state.excludedModes = new Set(saved.excludedModes || []);
    state.knownModes = new Set(saved.knownModes || []);
    state.knownMaps = new Set(saved.knownMaps || []);
    state.teamAId = saved.teamAId || null;
    state.teamBId = saved.teamBId || null;
    state.profileCompareUid = saved.profileCompareUid || null;
  } catch (e) { /* préférences perdues, pas grave */ }
}
// Efface les préférences d'affichage locales (utilisé par le bouton Réinitialiser).
export function clearUiPrefs() {
  try { localStorage.removeItem(UI_PREFS_KEY); } catch (e) {}
}

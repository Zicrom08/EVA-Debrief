// URL de base de l'API — vide par défaut (déploiement même-origine, comportement inchangé
// pour `npm start`/`npm run dev` : le backend sert le frontend lui-même). Définie au build
// via VITE_API_BASE_URL (injectée par la GitHub Action, voir .github/workflows/) quand le
// frontend est hébergé ailleurs que le backend (ex: GitHub Pages) — voir aussi CORS_ORIGIN
// côté backend/server.js, sans lequel ces requêtes cross-origin seraient bloquées.
// `import.meta.env` n'existe QUE sous Vite (dev server / build) — `?.` le rend sûr sous
// Node tout court : api.js est atteint par la suite de tests via player-links.js (import
// apiSend) -> format.js (canonicalUid), donc ce fichier doit rester chargeable hors Vite.
export const API_BASE = import.meta.env?.VITE_API_BASE_URL || '';

// Concatène API_BASE devant un chemin d'API (ex: apiUrl('/api/state')). En déploiement
// même-origine (API_BASE vide), renvoie le chemin tel quel.
export function apiUrl(path) {
  return API_BASE + path;
}

// Racine de l'app côté navigateur — '/' par défaut, ou le sous-dossier du site de projet
// GitHub Pages (ex: '/EVA-Debrief/', voir vite.config.js/VITE_BASE_PATH). Vite garantit un
// slash de fin sur BASE_URL. `?.` par sécurité hors Vite (voir API_BASE ci-dessus, même
// raison : api.js est atteint par les tests via player-links.js -> format.js).
export const BASE_PATH = import.meta.env?.BASE_URL || '/';

// Construit une URL vers une page statique de CET hébergeur (login.html, la racine de
// l'app...), PAS vers l'API (voir apiUrl ci-dessus pour ça). `path` sans slash de tête, ex:
// pageUrl('login.html') -> '/login.html' en déploiement racine, '/EVA-Debrief/login.html'
// sur un site de projet GitHub Pages. Un window.location.href = '/login.html' codé en dur
// casserait sur ce dernier cas (résolu contre la racine du DOMAINE, pas celle de l'app).
export function pageUrl(path) {
  return BASE_PATH + path;
}

// Vrai en déploiement cross-origin (API_BASE défini, ex: frontend sur GitHub Pages, backend
// ailleurs). Dans ce cas, l'authentification passe par un jeton (en-tête Authorization +
// localStorage) plutôt que par le cookie de session HttpOnly : Safari (ITP, "Empêcher la
// navigation intersite", activé par défaut) bloque silencieusement tout cookie posé par une
// requête cross-site, même SameSite=None; Secure — bug réel constaté (boucle de connexion
// sur mobile iOS, fonctionnait sur desktop). En déploiement même-origine (API_BASE vide),
// le cookie HttpOnly reste utilisé tel quel : aucune politique de cookie cross-site ne
// s'applique, et il reste plus sûr qu'un jeton en localStorage (invisible au JS de la page,
// donc insensible à un vol par XSS — voir backend/auth.js::bearerToken()).
export const CROSS_ORIGIN = !!API_BASE;

const AUTH_TOKEN_KEY = 'eva_auth_token';

// getAuthToken()/setAuthToken()/clearAuthToken() sont des no-op en déploiement même-origine
// (CROSS_ORIGIN false) : le cookie suffit déjà, pas la peine de dupliquer le jeton dans
// localStorage pour un cas qui n'en a pas besoin.
export function getAuthToken() {
  return CROSS_ORIGIN ? localStorage.getItem(AUTH_TOKEN_KEY) : null;
}
export function setAuthToken(token) {
  if (CROSS_ORIGIN && token) localStorage.setItem(AUTH_TOKEN_KEY, token);
}
export function clearAuthToken() {
  if (CROSS_ORIGIN) localStorage.removeItem(AUTH_TOKEN_KEY);
}

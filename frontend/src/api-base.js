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

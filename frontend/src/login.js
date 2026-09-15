// ============================================================================
// Logique de la page de connexion (login.html) — module externe plutôt
// qu'un <script> inline, pour permettre une Content-Security-Policy sans
// 'unsafe-inline' sur script-src (voir backend/server.js).
// ============================================================================

import { apiUrl, pageUrl, setAuthToken } from './api-base.js';
import { safeNextPath } from './safe-redirect.js';
import { markJustLoggedIn } from './ui-prefs.js';

const form = document.getElementById('loginForm');
const btn = document.getElementById('loginBtn');
const errEl = document.getElementById('loginError');
const introEl = document.getElementById('loginIntro');
const usernameInput = document.getElementById('username');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const confirmInput = document.getElementById('passwordConfirm');
const toggleLink = document.getElementById('toggleModeLink');

let mode = 'login'; // 'login' | 'setup' | 'register'
let registrationEnabled = false;

function idleButtonText() {
  if (mode === 'setup') return 'Créer le compte administrateur';
  if (mode === 'register') return 'Créer mon compte';
  return 'Se connecter';
}

// Affiche/masque les champs et le lien de bascule selon le mode courant.
function updateFieldsForMode() {
  const isSetup = mode === 'setup';
  const isRegister = mode === 'register';
  introEl.textContent = isSetup
    ? 'Aucun compte n\'existe encore — crée le compte administrateur'
    : isRegister
      ? 'Crée ton compte (accès en lecture seule au départ)'
      : 'Connecte-toi pour accéder au site';
  emailInput.style.display = isRegister ? 'block' : 'none';
  confirmInput.style.display = (isSetup || isRegister) ? 'block' : 'none';
  passwordInput.setAttribute('autocomplete', (isSetup || isRegister) ? 'new-password' : 'current-password');
  btn.textContent = idleButtonText();
  if (!isSetup && registrationEnabled) {
    toggleLink.style.display = 'block';
    toggleLink.textContent = isRegister ? 'Déjà un compte ? Se connecter' : 'Pas de compte ? Crée-en un';
  } else {
    toggleLink.style.display = 'none';
  }
}

toggleLink.addEventListener('click', () => {
  mode = mode === 'register' ? 'login' : 'register';
  errEl.textContent = '';
  form.reset();
  updateFieldsForMode();
  usernameInput.focus();
});

// Détermine le mode initial : connexion classique, création du tout premier
// compte (aucun utilisateur en base), ou si l'inscription publique est ouverte
// (voir /api/auth-status).
(async () => {
  try {
    const res = await fetch(apiUrl('/api/auth-status'), { credentials: 'include' });
    const status = await res.json();
    registrationEnabled = !!status.registrationEnabled;
    mode = status.hasUsers ? 'login' : 'setup';
  } catch (e) { /* en cas d'échec, on part du principe qu'il faut se connecter */ }
  updateFieldsForMode();
  form.style.display = 'block';
  usernameInput.focus();
})();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errEl.textContent = '';
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if ((mode === 'setup' || mode === 'register') && password !== confirmInput.value) {
    errEl.textContent = 'Les mots de passe ne correspondent pas.';
    return;
  }
  const body = { username, password };
  if (mode === 'register') {
    body.email = emailInput.value.trim();
  }
  const endpoint = mode === 'setup' ? '/api/setup' : mode === 'register' ? '/api/register' : '/api/login';
  btn.disabled = true;
  btn.textContent = mode === 'login' ? 'Connexion…' : 'Création…';
  try {
    const res = await fetch(apiUrl(endpoint), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      errEl.textContent = j.error || 'Erreur.';
      btn.disabled = false;
      btn.textContent = idleButtonText();
      return;
    }
    // Stocke le jeton renvoyé par le serveur (voir backend/server.js) — no-op en
    // déploiement même-origine (setAuthToken() ne fait rien tant que CROSS_ORIGIN est faux),
    // seul un frontend cross-origin (GitHub Pages) s'en sert réellement (cookie peu fiable
    // sur Safari mobile, voir api-base.js::CROSS_ORIGIN).
    const data = await res.json().catch(() => ({}));
    if (data.token) setAuthToken(data.token);
    // redirige vers la page demandée à l'origine si connue et sûre (voir safeNextPath()
    // ci-dessus — next vient de l'URL, jamais fait confiance tel quel), sinon la racine de
    // l'app (pageUrl(''), jamais '/' en dur — casserait sur un site de projet GitHub Pages,
    // servi sous /<repo>/)
    const params = new URLSearchParams(window.location.search);
    // Marque une VRAIE connexion (pas un simple rafraîchissement de l'app déjà ouverte) —
    // voir ui-prefs.js::restoreUiPrefs() : c'est ce qui fait repartir le joueur sélectionné
    // à zéro seulement à ce moment précis, jamais à un rechargement de page ordinaire.
    markJustLoggedIn();
    window.location.href = safeNextPath(params.get('next')) || pageUrl('');
  } catch (err) {
    errEl.textContent = 'Erreur de connexion au serveur.';
    btn.disabled = false;
    btn.textContent = idleButtonText();
  }
});

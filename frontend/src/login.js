// ============================================================================
// Logique de la page de connexion (login.html) — module externe plutôt
// qu'un <script> inline, pour permettre une Content-Security-Policy sans
// 'unsafe-inline' sur script-src (voir backend/server.js).
// ============================================================================

const form = document.getElementById('loginForm');
const btn = document.getElementById('loginBtn');
const errEl = document.getElementById('loginError');
const introEl = document.getElementById('loginIntro');
const usernameInput = document.getElementById('username');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const confirmInput = document.getElementById('passwordConfirm');
const turnstileContainer = document.getElementById('turnstileContainer');
const toggleLink = document.getElementById('toggleModeLink');

let mode = 'login'; // 'login' | 'setup' | 'register'
let registrationEnabled = false;
let turnstileSiteKey = null;
let turnstileWidgetId = null;
let turnstileScriptLoading = null;

// Charge le script Turnstile une seule fois, seulement quand on en a besoin
// (mode inscription) — inutile de l'imposer aux visiteurs qui se connectent.
function ensureTurnstileLoaded() {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptLoading) return turnstileScriptLoading;
  turnstileScriptLoading = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    s.async = true; s.defer = true;
    s.onload = () => resolve();
    document.head.appendChild(s);
  });
  return turnstileScriptLoading;
}

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
  turnstileContainer.style.display = isRegister ? 'flex' : 'none';
  passwordInput.setAttribute('autocomplete', (isSetup || isRegister) ? 'new-password' : 'current-password');
  btn.textContent = idleButtonText();
  if (!isSetup && registrationEnabled) {
    toggleLink.style.display = 'block';
    toggleLink.textContent = isRegister ? 'Déjà un compte ? Se connecter' : 'Pas de compte ? Crée-en un';
  } else {
    toggleLink.style.display = 'none';
  }
  if (isRegister) {
    ensureTurnstileLoaded().then(() => {
      if (turnstileWidgetId == null) {
        turnstileWidgetId = turnstile.render(turnstileContainer, { sitekey: turnstileSiteKey });
      }
    });
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
// (Turnstile configuré côté serveur — voir /api/auth-status).
(async () => {
  try {
    const res = await fetch('/api/auth-status');
    const status = await res.json();
    registrationEnabled = !!status.registrationEnabled;
    turnstileSiteKey = status.turnstileSiteKey || null;
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
    body.turnstileToken = (window.turnstile && turnstileWidgetId != null) ? turnstile.getResponse(turnstileWidgetId) : '';
    if (!body.turnstileToken) {
      errEl.textContent = 'Complète la vérification anti-robot.';
      return;
    }
  }
  const endpoint = mode === 'setup' ? '/api/setup' : mode === 'register' ? '/api/register' : '/api/login';
  btn.disabled = true;
  btn.textContent = mode === 'login' ? 'Connexion…' : 'Création…';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      errEl.textContent = j.error || 'Erreur.';
      btn.disabled = false;
      btn.textContent = idleButtonText();
      if (mode === 'register' && window.turnstile && turnstileWidgetId != null) turnstile.reset(turnstileWidgetId);
      return;
    }
    // redirige vers la page demandée à l'origine si connue, sinon l'accueil
    const params = new URLSearchParams(window.location.search);
    window.location.href = params.get('next') || '/';
  } catch (err) {
    errEl.textContent = 'Erreur de connexion au serveur.';
    btn.disabled = false;
    btn.textContent = idleButtonText();
  }
});

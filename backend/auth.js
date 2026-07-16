// ============================================================================
// Authentification minimale par mot de passe partagé.
//
// Volontairement simple : un seul mot de passe (pas de comptes utilisateurs),
// stocké en variable d'environnement (jamais dans le code ni dans data.json),
// comparé en temps constant, et une session par cookie signé aléatoirement
// (pas de dépendance externe type express-session/cookie-parser — juste
// `crypto`, qui fait partie de Node).
//
// Si EVA_PASSWORD n'est pas défini, le site reste accessible sans mot de
// passe (avec un avertissement bien visible au démarrage) — pratique en
// développement local, mais à éviter en production.
// ============================================================================

const crypto = require('crypto');

const SESSION_COOKIE = 'eva_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

// Sessions valides en mémoire : token -> date d'expiration (ms epoch).
// Un redémarrage du serveur déconnecte tout le monde (comportement acceptable
// pour cet usage — pas besoin de persister les sessions sur disque).
const sessions = new Map();

// Lit le mot de passe depuis l'environnement — jamais stocké ailleurs (pas de fichier, pas de base).
function getConfiguredPassword() {
  const pwd = process.env.EVA_PASSWORD;
  return pwd && pwd.length ? pwd : null;
}

// Vrai si un mot de passe est configuré, donc si le site doit exiger une connexion.
function isProtected() {
  return getConfiguredPassword() !== null;
}

// Comparaison en temps constant, y compris quand les longueurs diffèrent
// (sinon la durée de la comparaison fuite indirectement la longueur du
// mot de passe correct).
function checkPassword(candidate) {
  const real = getConfiguredPassword();
  if (!real) return true; // pas de protection configurée
  const a = Buffer.from(String(candidate ?? ''));
  const b = Buffer.from(String(real));
  if (a.length !== b.length) {
    crypto.timingSafeEqual(Buffer.alloc(b.length), Buffer.alloc(b.length));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// Ouvre une nouvelle session : un jeton aléatoire (256 bits), gardé en mémoire avec sa date d'expiration.
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

// Vérifie qu'un jeton de session existe encore et n'a pas expiré (et le nettoie si expiré).
function isValidSession(token) {
  if (!token) return false;
  const expires = sessions.get(token);
  if (!expires) return false;
  if (Date.now() > expires) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// Invalide une session (déconnexion).
function destroySession(token) {
  if (token) sessions.delete(token);
}

// Parse l'en-tête HTTP "Cookie" en objet { nom: valeur } — pas de dépendance
// externe (cookie-parser) pour rester avec un minimum de dépendances npm.
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    try { out[key] = decodeURIComponent(val); } catch (e) { out[key] = val; }
  });
  return out;
}

// Construit l'en-tête Set-Cookie de la session : HttpOnly (inaccessible en JS,
// protège du vol par script malveillant) et Secure automatiquement dès que la
// requête est en HTTPS (détecté nativement ou via X-Forwarded-Proto derrière un proxy).
function sessionCookieHeader(token, req, maxAgeSeconds) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps) parts.push('Secure');
  return parts.join('; ');
}

module.exports = {
  SESSION_COOKIE,
  isProtected,
  checkPassword,
  createSession,
  isValidSession,
  destroySession,
  parseCookies,
  sessionCookieHeader,
};

// ============================================================================
// Authentification par comptes individuels avec rôles.
//
// Comptes stockés dans data.json (voir db.js — table `users`), mot de passe
// jamais en clair : haché avec crypto.scrypt (sel aléatoire par compte).
// Session par cookie signé aléatoirement (pas de dépendance externe type
// express-session/cookie-parser — juste `crypto`, qui fait partie de Node).
//
// Rôles : 'admin' (tout, y compris reset et gestion des comptes/équipes),
// 'contributor' (peut importer des données en plus de consulter, mais ne
// touche ni aux équipes, ni au reset, ni aux comptes) et 'readonly'
// (consultation seule). Le rôle est mis en cache dans la session en mémoire
// pour éviter un lookup en base à chaque requête ; il est rafraîchi en
// détruisant les sessions concernées quand un admin change un rôle/mot de
// passe (voir destroySessionsForUser).
// ============================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_COOKIE = 'eva_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours
const ROLES = ['admin', 'contributor', 'readonly'];

// ================= PERSISTANCE DES SESSIONS =================
// Vivaient auparavant SEULEMENT en mémoire : un redémarrage du serveur (déploiement, crash,
// reboot) déconnectait tout le monde d'un coup, même en pleine utilisation — gênant dès que
// le service redémarre plus qu'occasionnellement. Persistées dans un fichier À PART de
// data.json/users.json (SESSIONS_DATA_DIR retombe sur DATA_DIR par défaut, comme
// USERS_DATA_DIR dans db.js) : un jeton de session volé donne un accès complet SANS mot de
// passe, c'est une donnée au moins aussi sensible qu'un hash de mot de passe — jamais mêlée
// aux autres fichiers, mêmes enjeux de permissions restrictives que users.json.
//
// Écriture atomique (tmp + rename) à chaque mutation, même raison que makePersister() dans
// db.js : jamais de fichier à moitié écrit si le process est tué en pleine écriture.
const SESSIONS_DATA_DIR = process.env.SESSIONS_DATA_DIR || process.env.DATA_DIR || path.join(__dirname, '..');
const SESSIONS_FILE = path.join(SESSIONS_DATA_DIR, process.env.SESSIONS_DATA_FILE || 'sessions.json');

// Ignore un fichier illisible/corrompu plutôt que de faire planter le démarrage — dans le
// pire cas, tout le monde doit juste se reconnecter, comme avant cette fonctionnalité.
function loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return new Map();
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    if (!raw.trim()) return new Map();
    const parsed = JSON.parse(raw);
    const now = Date.now();
    // Jamais recharger une session déjà expirée entre-temps (serveur resté éteint plus
    // longtemps que SESSION_TTL_MS) — sinon le fichier accumule indéfiniment de vieilles
    // entrées mortes que rien ne purge jamais.
    return new Map(Object.entries(parsed).filter(([, s]) => s && s.expires > now));
  } catch (e) {
    console.error('[auth] Impossible de lire', SESSIONS_FILE, '—', e.message);
    return new Map();
  }
}

function persistSessions() {
  try {
    const tmpFile = SESSIONS_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(Object.fromEntries(sessions)));
    fs.renameSync(tmpFile, SESSIONS_FILE);
  } catch (e) {
    console.error('[auth] Impossible d\'écrire', SESSIONS_FILE, '—', e.message);
  }
}

// Sessions valides : token -> { userId, role, expires } — voir la persistance ci-dessus.
const sessions = loadSessions();

// Hache un mot de passe avec un sel aléatoire (scrypt — pas de dépendance
// externe type bcrypt, `crypto` fait déjà tout ce qu'il faut).
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

// Comparaison en temps constant, y compris quand les longueurs diffèrent
// (sinon la durée de la comparaison fuite indirectement la longueur du
// mot de passe correct).
function verifyPassword(candidate, salt, hash) {
  const candidateHash = crypto.scryptSync(String(candidate ?? ''), salt, 64);
  const realHash = Buffer.from(hash, 'hex');
  if (candidateHash.length !== realHash.length) return false;
  return crypto.timingSafeEqual(candidateHash, realHash);
}

// Ouvre une nouvelle session : un jeton aléatoire (256 bits), gardé en mémoire
// avec l'utilisateur et le rôle au moment de la connexion.
function createSession(userId, role) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, role, expires: Date.now() + SESSION_TTL_MS });
  persistSessions();
  return token;
}

// Renvoie { userId, role } si le jeton est valide et non expiré, sinon null
// (et nettoie la session si elle est expirée).
function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expires) {
    sessions.delete(token);
    persistSessions();
    return null;
  }
  return session;
}

// Invalide une session précise (déconnexion).
function destroySession(token) {
  if (token && sessions.delete(token)) persistSessions();
}

// Invalide toutes les sessions d'un utilisateur — appelé quand un admin change
// son rôle/mot de passe ou supprime son compte, pour ne pas laisser une
// session déjà ouverte agir avec des droits obsolètes.
function destroySessionsForUser(userId) {
  let changed = false;
  for (const [token, session] of sessions) {
    if (session.userId === userId) { sessions.delete(token); changed = true; }
  }
  if (changed) persistSessions();
}

// ================= LIMITATION DES TENTATIVES DE CONNEXION (anti brute-force) =================
// Rien n'existait avant pour ça (voir la section Sécurité du README) : un bot pouvait
// essayer autant de mots de passe qu'il voulait sur /api/login. Compteur en mémoire par IP
// (voir clientIp() dans server.js — la vraie IP du client, jamais une valeur que lui-même
// pourrait falsifier sans un reverse proxy de confiance en amont). Se remet à zéro tout seul
// dès qu'aucun échec n'est survenu depuis LOGIN_RATE_LIMIT_MINUTES : pas de purge périodique
// nécessaire, même logique paresseuse que getSession() ci-dessus pour les sessions expirées.
//
// Lus à CHAQUE appel plutôt que figés dans des constantes au chargement du module (comme
// sessionCookieHeader() lit process.env.CORS_ORIGIN dynamiquement) : les tests peuvent ainsi
// ajuster ces seuils par cas sans avoir à recharger le module.
function loginRateLimitConfig() {
  return {
    max: Number(process.env.LOGIN_RATE_LIMIT_MAX) || 5,
    windowMs: (Number(process.env.LOGIN_RATE_LIMIT_MINUTES) || 15) * 60 * 1000,
  };
}

const loginAttempts = new Map(); // ip -> { count, windowStart, lockedUntil }

// À vérifier AVANT de tenter de vérifier le mot de passe (server.js) — pour ne même pas
// lancer verifyPassword() (scrypt, volontairement coûteux, voir hashPassword ci-dessus) une
// fois l'IP bloquée. Renvoie { locked: false } ou { locked: true, retryAfterSeconds }.
function loginRateLimitStatus(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || !entry.lockedUntil) return { locked: false };
  const now = Date.now();
  if (now >= entry.lockedUntil) {
    loginAttempts.delete(ip); // fenêtre de blocage expirée, repart de zéro
    return { locked: false };
  }
  return { locked: true, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000) };
}

// Appelé sur un échec (mauvais username/mot de passe) — incrémente le compteur de cette IP ;
// verrouille pour LOGIN_RATE_LIMIT_MINUTES une fois LOGIN_RATE_LIMIT_MAX échecs atteints DANS
// cette même fenêtre (pas un compteur qui ne redescend jamais une fois lancé).
function recordLoginFailure(ip) {
  const { max, windowMs } = loginRateLimitConfig();
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > windowMs) {
    entry = { count: 0, windowStart: now, lockedUntil: 0 };
  }
  entry.count += 1;
  if (entry.count >= max) entry.lockedUntil = now + windowMs;
  loginAttempts.set(ip, entry);
}

// Appelé sur une connexion réussie — un compte qui vient de prouver son mot de passe ne doit
// pas rester pénalisé par des échecs précédents (ex: l'utilisateur lui-même s'est trompé deux
// fois avant de retrouver son mot de passe).
function recordLoginSuccess(ip) {
  loginAttempts.delete(ip);
}

// Jeton porté par l'en-tête "Authorization: Bearer <jeton>" plutôt que par un cookie —
// utilisé par le frontend en déploiement cross-origin (ex: GitHub Pages + backend sur un
// autre domaine, voir frontend/src/api-base.js::CROSS_ORIGIN). Safari (ITP, réglage
// "Empêcher la navigation intersite", activé par défaut) bloque silencieusement tout cookie
// posé par une requête cross-site, MÊME avec SameSite=None; Secure (bug réel constaté :
// connexion en boucle sur mobile iOS alors que la même app fonctionne normalement sur
// desktop) — un jeton transporté par un en-tête n'est soumis à aucune politique de cookie
// du navigateur, donc insensible à ce blocage. Même magasin de sessions que le cookie (voir
// createSession/getSession ci-dessus) : c'est uniquement le TRANSPORT qui diffère, jamais
// les deux à la fois pour une même requête (server.js essaie l'un puis l'autre).
function bearerToken(req) {
  const header = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(header);
  return m ? m[1] : null;
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
// SameSite=Lax par défaut (suffit pour un frontend servi par ce backend lui-même) ; passe
// à SameSite=None dès que CORS_ORIGIN est défini (voir server.js) — un frontend hébergé
// ailleurs (ex: GitHub Pages) envoie ses requêtes en cross-site, et un cookie SameSite=Lax
// n'y est jamais inclus. SameSite=None EXIGE Secure (sinon le navigateur rejette
// silencieusement le cookie) — forcé dans ce cas même si isHttps n'est pas détecté sur CETTE
// requête précise, puisque CORS_ORIGIN implique déjà un déploiement HTTPS des deux côtés.
function sessionCookieHeader(token, req, maxAgeSeconds) {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const crossOrigin = !!process.env.CORS_ORIGIN;
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${crossOrigin ? 'None' : 'Lax'}`,
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps || crossOrigin) parts.push('Secure');
  return parts.join('; ');
}

module.exports = {
  SESSION_COOKIE,
  ROLES,
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  destroySession,
  destroySessionsForUser,
  loginRateLimitStatus,
  recordLoginFailure,
  recordLoginSuccess,
  bearerToken,
  parseCookies,
  sessionCookieHeader,
};

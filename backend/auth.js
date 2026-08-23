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

const SESSION_COOKIE = 'eva_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours
const ROLES = ['admin', 'contributor', 'readonly'];

// Sessions valides en mémoire : token -> { userId, role, expires }.
// Un redémarrage du serveur déconnecte tout le monde (comportement acceptable
// pour cet usage — pas besoin de persister les sessions sur disque).
const sessions = new Map();

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
    return null;
  }
  return session;
}

// Invalide une session précise (déconnexion).
function destroySession(token) {
  if (token) sessions.delete(token);
}

// Invalide toutes les sessions d'un utilisateur — appelé quand un admin change
// son rôle/mot de passe ou supprime son compte, pour ne pas laisser une
// session déjà ouverte agir avec des droits obsolètes.
function destroySessionsForUser(userId) {
  for (const [token, session] of sessions) {
    if (session.userId === userId) sessions.delete(token);
  }
}

// Invalide TOUTES les sessions — appelé après restauration d'un backup de comptes
// (db.restoreBackup(), voir server.js) : les userId encore en mémoire peuvent ne plus
// exister (ou plus avoir le même rôle) dans le users.json qui vient d'être restauré,
// donc aucune session ouverte ne doit survivre à ce remplacement complet.
function destroyAllSessions() {
  sessions.clear();
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
  destroyAllSessions,
  bearerToken,
  parseCookies,
  sessionCookieHeader,
};

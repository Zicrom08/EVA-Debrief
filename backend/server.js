// ============================================================================
// Serveur EVA Debrief — historique de parties + stats de saison + équipes
//
// Sert le frontend buildé (../frontend/dist, généré par `npm run build` — voir
// frontend/vite.config.js) et expose une API qui centralise l'import, la
// déduplication et le stockage des données. Toute la logique d'analyse
// (tendances, profils, comparatifs, équipes) reste côté navigateur, ce
// serveur ne fait que stocker/servir les données brutes de façon fiable.
//
// En développement, ne pas ouvrir ce serveur directement dans le navigateur :
// utiliser le serveur de dev Vite (`npm run dev`, port 5173 par défaut), qui
// sert le frontend depuis les sources avec rechargement à chaud et proxifie
// les appels /api/* vers ce serveur. `frontend/dist` n'existe que si
// `npm run build` a déjà été lancé au moins une fois.
// ============================================================================

const path = require('path');
require('./env').loadEnvFile(path.join(__dirname, '..', '.env'));

const express = require('express');
const db = require('./db');
const auth = require('./auth');

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend', 'dist');

const app = express();

// En-têtes de sécurité, posés sur TOUTE réponse (avant les routes) — API
// comme pages HTML/assets statiques.
//
// - style-src garde 'unsafe-inline' : le frontend génère énormément de HTML
//   via innerHTML avec des attributs style="..." (comptes.js, equipes.js,
//   shell.js, profil/*...) — retirer 'unsafe-inline' casserait leur mise en
//   forme. C'est un compromis assumé (l'injection de <style>/style="" est un
//   risque bien moindre que l'exécution de script, seule à réellement
//   permettre le vol de session/données — voir script-src ci-dessous, lui
//   sans 'unsafe-inline').
// - script-src/frame-src autorisent challenges.cloudflare.com : c'est le
//   widget Turnstile de la page d'inscription (voir /api/register et
//   frontend/src/login.js) — script + iframe qu'il charge lui-même.
// - frame-ancestors 'none' + X-Frame-Options: DENY : ce site n'a jamais
//   besoin d'être affiché dans une <iframe>, ni par lui-même ni ailleurs.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "connect-src 'self'",
  "frame-src https://challenges.cloudflare.com",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CSP);
  next();
});

// CORS — seulement si CORS_ORIGIN est défini (frontend hébergé ailleurs que ce backend,
// ex: GitHub Pages, voir README). Aucune dépendance ajoutée (comme parseCookies dans
// auth.js) : quelques en-têtes suffisent. Jamais `*` en Allow-Origin dès qu'on pose
// Allow-Credentials — la spec CORS l'interdit — donc on reflète l'Origin de la requête
// UNIQUEMENT si elle figure dans la liste autorisée. CORS_ORIGIN accepte plusieurs
// origines séparées par des virgules (ex: GitHub Pages + un domaine perso plus tard).
// Voir aussi sessionCookieHeader() dans auth.js : CORS_ORIGIN bascule aussi le cookie de
// session en SameSite=None (obligatoire pour qu'il parte sur une requête cross-site).
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
if (CORS_ORIGINS.length) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && CORS_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      // Authorization : indispensable pour le jeton de session cross-origin (voir
      // auth.bearerToken() et frontend/src/api-base.js::CROSS_ORIGIN) — sans elle, le
      // navigateur bloque la requête au stade du preflight, avant même qu'elle ne parte.
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

app.use(express.json({ limit: '100mb' })); // les exports d'historique complets peuvent être volumineux

// ---------------------------------------------------------------------------
// Authentification par comptes individuels avec rôles (voir auth.js + db.js).
// Placée tout en haut : tout ce qui suit (API + fichiers statiques) passe
// par cette porte, sauf la page de connexion elle-même et les quelques
// endpoints publics nécessaires avant toute session (auth-status, setup, login).
// ---------------------------------------------------------------------------
function isProtected() {
  return db.getAllUsers().length > 0;
}

// Inscription publique (voir /api/register plus bas) : désactivée par défaut,
// n'existe que si ces deux variables sont définies (clé publique + secrète
// d'un widget Cloudflare Turnstile — dash.cloudflare.com → Turnstile). Sans
// elles, pas de lien "créer un compte" côté frontend et la route refuse tout.
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY;
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;
// Deux conditions doivent être vraies : Turnstile configuré (protection anti-bot, prérequis
// technique — sans lui, jamais de lien d'inscription, quoi qu'il arrive) ET la bascule admin
// db.getRegistrationEnabled() (réglable depuis l'onglet Comptes, voir /api/settings plus bas,
// pour fermer temporairement les inscriptions sans toucher aux variables d'environnement).
function isRegistrationEnabled() {
  return Boolean(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY) && db.getRegistrationEnabled();
}

// TRUST_PROXY (voir .env.example) : active la confiance en X-Forwarded-For pour clientIp()
// ci-dessous — à activer UNIQUEMENT si ce serveur tourne bien derrière un reverse proxy de
// confiance (Caddy/nginx, voir la section HTTPS du README, Option A) qui pose lui-même cet
// en-tête. Sans ça, n'importe quel client peut positionner X-Forwarded-For sur sa propre
// requête (Express ne le filtre pas) et se faire passer pour une IP différente à chaque
// tentative, ce qui contournerait trivialement le rate-limiting de /api/login ci-dessous —
// défaut prudent (false) plutôt que de faire confiance par défaut à un en-tête falsifiable.
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');

// IP réelle du client, utilisée pour le rate-limiting du login et transmise à Turnstile. Ne
// prend que le PREMIER champ de X-Forwarded-For (celui posé par le proxy immédiat) : les
// suivants, s'il y en a, viennent d'étapes en amont que ce proxy ne contrôle pas lui-même.
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress;
}

// Vérifie un jeton Turnstile auprès de Cloudflare — appel réseau serveur à
// serveur, la clé secrète ne quitte jamais ce process.
async function verifyTurnstile(token, remoteIp) {
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const data = await res.json();
    return data.success === true;
  } catch (e) {
    console.error('[turnstile] Échec de la vérification :', e.message);
    return false;
  }
}

// Bootstrap optionnel : si aucun compte n'existe encore et que ces deux
// variables sont définies, on crée directement le premier compte admin (utile
// pour un déploiement scripté, sans passer par l'écran de création manuel).
if (db.getAllUsers().length === 0 && process.env.EVA_ADMIN_USERNAME && process.env.EVA_ADMIN_PASSWORD) {
  const { salt, hash } = auth.hashPassword(process.env.EVA_ADMIN_PASSWORD);
  db.createUser({ username: process.env.EVA_ADMIN_USERNAME, passwordSalt: salt, passwordHash: hash, role: 'admin' });
  console.log(`✅ Compte admin "${process.env.EVA_ADMIN_USERNAME}" créé depuis EVA_ADMIN_USERNAME/EVA_ADMIN_PASSWORD.`);
}

if (!isProtected()) {
  console.warn('\n⚠️  ATTENTION : aucun compte n\'a encore été créé.');
  console.warn('   Le site est actuellement accessible SANS connexion.');
  console.warn('   Rends-toi sur /login.html pour créer le premier compte administrateur.\n');
}

app.use((req, res, next) => {
  req.cookies = auth.parseCookies(req);
  next();
});

// Résout le jeton de session quel que soit son transport : en-tête Authorization en
// priorité (déploiement cross-origin, voir auth.bearerToken()), sinon le cookie classique
// (déploiement même-origine, comportement historique inchangé).
function requestToken(req) {
  return auth.bearerToken(req) || req.cookies[auth.SESSION_COOKIE];
}

// Utilisé par login.html pour savoir s'il faut afficher "connexion", "créer le
// premier compte admin" ou proposer un lien d'inscription — public, ne révèle
// rien de sensible (la clé Turnstile renvoyée est la clé PUBLIQUE du widget).
app.get('/api/auth-status', (req, res) => {
  const registrationEnabled = isRegistrationEnabled();
  res.json({
    hasUsers: isProtected(),
    registrationEnabled,
    turnstileSiteKey: registrationEnabled ? TURNSTILE_SITE_KEY : null,
  });
});

// Crée le tout premier compte (rôle admin) — fermé dès qu'un compte existe déjà.
app.post('/api/setup', (req, res) => {
  if (isProtected()) return res.status(409).json({ error: 'Un compte existe déjà.' });
  const { username, password } = req.body || {};
  if (!username || typeof username !== 'string' || !password || String(password).length < 8) {
    return res.status(400).json({ error: 'Nom d\'utilisateur requis et mot de passe d\'au moins 8 caractères.' });
  }
  const { salt, hash } = auth.hashPassword(password);
  const user = db.createUser({ username: username.trim(), passwordSalt: salt, passwordHash: hash, role: 'admin' });
  const token = auth.createSession(user.id, user.role);
  res.setHeader('Set-Cookie', auth.sessionCookieHeader(token, req, 30 * 24 * 3600));
  // `token` en plus du cookie : ignoré par un frontend même-origine (cookie déjà suffisant),
  // utilisé par un frontend cross-origin pour s'authentifier via l'en-tête Authorization à la
  // place (voir auth.bearerToken() — le cookie seul est peu fiable sur Safari mobile, ITP).
  res.json({ ok: true, token });
});

// Inscription publique — toujours en rôle "readonly" (jamais choisi par le
// client), un admin promeut ensuite manuellement depuis l'onglet Comptes si
// besoin. Fermée si Turnstile n'est pas configuré (voir isRegistrationEnabled).
app.post('/api/register', async (req, res) => {
  if (!isRegistrationEnabled()) {
    return res.status(403).json({ error: 'Inscription désactivée.' });
  }
  const { username, email, password, turnstileToken } = req.body || {};
  if (!username || typeof username !== 'string' || !password || String(password).length < 8) {
    return res.status(400).json({ error: 'Nom d\'utilisateur requis et mot de passe d\'au moins 8 caractères.' });
  }
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Adresse email invalide.' });
  }
  const turnstileOk = await verifyTurnstile(turnstileToken, clientIp(req));
  if (!turnstileOk) {
    return res.status(400).json({ error: 'Vérification anti-robot échouée, réessaie.' });
  }
  if (db.findUserByUsername(username)) {
    return res.status(409).json({ error: 'Ce nom d\'utilisateur est déjà pris.' });
  }
  const { salt, hash } = auth.hashPassword(password);
  const user = db.createUser({ username: username.trim(), email: email.trim(), passwordSalt: salt, passwordHash: hash, role: 'readonly' });
  const token = auth.createSession(user.id, user.role);
  res.setHeader('Set-Cookie', auth.sessionCookieHeader(token, req, 30 * 24 * 3600));
  res.json({ ok: true, token }); // voir /api/setup ci-dessus pour le pourquoi de ce champ
});

// Vérifie les identifiants et ouvre une session (cookie signé, voir auth.js). Protégé contre
// le brute-force par IP (voir auth.loginRateLimitStatus() — LOGIN_RATE_LIMIT_MAX tentatives
// par LOGIN_RATE_LIMIT_MINUTES, voir .env.example) : vérifié AVANT même de lire le compte
// pour ne pas payer le coût de verifyPassword() une fois bloqué.
app.post('/api/login', (req, res) => {
  const ip = clientIp(req);
  const rateLimit = auth.loginRateLimitStatus(ip);
  if (rateLimit.locked) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    const minutes = Math.ceil(rateLimit.retryAfterSeconds / 60);
    return res.status(429).json({ error: `Trop de tentatives de connexion. Réessaie dans ${minutes} minute(s).` });
  }
  const { username, password } = req.body || {};
  const user = username ? db.findUserByUsername(username) : null;
  // Message générique volontaire : ne pas révéler si c'est le username ou le
  // mot de passe qui est incorrect.
  if (!user || !auth.verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    auth.recordLoginFailure(ip);
    return res.status(401).json({ error: 'Identifiants incorrects.' });
  }
  auth.recordLoginSuccess(ip);
  const token = auth.createSession(user.id, user.role);
  res.setHeader('Set-Cookie', auth.sessionCookieHeader(token, req, 30 * 24 * 3600));
  res.json({ ok: true, token }); // voir /api/setup ci-dessus pour le pourquoi de ce champ
});

// Termine la session en cours (bouton "Déconnexion" du frontend).
app.post('/api/logout', (req, res) => {
  auth.destroySession(requestToken(req));
  res.setHeader('Set-Cookie', auth.sessionCookieHeader('', req, 0));
  res.json({ ok: true });
});

// /logo.svg est référencé par login.html (favicon + image), et le JS/CSS
// buildé de login.html (frontend/src/login.js, extrait en module externe —
// voir la CSP plus haut) vit sous /assets/ avec un nom haché qui change à
// chaque build. Sans ces exceptions, le navigateur se voit rediriger ces
// requêtes vers /login.html (du HTML, pas du JS/CSS/une image) — logo cassé
// et script refusé ("Expected a JavaScript module but server responded with
// text/html"). /assets/ ne contient que du code client sans rien de secret
// (les clés Turnstile etc. viennent de l'API, jamais embarquées dans le
// bundle) donc le rendre public entièrement est sans risque, et ça couvre
// aussi bien le bundle de login.html que celui de l'app (qui, lui, ne sert
// jamais à rien sans être authentifié pour les appels /api/* derrière).
const PUBLIC_PATHS = new Set(['/login.html', '/logo.svg', '/api/login', '/api/setup', '/api/auth-status', '/api/register']);
app.use((req, res, next) => {
  if (!isProtected()) return next(); // aucun compte créé = accès libre (setup en cours)
  if (PUBLIC_PATHS.has(req.path) || req.path.startsWith('/assets/')) return next();
  const session = auth.getSession(requestToken(req));
  if (session) { req.user = session; return next(); }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentification requise.' });
  }
  return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl));
});

// Compte courant (username + rôle) — utilisé par le frontend pour adapter l'UI.
app.get('/api/me', (req, res) => {
  const user = req.user ? db.getUserById(req.user.userId) : null;
  if (!user) return res.status(401).json({ error: 'Authentification requise.' });
  res.json({ id: user.id, username: user.username, email: user.email || null, role: user.role });
});

// Autorise l'import de données aux rôles admin et contributor — seul readonly
// est bloqué ici (contrairement aux équipes/reset, réservés à admin seul).
function requireImportAccess(req, res, next) {
  if (req.user && req.user.role === 'readonly') {
    return res.status(403).json({ error: 'Compte en lecture seule : action non autorisée.' });
  }
  next();
}

// Réservé aux comptes admin (gestion des utilisateurs, des équipes, et reset).
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Réservé aux administrateurs.' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Gestion des comptes (admin uniquement)
// ---------------------------------------------------------------------------
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(db.getAllUsers().map(u => ({ id: u.id, username: u.username, email: u.email || null, role: u.role, createdAt: u.createdAt })));
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, email, password, role } = req.body || {};
  if (!username || typeof username !== 'string' || !password || String(password).length < 8) {
    return res.status(400).json({ error: 'Nom d\'utilisateur requis et mot de passe d\'au moins 8 caractères.' });
  }
  if (!auth.ROLES.includes(role)) {
    return res.status(400).json({ error: `Rôle invalide (attendu : ${auth.ROLES.join(' ou ')}).` });
  }
  if (db.findUserByUsername(username)) {
    return res.status(409).json({ error: 'Ce nom d\'utilisateur est déjà pris.' });
  }
  const { salt, hash } = auth.hashPassword(password);
  const user = db.createUser({ username: username.trim(), email: email ? String(email).trim() : null, passwordSalt: salt, passwordHash: hash, role });
  res.json({ id: user.id, username: user.username, email: user.email, role: user.role, createdAt: user.createdAt });
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
  const { password, role } = req.body || {};
  const patch = {};
  if (role != null) {
    if (!auth.ROLES.includes(role)) {
      return res.status(400).json({ error: `Rôle invalide (attendu : ${auth.ROLES.join(' ou ')}).` });
    }
    if (user.role === 'admin' && role !== 'admin' && db.countAdmins() <= 1) {
      return res.status(400).json({ error: 'Impossible de rétrograder le dernier compte administrateur.' });
    }
    patch.role = role;
  }
  if (password != null) {
    if (String(password).length < 8) return res.status(400).json({ error: 'Mot de passe d\'au moins 8 caractères.' });
    const { salt, hash } = auth.hashPassword(password);
    patch.passwordSalt = salt;
    patch.passwordHash = hash;
  }
  const updated = db.updateUser(user.id, patch);
  auth.destroySessionsForUser(user.id);
  res.json({ id: updated.id, username: updated.username, email: updated.email || null, role: updated.role, createdAt: updated.createdAt });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const user = db.getUserById(req.params.id);
  if (!user) return res.json({ ok: true }); // suppression idempotente
  if (req.user.userId === user.id) {
    return res.status(400).json({ error: 'Impossible de supprimer son propre compte.' });
  }
  if (user.role === 'admin' && db.countAdmins() <= 1) {
    return res.status(400).json({ error: 'Impossible de supprimer le dernier compte administrateur.' });
  }
  db.deleteUser(user.id);
  auth.destroySessionsForUser(user.id);
  res.json({ ok: true });
});

// Réglages admin (pour l'instant : seulement la bascule d'inscription publique, voir onglet
// Comptes côté frontend). turnstileConfigured renseigne l'UI sur le fait que la bascule
// n'aura aucun effet tant que TURNSTILE_SITE_KEY/SECRET_KEY ne sont pas définis (voir
// isRegistrationEnabled ci-dessus) — sans ça, un admin pourrait "activer" l'inscription ici
// sans comprendre pourquoi le lien n'apparaît toujours pas sur /login.html.
app.get('/api/settings', requireAdmin, (req, res) => {
  res.json({
    registrationEnabled: db.getRegistrationEnabled(),
    turnstileConfigured: Boolean(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY),
  });
});

app.put('/api/settings', requireAdmin, (req, res) => {
  const { registrationEnabled } = req.body || {};
  if (typeof registrationEnabled !== 'boolean') {
    return res.status(400).json({ error: 'registrationEnabled doit être un booléen.' });
  }
  res.json({
    registrationEnabled: db.setRegistrationEnabled(registrationEnabled),
    turnstileConfigured: Boolean(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY),
  });
});

// ---------------------------------------------------------------------------
// Filtrage des modes PvE (ex: "Moon of the Dead") — ce ne sont pas de vraies
// parties Alliance/Rebels (équipe unique "FFA", scores et kills sur une tout
// autre échelle) donc on les exclut définitivement dès l'entrée, elles ne
// sont jamais stockées.
// ---------------------------------------------------------------------------
function isPveGame(g) {
  const cat = g && g.mode && g.mode.category;
  const id = g && g.mode && g.mode.identifier;
  return cat === 'Pve' || id === 'MoonOfTheDead';
}

// Reconnaît les mêmes formats que l'ancien import côté navigateur :
// - réponse GraphQL brute { data: { cursorAfterhGameHistory: { nodes } } }
// - réponse GraphQL détail de partie { data: { getAfterhGameHistoryById } } (voir plus bas)
// - réponse GraphQL profil { data: { getPlayerByUserId | getPublicPlayerByUsername } }
// - export du collecteur { nodes: [...], playerStats: [...] }
// - tableau nu de parties, ou tableau de réponses GraphQL
function extractFromPayload(payload) {
  let nodes = [];
  let playerStats = [];

  function collectOne(obj) {
    if (!obj || typeof obj !== 'object') return;
    const data = obj.data || obj;
    if (data.cursorAfterhGameHistory && Array.isArray(data.cursorAfterhGameHistory.nodes)) {
      nodes = nodes.concat(data.cursorAfterhGameHistory.nodes);
    }
    // Depuis juillet 2026, la liste d'historique par défaut du site a perdu score
    // d'équipe/dégâts/équipe/rang/pseudo par joueur — seul le détail d'une partie précise
    // (getAfterhGameHistoryById, déclenché en cliquant sur une partie côté EVA) les
    // portait encore. Depuis le collecteur v8.0 (requête HistoryBa enrichie, voir
    // eva_history_collector.user.js), la liste elle-même redemande tous ces champs et les
    // renvoie donc déjà complets en un seul appel — le merge ci-dessous ne sert plus qu'à
    // compléter les parties déjà stockées avec une capture plus ancienne/partielle
    // (imports faits avec un collecteur antérieur à la v8.0, ou détail collé à la main).
    // Envoyé dans le même tableau "nodes" que la liste : db.upsertGame() fusionne avec la
    // partie déjà connue au lieu de l'écraser (voir mergeGameRecord dans db.js), pour ne
    // perdre ni l'un ni l'autre.
    if (data.getAfterhGameHistoryById && data.getAfterhGameHistoryById.id != null) {
      nodes.push(data.getAfterhGameHistoryById);
    }
    const stat = data.getPlayerByUserId || data.getPublicPlayerByUsername;
    // Depuis la refonte de la page de profil côté EVA (juillet 2026), certains fragments
    // n'ont plus d'objet "user" du tout (juste un "id" directement dessus) — voir
    // eva_history_collector.user.js pour le détail. Le collecteur fusionne déjà les
    // fragments d'une même visite avant export, mais un import direct (JSON collé
    // depuis les devtools) peut encore arriver ici sous forme d'un fragment isolé.
    const uid = stat && ((stat.user && stat.user.id != null) ? stat.user.id : stat.id);
    if (stat && uid != null) {
      playerStats.push({
        capturedAt: new Date().toISOString(),
        user: { id: uid, username: stat.user && stat.user.username, displayName: stat.user && stat.user.displayName },
        seasonPass: stat.seasonPass || null,
        experience: stat.experience || null,
        statistics: stat.statistics || null,
        battleArenaStatistics: stat.battleArenaStatistics || null,
      });
    }
  }

  if (Array.isArray(payload)) {
    const looksLikeResponses = payload.length && payload[0] &&
      (payload[0].data || payload[0].cursorAfterhGameHistory || payload[0].getPlayerByUserId);
    if (looksLikeResponses) payload.forEach(collectOne);
    else nodes = nodes.concat(payload);
  } else if (payload && typeof payload === 'object') {
    collectOne(payload);
    if (Array.isArray(payload.nodes)) nodes = nodes.concat(payload.nodes);
    if (Array.isArray(payload.playerStats)) {
      payload.playerStats.forEach(s => {
        if (s && s.user && s.user.id != null) playerStats.push(s);
      });
    }
  }

  return { nodes, playerStats };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// État complet : la visionneuse charge tout au démarrage et fait l'analyse
// en mémoire côté navigateur (rapide, pas besoin de ré-interroger le serveur
// à chaque filtre/onglet).
app.get('/api/state', (req, res) => {
  res.json({
    games: db.getAllGames(),
    playerStats: db.getAllSnapshots(),
    teams: db.getAllTeams(),
    playerLinks: db.getAllPlayerLinks(),
    playerNames: db.getAllPlayerNames(),
  });
});

// Petit endpoint de supervision (utilisable pour un health-check externe/monitoring).
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ...db.stats() });
});

// Import : accepte le JSON collé/déposé tel quel depuis la visionneuse (ou
// directement depuis le collecteur réseau). Déduplique les parties par id
// (upsert) et les profils par empreinte de contenu, retire les parties PvE.
app.post('/api/import', requireImportAccess, (req, res) => {
  const { nodes, playerStats } = extractFromPayload(req.body);

  let addedGames = 0, updatedGames = 0, skippedPve = 0, skippedInvalid = 0;
  nodes.forEach(g => {
    if (!g || g.id == null) { skippedInvalid++; return; }
    if (isPveGame(g)) { skippedPve++; return; }
    const existed = db.gameExists(g.id);
    db.upsertGame(g);
    if (existed) updatedGames++; else addedGames++;
  });

  let addedStats = 0, duplicateStats = 0;
  playerStats.forEach(s => {
    const hash = db.hashSnapshot(s);
    if (db.snapshotHashExists(s.user.id, hash)) { duplicateStats++; return; }
    db.insertSnapshot(s, hash);
    addedStats++;
  });

  res.json({
    recognized: nodes.length > 0 || playerStats.length > 0,
    addedGames, updatedGames, skippedPve, skippedInvalid,
    addedStats, duplicateStats,
    totals: db.stats(),
  });
});

// Export brut (sauvegarde manuelle, ou migration vers un autre système)
app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="eva-export.json"');
  res.json({ nodes: db.getAllGames(), playerStats: db.getAllSnapshots() });
});

// Supprime une partie précise (ex: import buggé à corriger en la réimportant après coup).
// Admin uniquement, comme le reset complet — suppression idempotente.
app.delete('/api/games/:id', requireAdmin, (req, res) => {
  db.deleteGame(req.params.id);
  res.json({ ok: true });
});

// Équipes
app.get('/api/teams', (req, res) => {
  res.json(db.getAllTeams());
});
// Crée une équipe ; renvoie 400 si le nom ou la liste de membres est absente/vide.
app.post('/api/teams', requireAdmin, (req, res) => {
  const { name, members } = req.body || {};
  if (!name || typeof name !== 'string' || !Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'Champs requis : name (texte) et members (liste non vide).' });
  }
  res.json(db.createTeam(name.trim(), members));
});
// Renomme une équipe et/ou remplace sa liste de membres.
app.put('/api/teams/:id', requireAdmin, (req, res) => {
  const { name, members } = req.body || {};
  const team = db.updateTeam(req.params.id, name, members);
  if (!team) return res.status(404).json({ error: 'Équipe introuvable.' });
  res.json(team);
});
// Suppression idempotente (pas d'erreur si l'équipe n'existe déjà plus).
app.delete('/api/teams/:id', requireAdmin, (req, res) => {
  db.deleteTeam(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Fusion de comptes joueurs (admin) — associe un ancien compte EVA (smurf) à un
// compte "primary" pour agréger leurs stats côté client (voir
// frontend/src/player-links.js : canonicalUid()). Ne modifie jamais les parties ou
// captures stockées, uniquement une table de correspondance — toujours réversible.
// Incluse dans /api/state (playerLinks) pour tout le monde ; seule la mutation est
// réservée aux admins, comme les équipes.
// ---------------------------------------------------------------------------
app.post('/api/player-links', requireAdmin, (req, res) => {
  const { aliasUserId, primaryUserId } = req.body || {};
  if (!aliasUserId || !primaryUserId || String(aliasUserId) === String(primaryUserId)) {
    return res.status(400).json({ error: 'Champs requis : aliasUserId et primaryUserId, différents l\'un de l\'autre.' });
  }
  const link = db.linkPlayer(aliasUserId, primaryUserId);
  if (!link) {
    return res.status(400).json({ error: 'Lien invalide : ce compte est déjà, directement ou indirectement, le même que le compte principal choisi.' });
  }
  res.json(link);
});
// Suppression idempotente (pas d'erreur si le lien n'existe déjà plus).
app.delete('/api/player-links/:aliasUserId', requireAdmin, (req, res) => {
  db.unlinkPlayer(req.params.aliasUserId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Renommage manuel d'un joueur (admin) — force le nom affiché quand un joueur a changé
// de pseudo en jeu (voir db.js : setPlayerName). N'affecte aucune donnée de partie,
// toujours réversible (suppression du renommage = retour au pseudo auto-détecté).
// ---------------------------------------------------------------------------
app.put('/api/player-names/:uid', requireAdmin, (req, res) => {
  const name = (req.body && req.body.name != null) ? String(req.body.name).trim() : '';
  if (!name) return res.status(400).json({ error: 'Nom requis.' });
  res.json(db.setPlayerName(req.params.uid, name));
});
// Suppression idempotente (pas d'erreur si le renommage n'existe déjà plus).
app.delete('/api/player-names/:uid', requireAdmin, (req, res) => {
  db.clearPlayerName(req.params.uid);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Sauvegardes automatiques (admin) — voir db.js : startAutoBackup()/runBackupNow().
// Copies horodatées de data.json/users.json dans un dossier séparé (BACKUP_DIR),
// purgées automatiquement au-delà de BACKUP_RETENTION sauvegardes.
// ---------------------------------------------------------------------------
app.get('/api/backups', requireAdmin, (req, res) => {
  const s = db.stats();
  res.json({ intervalHours: s.backupIntervalHours, retention: s.backupRetention, sets: db.listBackups() });
});
app.post('/api/backups', requireAdmin, (req, res) => {
  res.json(db.runBackupNow());
});
// :filename est validé strictement par db.backupFilePath() (format exact qu'on génère
// nous-mêmes) avant toute jointure de chemin — voir sa doc pour le détail de la garde
// contre une traversée de chemin.
app.get('/api/backups/:filename', requireAdmin, (req, res) => {
  const filePath = db.backupFilePath(req.params.filename);
  if (!filePath) return res.status(404).json({ error: 'Sauvegarde introuvable.' });
  res.download(filePath, req.params.filename);
});
// Restaure un set de sauvegarde précis — voir db.restoreBackup() pour le détail (backup de
// sécurité automatique de l'état actuel avant d'écraser quoi que ce soit, :timestamp validé
// strictement contre le format qu'on génère nous-mêmes). `kinds` (optionnel, body JSON)
// restreint à 'data' et/ou 'users' — les deux par défaut si présents dans ce set.
// Si les comptes font partie de ce qui est restauré, TOUTES les sessions sont invalidées
// (y compris celle de l'admin qui déclenche l'action, si son compte n'existe plus dans le
// users.json restauré) : on ne peut pas savoir a priori si l'admin courant y survit encore.
app.post('/api/backups/:timestamp/restore', requireAdmin, (req, res) => {
  const kinds = req.body && Array.isArray(req.body.kinds) ? req.body.kinds : undefined;
  const result = db.restoreBackup(req.params.timestamp, kinds);
  if (!result || !result.restored.length) return res.status(404).json({ error: 'Sauvegarde introuvable ou vide.' });
  if (result.restored.includes('users')) auth.destroyAllSessions();
  res.json(result);
});

// Réinitialisation complète (vide games + snapshots + teams)
app.delete('/api/reset', requireAdmin, (req, res) => {
  db.resetAll();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Frontend statique
// ---------------------------------------------------------------------------
app.use(express.static(FRONTEND_DIR));
app.use((req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ---------------------------------------------------------------------------
// Démarrage — HTTP par défaut, ou HTTPS si un certificat est fourni.
//
// Pour activer HTTPS directement dans ce serveur (sans reverse proxy) :
//   SSL_KEY_PATH=/chemin/vers/privkey.pem SSL_CERT_PATH=/chemin/vers/cert.pem npm start
// Optionnellement SSL_CA_PATH pour une chaîne d'autorité intermédiaire.
//
// Voir le README pour :
// - générer un certificat auto-signé pour tester en local,
// - obtenir un vrai certificat gratuit (Let's Encrypt) via certbot,
// - ou préférer un reverse proxy (nginx/Caddy) qui gère le renouvellement
//   automatique du certificat à ta place — souvent le choix le plus simple
//   pour un usage en production.
// ---------------------------------------------------------------------------
const https = require('https');
const http = require('http');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;

// Le require.main check évite de lancer un vrai serveur (bind de port) quand ce
// fichier est require() plutôt qu'exécuté directement — nécessaire pour pouvoir
// tester isPveGame()/extractFromPayload() (voir backend/test/server.test.js) sans
// démarrer le serveur à chaque run de la suite de tests.
if (require.main === module) {
db.startAutoBackup();
if (SSL_KEY_PATH && SSL_CERT_PATH) {
  let options;
  try {
    options = {
      key: fs.readFileSync(SSL_KEY_PATH),
      cert: fs.readFileSync(SSL_CERT_PATH),
    };
    if (process.env.SSL_CA_PATH) options.ca = fs.readFileSync(process.env.SSL_CA_PATH);
  } catch (e) {
    console.error(`\n❌ Impossible de lire le certificat HTTPS : ${e.message}`);
    console.error('   Vérifie SSL_KEY_PATH / SSL_CERT_PATH (et les droits de lecture sur ces fichiers).\n');
    process.exit(1);
  }

  https.createServer(options, app).listen(PORT, () => {
    console.log(`EVA Debrief (HTTPS) prêt sur https://localhost:${PORT}`);
    console.log(`Données de jeu stockées dans : ${db.stats().dataFile}`);
    console.log(`Comptes stockés dans : ${db.stats().usersFile}`);
  });

  // Redirection HTTP -> HTTPS optionnelle, sur un port séparé (ex: 80 vers 443).
  // Utile si ce process écoute directement les ports publics ; inutile si un
  // reverse proxy s'en charge déjà en amont.
  if (process.env.HTTP_REDIRECT_PORT) {
    http.createServer((req, res) => {
      const host = (req.headers.host || 'localhost').split(':')[0];
      const suffix = String(PORT) === '443' ? '' : `:${PORT}`;
      res.writeHead(301, { Location: `https://${host}${suffix}${req.url}` });
      res.end();
    }).listen(process.env.HTTP_REDIRECT_PORT, () => {
      console.log(`Redirection HTTP → HTTPS active sur le port ${process.env.HTTP_REDIRECT_PORT}`);
    });
  }
} else {
  app.listen(PORT, () => {
    console.log(`EVA Debrief prêt sur http://localhost:${PORT}`);
    console.log(`Données de jeu stockées dans : ${db.stats().dataFile}`);
    console.log(`Comptes stockés dans : ${db.stats().usersFile}`);
    console.log('ℹ️  Ceci tourne en HTTP simple. Voir le README pour activer HTTPS (SSL_KEY_PATH / SSL_CERT_PATH ou reverse proxy).');
  });
}
}

// Exposés pour la suite de tests (voir backend/test/server.test.js) — le reste du
// module (routes, démarrage du serveur) n'a pas besoin d'être importable ailleurs.
module.exports = { isPveGame, extractFromPayload };

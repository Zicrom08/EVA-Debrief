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

const express = require('express');
const path = require('path');
const db = require('./db');
const auth = require('./auth');

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend', 'dist');

const app = express();
app.use(express.json({ limit: '100mb' })); // les exports d'historique complets peuvent être volumineux

// ---------------------------------------------------------------------------
// Authentification par mot de passe partagé (voir auth.js).
// Placée tout en haut : tout ce qui suit (API + fichiers statiques) passe
// par cette porte, sauf la page de connexion elle-même et l'endpoint de login.
// ---------------------------------------------------------------------------
if (!auth.isProtected()) {
  console.warn('\n⚠️  ATTENTION : aucune variable d\'environnement EVA_PASSWORD définie.');
  console.warn('   Le site est actuellement accessible SANS mot de passe.');
  console.warn('   Pour le protéger : EVA_PASSWORD=un-mot-de-passe-solide npm start\n');
}

app.use((req, res, next) => {
  req.cookies = auth.parseCookies(req);
  next();
});

// Vérifie le mot de passe et ouvre une session (cookie signé, voir auth.js).
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!auth.checkPassword(password)) {
    return res.status(401).json({ error: 'Mot de passe incorrect.' });
  }
  const token = auth.createSession();
  res.setHeader('Set-Cookie', auth.sessionCookieHeader(token, req, 30 * 24 * 3600));
  res.json({ ok: true });
});

// Termine la session en cours (bouton "Déconnexion" du frontend).
app.post('/api/logout', (req, res) => {
  auth.destroySession(req.cookies[auth.SESSION_COOKIE]);
  res.setHeader('Set-Cookie', auth.sessionCookieHeader('', req, 0));
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (!auth.isProtected()) return next(); // pas de mot de passe configuré = accès libre
  if (req.path === '/login.html' || req.path === '/api/login') return next();
  if (auth.isValidSession(req.cookies[auth.SESSION_COOKIE])) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentification requise.' });
  }
  return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl));
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
  });
});

// Petit endpoint de supervision (utilisable pour un health-check externe/monitoring).
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ...db.stats() });
});

// Import : accepte le JSON collé/déposé tel quel depuis la visionneuse (ou
// directement depuis le collecteur réseau). Déduplique les parties par id
// (upsert) et les profils par empreinte de contenu, retire les parties PvE.
app.post('/api/import', (req, res) => {
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

// Équipes
app.get('/api/teams', (req, res) => {
  res.json(db.getAllTeams());
});
// Crée une équipe ; renvoie 400 si le nom ou la liste de membres est absente/vide.
app.post('/api/teams', (req, res) => {
  const { name, members } = req.body || {};
  if (!name || typeof name !== 'string' || !Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'Champs requis : name (texte) et members (liste non vide).' });
  }
  res.json(db.createTeam(name.trim(), members));
});
// Renomme une équipe et/ou remplace sa liste de membres.
app.put('/api/teams/:id', (req, res) => {
  const { name, members } = req.body || {};
  const team = db.updateTeam(req.params.id, name, members);
  if (!team) return res.status(404).json({ error: 'Équipe introuvable.' });
  res.json(team);
});
// Suppression idempotente (pas d'erreur si l'équipe n'existe déjà plus).
app.delete('/api/teams/:id', (req, res) => {
  db.deleteTeam(req.params.id);
  res.json({ ok: true });
});

// Réinitialisation complète (vide games + snapshots + teams)
app.delete('/api/reset', (req, res) => {
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
    console.log(`Données stockées dans : ${db.stats().dataFile}`);
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
    console.log(`Données stockées dans : ${db.stats().dataFile}`);
    console.log('ℹ️  Ceci tourne en HTTP simple. Voir le README pour activer HTTPS (SSL_KEY_PATH / SSL_CERT_PATH ou reverse proxy).');
  });
}

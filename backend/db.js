// ============================================================================
// Petite base de données embarquée, en JSON, sans dépendance native.
//
// Pourquoi pas une "vraie" base SQL (ex: better-sqlite3) ? Ce module a été
// pensé pour être copié tel quel sur n'importe quel serveur et démarrer avec
// un simple `npm install` — sans compilateur C++, sans étape de build, sans
// dépendre d'un accès réseau à des binaires précompilés. Pour le volume de
// données concerné ici (des dizaines de milliers de parties tout au plus),
// un fichier JSON avec écriture atomique est largement suffisant et beaucoup
// plus simple à sauvegarder (un seul fichier à copier).
//
// Deux fichiers séparés plutôt qu'un seul : data.json (parties, profils,
// équipes) et users.json (comptes) — pour pouvoir sauvegarder/versionner les
// données de jeu indépendamment des comptes (identifiants, mots de passe
// hachés), sur un support différent si besoin. Les anciennes installations
// (comptes stockés dans data.json lui-même) sont migrées automatiquement au
// démarrage, voir plus bas.
//
// Si tu préfères une vraie base SQL plus tard (Postgres, SQLite natif...),
// l'interface exportée ci-dessous (getAllGames, upsertGame, etc.) est conçue
// pour être remplacée sans toucher au reste du serveur.
// ============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// __dirname pointe maintenant vers backend/ (ce fichier y a été déplacé) — on
// remonte d'un niveau par défaut pour que data.json reste à la racine du repo,
// là où il vivait avant ce déplacement, sans casser les déploiements existants.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const DATA_FILE = path.join(DATA_DIR, process.env.DATA_FILE || 'data.json');

// USERS_DATA_DIR retombe sur DATA_DIR par défaut (même dossier, fichier différent)
// mais peut pointer ailleurs si tu veux stocker/sauvegarder les comptes séparément
// des données de jeu (ex: support de sauvegarde différent, fréquence différente).
const USERS_DATA_DIR = process.env.USERS_DATA_DIR || DATA_DIR;
const USERS_DATA_FILE = path.join(USERS_DATA_DIR, process.env.USERS_DATA_FILE || 'users.json');

function emptyGameState() {
  return {
    games: {},               // gameId (string) -> game node complet (JSON brut)
    playerStatsSnapshots: {},// userId (string) -> [snapshot, ...] trié par capturedAt croissant
    teams: {},                // teamId -> { id, name, members: [userId,...] }
    playerLinks: {},          // aliasUserId (string) -> primaryUserId (string) — fusion de comptes joueurs (smurfs), voir linkPlayer()
  };
}
function emptyUsersState() {
  return {
    users: {},                // userId (interne, généré) -> { id, username, email, passwordSalt, passwordHash, role, createdAt }
  };
}

// Lit et parse un fichier JSON ; renvoie null si absent/vide/illisible. Un fichier
// illisible/corrompu est mis de côté (renommé) plutôt qu'écrasé silencieusement,
// pour ne jamais perdre de données.
function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.error('[db] Impossible de lire', filePath, '—', e.message);
    try {
      if (fs.existsSync(filePath)) fs.renameSync(filePath, filePath + '.corrupted-' + Date.now());
    } catch (e2) { /* ignore */ }
    return null;
  }
}

// Écriture atomique : on écrit dans un fichier temporaire puis on renomme, pour ne
// jamais laisser le fichier dans un état à moitié écrit si le process est interrompu
// pendant l'écriture (coupure serveur, kill -9, etc.). Une instance par fichier
// (games et users se sauvegardent indépendamment l'un de l'autre).
function makePersister(filePath, getState) {
  return {
    saveNow() {
      const tmpFile = filePath + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(getState()));
      fs.renameSync(tmpFile, filePath);
    },
  };
}

// --- Données de jeu (data.json) ---
// legacyDataFile est aussi relu pour la migration des comptes ci-dessous, avant
// qu'une éventuelle prochaine sauvegarde de `state` (qui ne porte plus la clé
// "users") ne les efface silencieusement de data.json.
const legacyDataFile = readJsonFile(DATA_FILE);
let state = {
  games: (legacyDataFile && legacyDataFile.games) || {},
  playerStatsSnapshots: (legacyDataFile && legacyDataFile.playerStatsSnapshots) || {},
  teams: (legacyDataFile && legacyDataFile.teams) || {},
  playerLinks: (legacyDataFile && legacyDataFile.playerLinks) || {},
};
const gamePersister = makePersister(DATA_FILE, () => state);

// --- Comptes (users.json, séparé de data.json) ---
// Migration automatique et unique : les installations d'avant cette séparation
// avaient les comptes dans data.json lui-même (clé "users") — repris ici si
// users.json n'existe pas encore, puis persistés tout de suite dans leur propre
// fichier (indispensable : sans cette écriture immédiate, ils ne vivraient qu'en
// mémoire tant qu'aucun compte n'est modifié, et la prochaine sauvegarde des
// données de jeu ne les réécrirait plus dans data.json — perte de données).
const usersFileContent = readJsonFile(USERS_DATA_FILE);
let usersState;
if (usersFileContent) {
  usersState = { users: usersFileContent.users || {} };
} else if (legacyDataFile && legacyDataFile.users && Object.keys(legacyDataFile.users).length) {
  usersState = { users: legacyDataFile.users };
  console.log(`[db] Migration : comptes trouvés dans ${DATA_FILE}, déplacés vers ${USERS_DATA_FILE}.`);
} else {
  usersState = emptyUsersState();
}
const usersPersister = makePersister(USERS_DATA_FILE, () => usersState);
if (!usersFileContent) usersPersister.saveNow();

// Identifiant court et suffisamment unique pour une équipe/un compte (pas besoin d'UUID ici).
function genId(prefix) {
  return (prefix || 't') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Empreinte de contenu d'une capture de profil (statistics + battleArenaStatistics +
// experience + seasonId), utilisée pour détecter les doublons — deux captures avec
// exactement les mêmes chiffres sont considérées comme la même capture, peu importe
// leur date. battleArenaStatistics est le remplaçant de "statistics" depuis le
// changement d'API EVA de juillet 2026 (voir server.js) — inclus dans l'empreinte pour
// ne pas dédupliquer à tort deux captures qui ne diffèrent que par ce champ.
// seasonId (posé au niveau racine de la capture depuis le collecteur v8.0, la requête
// enrichie ne redemandant plus experience.seasonId — voir snapshotSeasonId() côté
// frontend) est inclus pour la même raison que côté collecteur (mergePlayerStat) : en
// tout début de saison, deux captures de saisons différentes peuvent avoir des
// compteurs identiques (souvent 0 partout), et seraient prises à tort pour un doublon
// sans le seasonId dans l'empreinte.
function hashSnapshot(snap) {
  const basis = JSON.stringify(snap.statistics || null) + '|' + JSON.stringify(snap.experience || null) + '|' + JSON.stringify(snap.battleArenaStatistics || null) + '|' + (snap.seasonId != null ? snap.seasonId : '');
  return crypto.createHash('sha256').update(basis).digest('hex');
}

// Fusionne deux versions d'une même partie plutôt que de laisser la plus récente écraser
// l'autre. Depuis le changement d'API EVA de juillet 2026, la liste d'historique
// (cursorAfterhGameHistory) et le détail d'une partie (getAfterhGameHistoryById) portent
// chacune un sous-ensemble différent des champs (la liste a "outcome" par joueur, le
// détail a team/score/rank/niceName/teamOne-teamTwo) — sans fusion, réimporter l'un après
// l'autre perdrait les infos de celui déjà stocké. Fusion à deux niveaux : g.data
// (teamOne/teamTwo/duration...) et chaque joueur (par userId), sur son propre .data.
// Le champ racine `seasonId` (posé par le collecteur v9.0 sur chaque partie, voir
// eva_history_collector.user.js et snapshotSeasonId() côté frontend) passe déjà par ce
// même Object.assign de premier niveau sans traitement particulier : `incoming` ne porte
// la propriété que quand le collecteur a pu la déterminer, donc une capture plus ancienne
// sans ce champ n'écrase jamais un seasonId déjà connu (Object.assign ne copie que les
// propriétés réellement présentes sur la source, jamais une valeur undefined implicite).
function mergeGameRecord(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const merged = Object.assign({}, existing, incoming);
  merged.data = Object.assign({}, existing.data, incoming.data);
  if ((existing.data && existing.data.teamOne) || (incoming.data && incoming.data.teamOne)) {
    merged.data.teamOne = Object.assign({}, existing.data && existing.data.teamOne, incoming.data && incoming.data.teamOne);
  }
  if ((existing.data && existing.data.teamTwo) || (incoming.data && incoming.data.teamTwo)) {
    merged.data.teamTwo = Object.assign({}, existing.data && existing.data.teamTwo, incoming.data && incoming.data.teamTwo);
  }
  const byUid = new Map();
  (existing.players || []).forEach(p => byUid.set(p.userId, p));
  (incoming.players || []).forEach(p => {
    const cur = byUid.get(p.userId);
    byUid.set(p.userId, cur ? Object.assign({}, cur, p, { data: Object.assign({}, cur.data, p.data) }) : p);
  });
  merged.players = Array.from(byUid.values());
  return merged;
}

// La liste porte "outcome" par joueur, le détail ne le porte plus (seulement les scores
// d'équipe) — si un joueur n'a toujours pas d'outcome après fusion (détail importé sans
// être jamais passé par la liste), on le déduit de teamOne/teamTwo.score.
function deriveOutcomes(g) {
  const t1 = g.data && g.data.teamOne;
  const t2 = g.data && g.data.teamTwo;
  if (!t1 || !t2 || t1.score == null || t2.score == null) return;
  const winner = t1.score === t2.score ? null : (t1.score > t2.score ? t1.name : t2.name);
  (g.players || []).forEach(p => {
    if (p.data && p.data.outcome == null && p.data.team != null) {
      p.data.outcome = winner == null ? 'Draw' : (p.data.team === winner ? 'Victory' : 'Defeat');
    }
  });
}

// Résout un aliasUserId à travers la map jusqu'à sa racine — toujours censé s'arrêter
// en une seule étape (linkPlayer aplatit systématiquement, jamais de chaîne
// alias->alias->primary stockée), la boucle + le Set `seen` ne sont qu'un garde-fou
// défensif contre un état corrompu écrit à la main dans data.json.
function resolvePrimary(uid) {
  let cur = String(uid);
  const seen = new Set();
  while (state.playerLinks[cur] != null && !seen.has(cur)) {
    seen.add(cur);
    cur = state.playerLinks[cur];
  }
  return cur;
}

module.exports = {
  // ---------------- Games ----------------
  gameExists(id) {
    return Object.prototype.hasOwnProperty.call(state.games, String(id));
  },
  upsertGame(g) {
    const key = String(g.id);
    const merged = mergeGameRecord(state.games[key], g);
    deriveOutcomes(merged);
    state.games[key] = merged;
    gamePersister.saveNow();
  },
  getAllGames() {
    return Object.values(state.games).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },
  gameCount() {
    return Object.keys(state.games).length;
  },
  // Suppression idempotente d'une partie précise (typiquement pour corriger un import
  // buggé : supprimer puis réimporter le fichier corrigé) — pas d'erreur si elle
  // n'existe déjà plus.
  deleteGame(id) {
    delete state.games[String(id)];
    gamePersister.saveNow();
  },

  // ---------------- Player stat snapshots ----------------
  // Dédoublonnage : on compare le contenu (statistics + experience) à TOUTES les
  // captures déjà stockées pour ce joueur, pas seulement la dernière — ça rend
  // l'import idempotent même si on réimporte un vieux fichier après des plus récents.
  snapshotHashExists(userId, hash) {
    const list = state.playerStatsSnapshots[String(userId)] || [];
    return list.some(s => s.__hash === hash);
  },
  insertSnapshot(snap, hash) {
    const uid = String(snap.user.id);
    if (!state.playerStatsSnapshots[uid]) state.playerStatsSnapshots[uid] = [];
    const withHash = Object.assign({}, snap, { __hash: hash });
    state.playerStatsSnapshots[uid].push(withHash);
    state.playerStatsSnapshots[uid].sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
    gamePersister.saveNow();
  },
  getAllSnapshots() {
    const all = [];
    Object.values(state.playerStatsSnapshots).forEach(list => {
      list.forEach(s => {
        // on ne renvoie jamais le hash interne au client, c'est un détail d'implémentation
        const { __hash, ...clean } = s;
        all.push(clean);
      });
    });
    return all;
  },

  // ---------------- Teams ----------------
  getAllTeams() {
    return Object.values(state.teams);
  },
  createTeam(name, members) {
    const id = genId('t');
    const team = { id, name, members: (members || []).map(String) };
    state.teams[id] = team;
    gamePersister.saveNow();
    return team;
  },
  updateTeam(id, name, members) {
    const team = state.teams[id];
    if (!team) return null;
    if (name != null) team.name = name;
    if (Array.isArray(members)) team.members = members.map(String);
    gamePersister.saveNow();
    return team;
  },
  deleteTeam(id) {
    delete state.teams[id];
    gamePersister.saveNow();
  },

  // ---------------- Users (comptes + rôles) — fichier séparé, voir users.json ----------------
  // Volontairement pas dans resetAll() : le reset ne touche jamais aux comptes, seulement
  // aux données de jeu (games/snapshots/teams) — sinon un reset déconnecterait/supprimerait
  // tout le monde par surprise. Ça tombe bien avec la séparation en deux fichiers.
  getAllUsers() {
    return Object.values(usersState.users);
  },
  findUserByUsername(username) {
    const needle = String(username || '').toLowerCase();
    return Object.values(usersState.users).find(u => u.username.toLowerCase() === needle) || null;
  },
  getUserById(id) {
    return usersState.users[String(id)] || null;
  },
  createUser({ username, email, passwordSalt, passwordHash, role }) {
    const id = genId('u');
    const user = { id, username, email: email || null, passwordSalt, passwordHash, role, createdAt: new Date().toISOString() };
    usersState.users[id] = user;
    usersPersister.saveNow();
    return user;
  },
  updateUser(id, patch) {
    const user = usersState.users[String(id)];
    if (!user) return null;
    if (patch.passwordSalt != null) user.passwordSalt = patch.passwordSalt;
    if (patch.passwordHash != null) user.passwordHash = patch.passwordHash;
    if (patch.role != null) user.role = patch.role;
    usersPersister.saveNow();
    return user;
  },
  deleteUser(id) {
    delete usersState.users[String(id)];
    usersPersister.saveNow();
  },
  countAdmins() {
    return Object.values(usersState.users).filter(u => u.role === 'admin').length;
  },

  // ---------------- Player links (fusion de comptes joueurs, admin) ----------------
  // Ne réécrit jamais games/playerStatsSnapshots : la fusion n'existe qu'au niveau de
  // cette table de correspondance, résolue côté client (voir frontend/src/player-links.js
  // canonicalUid()) — donc toujours réversible sans perte de donnée brute.
  getAllPlayerLinks() {
    return Object.entries(state.playerLinks).map(([aliasUserId, primaryUserId]) => ({ aliasUserId, primaryUserId }));
  },
  // Fusionne aliasUserId dans primaryUserId. Toujours stocké "à plat" : primaryUserId est
  // d'abord résolu à sa propre racine (pour ne jamais empiler de chaîne), et si aliasUserId
  // était lui-même déjà une primary pour d'autres alias, ceux-ci sont repointés directement
  // vers la nouvelle racine — ça permet de fusionner deux groupes déjà fusionnés en un seul
  // appel. Renvoie null (rejeté) si ça reviendrait à fusionner un compte avec lui-même,
  // y compris indirectement (ex: A déjà fusionné dans B, on tente ensuite B -> A).
  linkPlayer(aliasUserId, primaryUserIdInput) {
    const alias = String(aliasUserId);
    const primary = resolvePrimary(primaryUserIdInput);
    if (alias === primary) return null;
    Object.keys(state.playerLinks).forEach(a => {
      if (state.playerLinks[a] === alias) state.playerLinks[a] = primary;
    });
    state.playerLinks[alias] = primary;
    gamePersister.saveNow();
    return { aliasUserId: alias, primaryUserId: primary };
  },
  // Défusion d'un compte précis (idempotent) — le compte redevient un joueur autonome,
  // ses parties/captures n'ont jamais bougé.
  unlinkPlayer(aliasUserId) {
    delete state.playerLinks[String(aliasUserId)];
    gamePersister.saveNow();
  },

  // ---------------- Admin ----------------
  resetAll() {
    state = emptyGameState();
    gamePersister.saveNow();
  },
  stats() {
    return {
      games: Object.keys(state.games).length,
      snapshots: Object.values(state.playerStatsSnapshots).reduce((s, l) => s + l.length, 0),
      teams: Object.keys(state.teams).length,
      users: Object.keys(usersState.users).length,
      dataFile: DATA_FILE,
      usersFile: USERS_DATA_FILE,
    };
  },

  // exposés pour le serveur (calcul du hash côté route d'import)
  hashSnapshot,
};

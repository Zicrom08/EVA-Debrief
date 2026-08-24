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

// Sauvegardes automatiques (voir la section dédiée plus bas) : copies horodatées de
// data.json/users.json, dans un dossier séparé pour ne jamais se mélanger aux fichiers
// vivants. BACKUP_RETENTION = nombre de sauvegardes conservées (les plus anciennes au-delà
// sont supprimées automatiquement). BACKUP_INTERVAL_HOURS = fréquence ; 0 désactive
// complètement la sauvegarde automatique (une sauvegarde manuelle via l'API reste possible).
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const BACKUP_RETENTION = Number(process.env.BACKUP_RETENTION) || 30;
const BACKUP_INTERVAL_HOURS = process.env.BACKUP_INTERVAL_HOURS != null ? Number(process.env.BACKUP_INTERVAL_HOURS) : 24;

function emptyGameState() {
  return {
    games: {},               // gameId (string) -> game node complet (JSON brut)
    playerStatsSnapshots: {},// userId (string) -> [snapshot, ...] trié par capturedAt croissant
    teams: {},                // teamId -> { id, name, members: [userId,...] }
    playerLinks: {},          // aliasUserId (string) -> primaryUserId (string) — fusion de comptes joueurs (smurfs), voir linkPlayer()
    playerNames: {},          // userId canonique (string) -> nom personnalisé — renommage manuel, voir setPlayerName()
  };
}
function emptyUsersState() {
  return {
    users: {},                // userId (interne, généré) -> { id, username, email, passwordSalt, passwordHash, role, createdAt }
    registrationEnabled: true, // bascule admin (onglet Comptes) — voir isRegistrationEnabled() dans server.js, qui l'ET-combine avec la présence de TURNSTILE_SITE_KEY/SECRET_KEY (les deux doivent être vrais pour que /api/register accepte)
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
  playerNames: (legacyDataFile && legacyDataFile.playerNames) || {},
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
  // registrationEnabled absent d'un users.json antérieur à ce réglage -> true par défaut,
  // pour préserver le comportement actuel (déjà entièrement gouverné par la présence de
  // TURNSTILE_SITE_KEY/SECRET_KEY jusqu'ici) tant qu'un admin ne le ferme pas explicitement.
  usersState = {
    users: usersFileContent.users || {},
    registrationEnabled: usersFileContent.registrationEnabled !== undefined ? usersFileContent.registrationEnabled : true,
  };
} else if (legacyDataFile && legacyDataFile.users && Object.keys(legacyDataFile.users).length) {
  usersState = { users: legacyDataFile.users, registrationEnabled: true };
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

// ============================================================================
// Sauvegardes automatiques — copies horodatées de data.json/users.json dans
// BACKUP_DIR (voir les constantes en haut du fichier), indépendantes de l'état en
// mémoire : on copie directement les fichiers sur disque, toujours dans un état
// cohérent grâce à l'écriture atomique de makePersister() (jamais de fichier à
// moitié écrit à copier). Chaque sauvegarde est un "set" nommé par un horodatage
// partagé entre data-<ts>.json et users-<ts>.json, pour pouvoir les regrouper et
// les purger ensemble.
// ============================================================================
function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Horodatage sûr pour un nom de fichier (":"/"." remplacés), rendu unique si un appel
// précédent a déjà produit exactement le même (arrive si "Sauvegarder maintenant" est
// cliqué plusieurs fois très rapidement) — sinon la seconde sauvegarde écraserait
// silencieusement la première au lieu d'en créer une nouvelle.
function uniqueBackupTimestamp() {
  const base = new Date().toISOString().replace(/[:.]/g, '-');
  let ts = base;
  let n = 1;
  while (fs.existsSync(path.join(BACKUP_DIR, `data-${ts}.json`)) || fs.existsSync(path.join(BACKUP_DIR, `users-${ts}.json`))) {
    n++;
    ts = `${base}-${n}`;
  }
  return ts;
}

function listBackups() {
  ensureBackupDir();
  const sets = {}; // horodatage -> { timestamp, createdAt, files: [{kind, name, size}] }
  fs.readdirSync(BACKUP_DIR).forEach(name => {
    const m = /^(data|users)-(.+)\.json$/.exec(name);
    if (!m) return;
    const [, kind, ts] = m;
    const stat = fs.statSync(path.join(BACKUP_DIR, name));
    const createdAt = stat.mtime.toISOString();
    if (!sets[ts]) sets[ts] = { timestamp: ts, createdAt, files: [] };
    else if (createdAt < sets[ts].createdAt) sets[ts].createdAt = createdAt;
    sets[ts].files.push({ kind, name, size: stat.size });
  });
  // Tri par createdAt (mtime réel), pas par la chaîne `timestamp` : pour des sauvegardes
  // normales (toutes au format ISO généré par uniqueBackupTimestamp()) les deux ordres
  // coïncident, mais createdAt reste la source de vérité si jamais `timestamp` ne suit pas
  // cet ordre (fichier renommé/copié à la main, restauration partielle...).
  return Object.values(sets).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

// Ne garde que les BACKUP_RETENTION sets les plus récents (listBackups() les renvoie déjà
// triés du plus récent au plus ancien) — supprime les fichiers des autres.
function pruneOldBackups() {
  listBackups().slice(BACKUP_RETENTION).forEach(set => {
    set.files.forEach(f => {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch (e) { /* déjà supprimé, tant pis */ }
    });
  });
}

// Copie data.json et/ou users.json (seulement ceux qui existent déjà sur disque — un
// serveur tout juste démarré sans aucune partie importée n'a pas encore de data.json) vers
// BACKUP_DIR, puis purge les sauvegardes excédentaires.
function runBackupNow() {
  ensureBackupDir();
  const ts = uniqueBackupTimestamp();
  const files = [];
  [[DATA_FILE, 'data'], [USERS_DATA_FILE, 'users']].forEach(([src, kind]) => {
    if (!fs.existsSync(src)) return;
    const name = `${kind}-${ts}.json`;
    fs.copyFileSync(src, path.join(BACKUP_DIR, name));
    files.push(name);
  });
  pruneOldBackups();
  return { timestamp: ts, files };
}

// Résout un nom de fichier de sauvegarde vers son chemin complet, en le validant
// strictement contre le format qu'on génère nous-mêmes (défense en profondeur contre une
// traversée de chemin ("../../etc/passwd") si jamais ce nom vient directement d'une requête
// HTTP — voir GET /api/backups/:filename dans server.js) — renvoie null si le format ne
// correspond pas, ou si le fichier n'existe pas. La regex suffit déjà (aucun '/', '\', '..'
// n'est permis dans la partie variable), mais on vérifie aussi explicitement que le chemin
// résolu reste BIEN à l'intérieur de BACKUP_DIR — deuxième barrière indépendante de la regex
// (CodeQL: "Uncontrolled data used in path expression"), plus simple à vérifier pour un humain
// ou un analyseur statique que la correction d'une expression régulière.
function backupFilePath(filename) {
  if (!/^(data|users)-[0-9A-Za-z-]+\.json$/.test(String(filename))) return null;
  const p = path.join(BACKUP_DIR, filename);
  const resolvedDir = path.resolve(BACKUP_DIR) + path.sep;
  if (!path.resolve(p).startsWith(resolvedDir)) return null;
  return fs.existsSync(p) ? p : null;
}

// Pas de restauration depuis le code (fonctionnalité retirée) : elle écrasait des comptes
// entiers d'un coup (mots de passe compris) sans qu'on puisse savoir à l'avance si le
// compte de l'admin qui déclenche l'action y survit — verrouillage complet constaté en
// usage réel. Remplacer data.json/users.json à la main puis redémarrer le serveur reste le
// geste volontaire recommandé (voir README, section "Où sont stockées les données").

let backupTimer = null;

// Démarre la sauvegarde périodique (appelé uniquement par server.js au vrai démarrage du
// serveur, jamais depuis les tests — voir le require.main guard dans server.js). Si aucune
// sauvegarde récente n'existe (première installation, ou serveur resté éteint plus
// longtemps que l'intervalle), en prend une immédiatement plutôt que d'attendre le premier
// intervalle complet. `.unref()` : ce minuteur ne doit jamais, à lui seul, empêcher le
// process de s'arrêter proprement.
function startAutoBackup() {
  if (BACKUP_INTERVAL_HOURS <= 0 || backupTimer) return;
  const intervalMs = BACKUP_INTERVAL_HOURS * 60 * 60 * 1000;
  const run = () => {
    try { runBackupNow(); } catch (e) { console.error('[db] Échec de la sauvegarde automatique :', e.message); }
  };
  const sets = listBackups();
  const mostRecentAgeMs = sets.length ? Date.now() - new Date(sets[0].createdAt).getTime() : Infinity;
  if (mostRecentAgeMs >= intervalMs) run();
  backupTimer = setInterval(run, intervalMs);
  backupTimer.unref();
}

function stopAutoBackup() {
  if (backupTimer) { clearInterval(backupTimer); backupTimer = null; }
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
  // hasOwnProperty (pas juste `if (!team)`) : state.teams est un objet {} ordinaire, donc
  // state.teams["__proto__"] renvoie Object.prototype (un objet, donc "truthy") plutôt que
  // undefined — sans ce garde, PUT /api/teams/__proto__ passerait le `if (!team)` et les deux
  // lignes suivantes (team.name = ..., team.members = ...) pollueraient Object.prototype pour
  // tout le process Node (CodeQL: "Prototype-polluting assignment" — id vient de req.params.id,
  // entièrement contrôlé par l'appelant même si la route est réservée aux admins).
  updateTeam(id, name, members) {
    if (!Object.prototype.hasOwnProperty.call(state.teams, id)) return null;
    const team = state.teams[id];
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
  // hasOwnProperty : même raison que updateTeam ci-dessous — sans lui, getUserById("__proto__")
  // renverrait Object.prototype (truthy) plutôt que null.
  getUserById(id) {
    const key = String(id);
    return Object.prototype.hasOwnProperty.call(usersState.users, key) ? usersState.users[key] : null;
  },
  createUser({ username, email, passwordSalt, passwordHash, role }) {
    const id = genId('u');
    const user = { id, username, email: email || null, passwordSalt, passwordHash, role, createdAt: new Date().toISOString() };
    usersState.users[id] = user;
    usersPersister.saveNow();
    return user;
  },
  // hasOwnProperty : même bug qu'updateTeam ci-dessus — usersState.users["__proto__"] renvoie
  // Object.prototype (truthy), sans quoi PUT /api/users/__proto__ pollueraient
  // Object.prototype.passwordSalt/passwordHash/role pour tout le process Node.
  updateUser(id, patch) {
    const key = String(id);
    if (!Object.prototype.hasOwnProperty.call(usersState.users, key)) return null;
    const user = usersState.users[key];
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

  // Bascule admin (onglet Comptes) pour fermer/rouvrir l'inscription publique sans toucher
  // aux variables d'environnement ni redémarrer le serveur — voir isRegistrationEnabled()
  // dans server.js, qui reste de toute façon fermée si TURNSTILE_SITE_KEY/SECRET_KEY ne
  // sont pas définis, quelle que soit cette valeur.
  getRegistrationEnabled() {
    return usersState.registrationEnabled !== false; // true par défaut, y compris si absent
  },
  setRegistrationEnabled(enabled) {
    usersState.registrationEnabled = !!enabled;
    usersPersister.saveNow();
    return usersState.registrationEnabled;
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

  // ---------------- Player names (renommage manuel, admin) ----------------
  // Le nom affiché suit déjà automatiquement le pseudo le plus récent vu en jeu (voir
  // latestNiceName() côté frontend) — ce nom personnalisé sert quand l'admin veut un nom
  // différent de ce que le jeu renvoie littéralement. Indexé par userId CANONIQUE (voir
  // playerLinks ci-dessus) : le frontend le réapplique après résolution d'alias (voir
  // applyPlayerNameOverrides() dans frontend/src/player-names.js), donc un renommage suit
  // son compte même si celui-ci est fusionné avec un autre par la suite.
  getAllPlayerNames() {
    return Object.entries(state.playerNames).map(([uid, name]) => ({ uid, name }));
  },
  setPlayerName(uid, name) {
    const key = String(uid);
    state.playerNames[key] = name;
    gamePersister.saveNow();
    return { uid: key, name };
  },
  // Idempotent : revient au nom auto-détecté (le plus récent des pseudos vus en jeu).
  clearPlayerName(uid) {
    delete state.playerNames[String(uid)];
    gamePersister.saveNow();
  },

  // ---------------- Sauvegardes automatiques (admin) ----------------
  listBackups,
  runBackupNow,
  pruneOldBackups,
  backupFilePath,
  startAutoBackup,
  stopAutoBackup,

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
      backupDir: BACKUP_DIR,
      backupRetention: BACKUP_RETENTION,
      backupIntervalHours: BACKUP_INTERVAL_HOURS,
    };
  },

  // exposés pour le serveur (calcul du hash côté route d'import)
  hashSnapshot,
};

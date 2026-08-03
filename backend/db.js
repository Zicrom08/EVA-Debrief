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

// Forme initiale de la base quand data.json n'existe pas encore (premier lancement).
function emptyState() {
  return {
    games: {},               // gameId (string) -> game node complet (JSON brut)
    playerStatsSnapshots: {},// userId (string) -> [snapshot, ...] trié par capturedAt croissant
    teams: {},                // teamId -> { id, name, members: [userId,...] }
    users: {},                // userId (interne, généré) -> { id, username, email, passwordSalt, passwordHash, role, createdAt }
  };
}

// Charge data.json au démarrage du process. Un fichier absent ou vide donne une
// base vide (premier lancement) ; un fichier illisible/corrompu est mis de côté
// (renommé) plutôt qu'écrasé silencieusement, pour ne jamais perdre de données.
function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) return emptyState();
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    if (!raw.trim()) return emptyState();
    const parsed = JSON.parse(raw);
    return {
      games: parsed.games || {},
      playerStatsSnapshots: parsed.playerStatsSnapshots || {},
      teams: parsed.teams || {},
      users: parsed.users || {},
    };
  } catch (e) {
    console.error('[db] Impossible de lire', DATA_FILE, '— démarrage avec une base vide.', e.message);
    // on ne écrase jamais un fichier illisible : on le renomme pour investigation
    try {
      if (fs.existsSync(DATA_FILE)) {
        fs.renameSync(DATA_FILE, DATA_FILE + '.corrupted-' + Date.now());
      }
    } catch (e2) { /* ignore */ }
    return emptyState();
  }
}

let state = loadState();

// Écriture atomique : on écrit dans un fichier temporaire puis on renomme,
// pour ne jamais laisser data.json dans un état à moitié écrit si le process
// est interrompu pendant l'écriture (coupure serveur, kill -9, etc.).
let writeQueued = false;
let writeTimer = null;
function scheduleSave() {
  writeQueued = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (!writeQueued) return;
    writeQueued = false;
    const tmpFile = DATA_FILE + '.tmp';
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(state));
      fs.renameSync(tmpFile, DATA_FILE);
    } catch (e) {
      console.error('[db] Échec de sauvegarde sur disque :', e.message);
    }
  }, 50); // petit debounce pour regrouper les écritures d'un import massif
}
function saveNow() {
  // sauvegarde synchrone immédiate (utilisée avant de répondre à une requête HTTP
  // pour garantir que les données sont bien sur disque avant de dire "OK" au client)
  writeQueued = false;
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  const tmpFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(state));
  fs.renameSync(tmpFile, DATA_FILE);
}

// Identifiant court et suffisamment unique pour une équipe (pas besoin d'UUID ici).
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
    saveNow();
  },
  getAllGames() {
    return Object.values(state.games).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },
  gameCount() {
    return Object.keys(state.games).length;
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
    saveNow();
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
    saveNow();
    return team;
  },
  updateTeam(id, name, members) {
    const team = state.teams[id];
    if (!team) return null;
    if (name != null) team.name = name;
    if (Array.isArray(members)) team.members = members.map(String);
    saveNow();
    return team;
  },
  deleteTeam(id) {
    delete state.teams[id];
    saveNow();
  },

  // ---------------- Users (comptes + rôles) ----------------
  // Volontairement pas dans emptyState()/resetAll() côté "vidage" : resetAll() ne
  // touche jamais aux comptes, seulement aux données de jeu (games/snapshots/teams) —
  // sinon un reset déconnecterait/supprimerait tout le monde par surprise.
  getAllUsers() {
    return Object.values(state.users);
  },
  findUserByUsername(username) {
    const needle = String(username || '').toLowerCase();
    return Object.values(state.users).find(u => u.username.toLowerCase() === needle) || null;
  },
  getUserById(id) {
    return state.users[String(id)] || null;
  },
  createUser({ username, email, passwordSalt, passwordHash, role }) {
    const id = genId('u');
    const user = { id, username, email: email || null, passwordSalt, passwordHash, role, createdAt: new Date().toISOString() };
    state.users[id] = user;
    saveNow();
    return user;
  },
  updateUser(id, patch) {
    const user = state.users[String(id)];
    if (!user) return null;
    if (patch.passwordSalt != null) user.passwordSalt = patch.passwordSalt;
    if (patch.passwordHash != null) user.passwordHash = patch.passwordHash;
    if (patch.role != null) user.role = patch.role;
    saveNow();
    return user;
  },
  deleteUser(id) {
    delete state.users[String(id)];
    saveNow();
  },
  countAdmins() {
    return Object.values(state.users).filter(u => u.role === 'admin').length;
  },

  // ---------------- Admin ----------------
  resetAll() {
    const keepUsers = state.users;
    state = Object.assign(emptyState(), { users: keepUsers });
    saveNow();
  },
  stats() {
    return {
      games: Object.keys(state.games).length,
      snapshots: Object.values(state.playerStatsSnapshots).reduce((s, l) => s + l.length, 0),
      teams: Object.keys(state.teams).length,
      users: Object.keys(state.users).length,
      dataFile: DATA_FILE,
    };
  },

  // exposés pour le serveur (calcul du hash côté route d'import)
  hashSnapshot,
};

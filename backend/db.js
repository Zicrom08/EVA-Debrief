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

// Empreinte de contenu d'une capture de profil (statistics + experience), utilisée
// pour détecter les doublons — deux captures avec exactement les mêmes chiffres
// sont considérées comme la même capture, peu importe leur date.
function hashSnapshot(snap) {
  const basis = JSON.stringify(snap.statistics || null) + '|' + JSON.stringify(snap.experience || null);
  return crypto.createHash('sha256').update(basis).digest('hex');
}

module.exports = {
  // ---------------- Games ----------------
  gameExists(id) {
    return Object.prototype.hasOwnProperty.call(state.games, String(id));
  },
  upsertGame(g) {
    state.games[String(g.id)] = g;
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

  // ---------------- Admin ----------------
  resetAll() {
    state = emptyState();
    saveNow();
  },
  stats() {
    return {
      games: Object.keys(state.games).length,
      snapshots: Object.values(state.playerStatsSnapshots).reduce((s, l) => s + l.length, 0),
      teams: Object.keys(state.teams).length,
      dataFile: DATA_FILE,
    };
  },

  // exposés pour le serveur (calcul du hash côté route d'import)
  hashSnapshot,
};

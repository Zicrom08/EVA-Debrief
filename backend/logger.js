// ============================================================================
// Journalisation fichier — jusqu'ici, console.log/warn/error (dans server.js, db.js, auth.js)
// ne vivaient QUE dans la sortie du process : perdus dès que le process qui le lance ne
// redirige pas explicitement cette sortie vers un fichier. Ce module patche une seule fois
// console.log/warn/error pour qu'ils écrivent AUSSI dans un fichier, sans devoir réécrire
// chaque site d'appel existant du reste du backend. À require() le plus tôt possible dans
// server.js — avant le premier console.log/warn de ce fichier.
// ============================================================================

const fs = require('fs');
const path = require('path');

// Retombe sur un dossier logs/ à la racine du repo, comme DATA_DIR/BACKUP_DIR (voir db.js) —
// LOG_DIR permet de le déplacer ailleurs (ex: un volume dédié aux logs).
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, process.env.LOG_FILE || 'server.log');

fs.mkdirSync(LOG_DIR, { recursive: true });
// Flux ouvert une seule fois, jamais fermé nous-mêmes (append continu tout au long de la vie
// du process) — 'a' : ajoute à la suite d'un fichier déjà existant plutôt que de l'écraser au
// redémarrage. Pas de rotation ici (volontairement simple, voir logrotate côté OS si le
// fichier grossit trop avec le temps — hors scope de ce module).
const stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
// Sans ce listener, une erreur d'écriture (disque plein, permissions...) sur ce flux serait une
// exception non interceptée qui planterait TOUT le serveur — pour un simple souci de log,
// jamais acceptable. On se contente de le signaler sur la sortie standard (jamais via
// console.error, qui rebouclerait sur ce même flux en erreur).
stream.on('error', (e) => {
  process.stderr.write(`[logger] Échec d'écriture dans ${LOG_FILE} : ${e.message}\n`);
});

function stringifyArg(v) {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function patch(level) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args); // toujours affiché aussi dans la console/sortie du process (dev, journalctl...)
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${args.map(stringifyArg).join(' ')}\n`;
    // Écriture asynchrone (jamais writeFileSync) : un flot de logs ne doit jamais bloquer le
    // event loop — exactement la leçon apprise avec l'écriture de data.json à chaque import
    // (voir save()/SAVE_DEBOUNCE_MS dans db.js). stream.write() met en tampon et écrit en
    // arrière-plan ; une erreur d'écriture (disque plein...) ne doit jamais faire planter le
    // serveur pour un simple souci de log.
    try { stream.write(line); } catch (e) { /* ignore */ }
  };
}

['log', 'warn', 'error'].forEach(patch);

module.exports = { LOG_FILE };

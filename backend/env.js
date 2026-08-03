// ============================================================================
// Charge un fichier .env optionnel à la racine du repo, pour éviter de devoir
// répéter des variables (mot de passe admin, clés Turnstile...) à chaque
// lancement en ligne de commande. Volontairement fait main plutôt que
// d'ajouter la dépendance `dotenv` — même esprit que parseCookies() dans
// auth.js : un mini-parseur suffit, pas besoin d'une dépendance de plus pour
// quelques lignes KEY=VALUE.
//
// Chargé en tout premier dans server.js, avant même `require('./db')`, pour
// que DATA_DIR/DATA_FILE (lus par db.js dès son chargement) voient bien les
// valeurs du .env.
//
// Ne remplace jamais une variable déjà présente dans l'environnement réel —
// permet de surcharger ponctuellement le .env avec `PORT=4000 npm start`.
// ============================================================================

const fs = require('fs');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  });
}

module.exports = { loadEnvFile };

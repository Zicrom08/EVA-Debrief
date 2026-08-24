import { apiGet, apiSend } from './api.js';
import { apiUrl, getAuthToken } from './api-base.js';

// ================= SAUVEGARDES DE LA BASE (admin) =================
// Simples enveloppes autour de l'API — la logique elle-même (copie horodatée de
// data.json/users.json, purge par rétention) vit entièrement côté serveur, voir backend/db.js.
// Pas de restauration depuis l'interface (route retirée) : une restauration écrase des
// comptes entiers d'un coup (mots de passe compris) sans qu'on puisse savoir à l'avance si
// le compte de l'admin qui déclenche l'action y survit — vécu en pratique comme un
// verrouillage complet hors de l'appli. Remplacer data.json/users.json à la main puis
// redémarrer le serveur reste le geste volontaire recommandé (voir README).

// { intervalHours, retention, sets: [{ timestamp, createdAt, files: [{kind, name, size}] }] }
export async function fetchBackups() {
  return apiGet('/api/backups');
}

export async function backupNow() {
  return apiSend('POST', '/api/backups');
}

// Télécharge un fichier de sauvegarde précis. Pas un <a href="..."> classique : ça
// pointerait vers la mauvaise origine dès que le frontend et le backend sont sur des
// domaines différents (voir api-base.js::CROSS_ORIGIN), et une navigation de lien ne peut de
// toute façon pas porter l'en-tête Authorization (seul un cookie partirait automatiquement,
// peu fiable en cross-origin — voir README, section GitHub Pages). On récupère donc le
// fichier via fetch() (mêmes en-têtes que le reste de l'API) puis on déclenche
// nous-mêmes le téléchargement via une URL d'objet temporaire.
export async function downloadBackup(filename) {
  const headers = {};
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(apiUrl(`/api/backups/${filename}`), { credentials: 'include', headers });
  if (!res.ok) throw new Error(`Téléchargement impossible (HTTP ${res.status}).`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

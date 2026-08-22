import { apiGet, apiSend } from './api.js';

// ================= SAUVEGARDES DE LA BASE (admin) =================
// Simples enveloppes autour de l'API — la logique elle-même (copie horodatée de
// data.json/users.json, purge par rétention, restauration) vit entièrement côté serveur,
// voir backend/db.js.

// { intervalHours, retention, sets: [{ timestamp, createdAt, files: [{kind, name, size}] }] }
export async function fetchBackups() {
  return apiGet('/api/backups');
}

export async function backupNow() {
  return apiSend('POST', '/api/backups');
}

// kinds: sous-ensemble de ['data','users'] (les deux par défaut, mais seulement ceux
// réellement présents dans ce set précis — voir db.restoreBackup()). Si 'users' est
// restauré, TOUTES les sessions sont invalidées côté serveur (y compris la nôtre si notre
// compte n'existe plus dans le users.json restauré) — l'appelant doit s'attendre à un
// possible 401 sur l'appel suivant et rediriger vers /login.html le cas échéant.
export async function restoreBackup(timestamp, kinds) {
  return apiSend('POST', `/api/backups/${encodeURIComponent(timestamp)}/restore`, { kinds });
}

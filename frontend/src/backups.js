import { apiGet, apiSend } from './api.js';

// ================= SAUVEGARDES DE LA BASE (admin) =================
// Simples enveloppes autour de l'API — la logique elle-même (copie horodatée de
// data.json/users.json, purge par rétention) vit entièrement côté serveur, voir
// backend/db.js. Pas de restauration ici : voir la note dans server.js sur les routes
// /api/backups, c'est un geste manuel volontaire, pas un bouton.

// { intervalHours, retention, sets: [{ timestamp, createdAt, files: [{kind, name, size}] }] }
export async function fetchBackups() {
  return apiGet('/api/backups');
}

export async function backupNow() {
  return apiSend('POST', '/api/backups');
}

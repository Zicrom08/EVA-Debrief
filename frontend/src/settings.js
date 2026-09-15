import { apiGet, apiSend } from './api.js';

// ================= RÉGLAGES ADMIN =================
// Deux réglages : la bascule d'inscription publique, et la coupure d'urgence de l'import
// (ajoutée après une panne de données côté EVA — voir requireImportEnabled() dans
// backend/server.js) — simples enveloppes autour de l'API, la logique elle-même vit
// entièrement côté serveur.

// { registrationEnabled, importEnabled }
export async function fetchSettings() {
  return apiGet('/api/settings');
}

export async function updateRegistrationEnabled(enabled) {
  return apiSend('PUT', '/api/settings', { registrationEnabled: enabled });
}

export async function updateImportEnabled(enabled) {
  return apiSend('PUT', '/api/settings', { importEnabled: enabled });
}

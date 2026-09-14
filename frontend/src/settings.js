import { apiGet, apiSend } from './api.js';

// ================= RÉGLAGES ADMIN =================
// Pour l'instant, un seul réglage : la bascule d'inscription publique (onglet Comptes) —
// simples enveloppes autour de l'API, la logique elle-même vit entièrement côté serveur,
// voir isRegistrationEnabled() dans backend/server.js.

// { registrationEnabled }
export async function fetchSettings() {
  return apiGet('/api/settings');
}

export async function updateRegistrationEnabled(enabled) {
  return apiSend('PUT', '/api/settings', { registrationEnabled: enabled });
}

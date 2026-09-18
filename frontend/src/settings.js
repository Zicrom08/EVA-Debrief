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

// ================= CORRECTION MANUELLE VICTOIRE/DÉFAITE (admin) =================
// Parties qu'AUCUNE heuristique automatique n'a pu résoudre (lobby privé à noms d'équipe
// personnalisés) — voir teamOneIsAllianceHeuristic()/getGamesNeedingTeamNames() dans
// backend/db.js. teamOneName/teamTwoName DOIVENT être deux des noms déjà portés par le
// roster de cette partie (jamais tapés à la main) — le serveur les revalide de toute façon.

// [{ id, createdAt, map, mode, teamOneScore, teamTwoScore, rosterTeamNames: [name, name] }, ...]
export async function fetchGamesNeedingTeamNames() {
  return apiGet('/api/games/needing-team-names');
}

export async function setGameTeamNames(gameId, teamOneName, teamTwoName) {
  return apiSend('PUT', `/api/games/${gameId}/team-names`, { teamOneName, teamTwoName });
}

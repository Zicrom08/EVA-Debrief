import { state } from './state.js';
import { apiSend } from './api.js';

// ================= FUSION DE COMPTES JOUEURS (admin) =================
// state.playerLinks : aliasUserId (string) -> primaryUserId (string), chargé depuis
// /api/state (voir api.js loadFromServer()). Toujours résolu "à plat" côté serveur
// (jamais de chaîne alias->alias->primary, voir linkPlayer() dans backend/db.js) —
// canonicalUid() n'a donc besoin de suivre le lien qu'une seule fois.
//
// Ne réécrit jamais games/playerStatsSnapshots : la fusion n'existe qu'au niveau de la
// résolution d'identité, ce qui la rend toujours réversible sans perte de donnée brute.
// Tout code qui compare des userId entre eux pour établir "est-ce le même joueur"
// (findPlayerInGame, rebuildPlayerIndex, filteredSnapshotsForUser, computeDuoNemesisStats,
// les tableaux "isMe" de historique.js...) doit passer par canonicalUid(), jamais comparer
// p.userId directement à un autre uid.

// Identifiant canonique ("primary") d'un joueur — lui-même si non fusionné.
export function canonicalUid(uid) {
  if (uid == null) return uid;
  const key = String(uid);
  const primary = state.playerLinks[key];
  return primary != null ? primary : key;
}

// Tous les alias connus pointant vers ce joueur canonique — utile pour retrouver ses
// captures de profil, stockées par compte EVA brut et jamais fusionnées elles-mêmes
// (voir seasons.js), ou pour lister les comptes déjà fusionnés dans l'UI admin.
export function aliasesOf(primaryUid) {
  const canon = String(primaryUid);
  return Object.keys(state.playerLinks).filter(alias => state.playerLinks[alias] === canon);
}

// Fusionne aliasUserId dans primaryUserId (réservé aux admins côté serveur, voir
// requireAdmin sur POST /api/player-links dans server.js).
export async function linkPlayers(aliasUserId, primaryUserId) {
  const link = await apiSend('POST', '/api/player-links', { aliasUserId, primaryUserId });
  state.playerLinks[link.aliasUserId] = link.primaryUserId;
  return link;
}

// Défusionne un alias — réversible, ne touche à aucune donnée brute.
export async function unlinkPlayer(aliasUserId) {
  await apiSend('DELETE', `/api/player-links/${aliasUserId}`);
  delete state.playerLinks[aliasUserId];
}

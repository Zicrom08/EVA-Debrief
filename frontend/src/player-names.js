import { state } from './state.js';
import { apiSend } from './api.js';
import { canonicalUid } from './player-links.js';

// ================= RENOMMAGE MANUEL DE JOUEUR (admin) =================
// state.playerNames : userId canonique -> nom personnalisé, chargé depuis /api/state
// (voir api.js loadFromServer()). Le pseudo AUTO-détecté (voir latestNiceName() dans
// format.js) suit déjà le pseudo le plus récemment vu en jeu — ce renommage forcé sert
// pour le cas où l'admin veut un nom différent de ce que le jeu renvoie littéralement
// (ex: retirer un tag d'équipe de l'affichage, corriger un pseudo à la graphie
// trompeuse...). N'affecte aucune donnée de partie, toujours réversible.

// Injecte les renommages manuels dans l'index des joueurs (state.players, construit par
// rebuildPlayerIndex() dans player-index.js) avec un poids infini dans niceNames, pour
// toujours gagner le tri de latestNiceName() — visible partout où un nom de joueur est
// affiché (resolvePlayerName() en dépend aussi) sans avoir à toucher chaque site
// d'affichage individuellement. Résolu par canonicalUid() : un renommage posé avant une
// fusion de comptes suit son compte même si celui-ci devient ensuite un alias d'un autre
// joueur.
export function applyPlayerNameOverrides(players) {
  Object.entries(state.playerNames).forEach(([uid, name]) => {
    if (!name) return;
    const canon = canonicalUid(uid);
    if (!players[canon]) {
      players[canon] = { niceNames: {}, games: 0, wins: 0, losses: 0, kills: 0, deaths: 0, assists: 0, dmg: 0, score: 0 };
    }
    players[canon].niceNames[name] = Infinity;
  });
}

export async function setPlayerName(uid, name) {
  const res = await apiSend('PUT', `/api/player-names/${uid}`, { name });
  state.playerNames[res.uid] = res.name;
  return res;
}

// Réinitialise un joueur au pseudo auto-détecté (le plus récent vu en jeu).
export async function clearPlayerName(uid) {
  await apiSend('DELETE', `/api/player-names/${uid}`);
  delete state.playerNames[uid];
}

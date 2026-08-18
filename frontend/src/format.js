import { state } from './state.js';
import { canonicalUid, aliasesOf } from './player-links.js';

// Libellé affiché pour un rôle de compte (header + onglet Comptes) — doit
// rester cohérent avec auth.ROLES côté backend.
const ROLE_LABELS = { admin: 'Administrateur', contributor: 'Contributeur', readonly: 'Lecture seule' };
export function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

export function fmtDuration(sec){
  sec = sec || 0;
  const m = Math.floor(sec/60), s = sec%60;
  return `${m}:${String(s).padStart(2,'0')}`;
}
// Formate une date ISO en date + heure lisibles (français).
export function fmtDate(iso){
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', {day:'2-digit',month:'short'}) + ' · ' +
         d.toLocaleTimeString('fr-FR', {hour:'2-digit',minute:'2-digit'});
}
// Formate une date ISO en date courte (jour/mois).
export function fmtDateShort(iso){
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', {day:'2-digit',month:'short',year:'2-digit'});
}
// Retrouve l'entrée d'un joueur (par userId) parmi les participants d'une partie. Compare
// par identifiant canonique (voir player-links.js) : si `uid` a été fusionné avec un autre
// compte (ou vice-versa), la partie où c'est l'AUTRE compte qui a joué doit quand même
// matcher — c'est tout l'intérêt de la fusion de comptes.
export function findPlayerInGame(g, uid){
  const target = canonicalUid(uid);
  return (g.players||[]).find(p => canonicalUid(p.userId) === target);
}
// Raccourci pour retrouver le joueur actuellement sélectionné (state.currentUid) dans une partie.
export function findSelf(g){ return findPlayerInGame(g, state.currentUid); }

// Renvoie le pseudo le plus À JOUR d'un joueur — rec.niceNames associe chaque pseudo vu en
// jeu au poids le plus élevé qui lui a été attribué (voir rebuildPlayerIndex() dans
// player-index.js) : un horodatage de partie pour un pseudo auto-détecté (le plus récent
// gagne, pour qu'un changement de tag soit reflété dès la partie suivante plutôt que
// seulement une fois qu'il devient majoritaire), ou Infinity pour un renommage forcé par un
// admin (voir player-names.js), qui l'emporte toujours sur n'importe quel pseudo auto-détecté.
export function latestNiceName(rec){
  return Object.entries(rec.niceNames).sort((a,b)=>b[1]-a[1])[0][0];
}

// Explique la provenance du pseudo gagnant, pour le panneau d'analyse admin (voir
// comptes.js) : le poids qui a fait gagner ce pseudo EST son horodatage (voir
// rebuildPlayerIndex()), donc pas besoin de tracer la source séparément — seul le cas
// Infinity (renommage forcé, voir player-names.js) n'a pas de date réelle à afficher.
export function nameFreshness(rec){
  const [name, weight] = Object.entries(rec.niceNames).sort((a,b)=>b[1]-a[1])[0];
  if (weight === Infinity) return { name, forced: true, asOf: null };
  return { name, forced: false, asOf: new Date(weight).toISOString() };
}

// Retrouve le nom d'affichage d'un joueur par son userId, quelle que soit la source
// disponible : depuis juillet 2026, les parties importées (nouveau format d'historique
// EVA) ne portent plus aucun pseudo (p.data.niceName a disparu), donc state.players ne
// peut plus toujours en fournir un pour les nouvelles parties. On retombe alors sur le
// user/username capturé par une éventuelle snapshot de profil de ce joueur (le sien ou
// celui d'un coéquipier déjà importé), et en dernier recours sur son id brut. `uid` est
// résolu à son identifiant canonique (voir player-links.js) : state.players y est déjà
// indexé par rebuildPlayerIndex(), mais les captures de profil (state.playerStatsSnapshots)
// restent, elles, indexées par compte EVA brut et ne sont jamais fusionnées entre elles —
// on doit donc chercher parmi tous les alias connus de ce joueur, pas juste sa racine.
export function resolvePlayerName(uid) {
  const canon = canonicalUid(uid);
  const rec = state.players[canon];
  if (rec && rec.niceNames && Object.keys(rec.niceNames).length) return latestNiceName(rec);
  for (const candidate of [canon, ...aliasesOf(canon)]) {
    const snaps = state.playerStatsSnapshots[candidate];
    if (snaps && snaps.length) {
      const u = snaps[snaps.length - 1].user;
      if (u && (u.displayName || u.username)) return u.displayName || u.username;
    }
  }
  return `Joueur #${canon}`;
}

// Vrai si cette partie porte encore le détail complet de match (score par équipe,
// dégâts, précision, assignation Alliance/Rebels) — absent des parties importées
// depuis le changement d'API EVA de juillet 2026, qui ne fournit plus que le résultat
// et K/D/A par joueur. Sert à basculer entre la vue détail complète et une vue réduite.
export function hasFullMatchData(g) {
  return !!(g.data && (g.players || []).some(p => p.data && p.data.team));
}

// Retrouve le MVP d'une partie : le joueur avec le meilleur score toutes équipes
// confondues pour une partie à détail complet (voir hasFullMatchData) — le score
// n'existe plus sur le format réduit (nouvel historique EVA, juillet 2026), donc on
// retombe sur le flag isMvp fourni par EVA elle-même sur ce format, et en dernier
// recours sur le plus de kills si même ce flag est absent (ex: capture manuelle).
export function findMvp(g) {
  const players = g.players || [];
  if (!players.length) return null;
  if (hasFullMatchData(g)) {
    return players.reduce((best, p) => (p.data && p.data.score || 0) > (best.data && best.data.score || 0) ? p : best);
  }
  return players.find(p => p.isMvp)
    || players.reduce((best, p) => (p.data && p.data.kills || 0) > (best.data && best.data.kills || 0) ? p : best);
}

// Formate un nombre en notation française, avec un nombre de décimales personnalisable.
export function niceNum(n, decimals) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString('fr-FR', { maximumFractionDigits: decimals != null ? decimals : 1 });
}

// Formate un delta avec un "+" explicite pour les valeurs positives (les stats de
// saison ne devraient jamais reculer, mais un "+" rend la lecture immédiate).
export function fmtDelta(n, decimals) {
  decimals = decimals != null ? decimals : 0;
  const v = Number(n) || 0;
  const sign = v > 0 ? '+' : '';
  return sign + v.toLocaleString('fr-FR', { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

// Formate une durée en secondes en "X h Y min".
export function fmtHM(sec) {
  sec = sec || 0;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

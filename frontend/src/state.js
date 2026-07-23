// ============================================================================
// État mutable partagé de l'app (rechargé intégralement depuis le serveur à
// chaque import, voir loadFromServer() dans main.js) :
//   gamesById              { gameId -> partie brute (telle que renvoyée par l'API EVA) }
//   playerStatsSnapshots   { userId -> [capture de profil, ...] triées par date }
//   customTeams            { teamId -> { id, name, members: [userId, ...] } }
//   players                { userId -> { niceNames, games } }  — reconstruit par rebuildPlayerIndex()
//
// Exporté comme un seul objet plutôt que des `let` individuels : beaucoup de
// ces valeurs sont réassignées en bloc (loadFromServer, bouton Réinitialiser),
// et un import ES est un binding en lecture seule — un autre module ne peut
// pas faire `gamesById = {}`, mais peut toujours faire `state.gamesById = {}`
// (réassignation d'une propriété d'un objet importé, toujours légale).
// ============================================================================
export const state = {
  gamesById: {},              // id -> game node
  players: {},                // userId -> aggregated stats (from game history)
  playerStatsSnapshots: {},   // userId -> [snapshot, ...] sorted asc by capturedAt
  currentUid: null,
  activeGameId: null,
  trendMode: 'session',
  storageAvailable: true,
  dateRangeStart: null,       // timestamp (ms) ou null = pas de borne
  dateRangeEnd: null,         // timestamp (ms) ou null = pas de borne
  selectedSeasonId: null,     // seasonId choisi dans le filtre de saison, ou null = "Toutes les saisons"
  excludedMaps: new Set(),    // noms de cartes à exclure de toutes les analyses (ex: cartes mal étiquetées)
  excludedModes: new Set(),   // identifiants de mode à exclure (ex: modes PvE qui réutilisent un nom de carte PvP)
  knownModes: new Set(),      // modes déjà vus au moins une fois (pour n'appliquer le défaut auto-exclusion qu'une fois)
  customTeams: {},            // teamId -> { id, name, members:[uid,...] } — équipes créées manuellement par l'utilisateur
  teamAId: null,              // équipe sélectionnée dans l'onglet Équipes (vue principale / comparaison)
  teamBId: null,              // deuxième équipe pour la comparaison (optionnelle)
  profileCompareUid: null,    // joueur choisi pour la comparaison dans l'onglet Profil (optionnel)
  mapDeepDiveSelection: null, // nom de la carte sélectionnée pour le "focus carte" du Profil
  profileMetric: 'kd',        // 'kd' | 'dmg' | 'score' | 'acc' — métrique affichée dans les graphiques de progression du Profil
};

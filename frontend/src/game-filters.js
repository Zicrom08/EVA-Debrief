import { state } from './state.js';
import { findPlayerInGame, hasFullMatchData } from './format.js';

// ================= FILTRE DE PÉRIODE (s'applique à Historique / Suivi de performance / Profil / Comparatif) =================
export function inDateRange(iso) {
  const t = new Date(iso).getTime();
  if (state.dateRangeStart != null && t < state.dateRangeStart) return false;
  if (state.dateRangeEnd != null && t > state.dateRangeEnd) return false;
  return true;
}
// Vrai si cette partie appartient à la sélection de période/saison courante. Depuis le
// collecteur v9.0, chaque partie porte directement son propre `seasonId` (attaché par le
// collecteur à partir de la variable de la requête HistoryBa — l'API ne le renvoie jamais
// dans la réponse elle-même, voir eva_history_collector.user.js). Quand une saison précise
// est sélectionnée ET que la partie porte ce champ, on compare exactement plutôt que de
// passer par l'approximation par date (bornes de saison déduites des captures de profil,
// voir computeSeasons() dans seasons.js — toujours une approximation aux bords). On ne
// retombe sur l'approximation par date que pour les parties importées sans `seasonId`
// (importées avant ce changement) ou quand le filtre actif est une période libre plutôt
// qu'une saison précise.
export function gameInSelectedRange(g) {
  if (state.selectedSeasonId != null && g.seasonId != null) {
    return g.seasonId === state.selectedSeasonId;
  }
  return inDateRange(g.createdAt);
}
// Vrai si la carte de cette partie est dans la liste d'exclusion.
export function isMapExcluded(g) {
  const name = g.map && g.map.name;
  return !!name && state.excludedMaps.has(name);
}
// Vrai si le mode de cette partie est dans la liste d'exclusion.
export function isModeExcluded(g) {
  const id = g.mode && g.mode.identifier;
  return !!id && state.excludedModes.has(id);
}
// Filtre global de l'app : toutes les parties respectant la période sélectionnée et les exclusions de cartes/modes.
export function filteredGamesArray() {
  return Object.values(state.gamesById).filter(g => gameInSelectedRange(g) && !isMapExcluded(g) && !isModeExcluded(g));
}
// Filtre "composition" de l'Historique : vrai si, dans cette partie, tous les `teammateUids`
// sont dans la MÊME équipe que `uid` et tous les `opponentUids` sont dans l'équipe ADVERSE.
// Sans sélection (les deux ensembles vides) le filtre est inactif — toutes les parties passent.
// Nécessite l'assignation d'équipe par joueur (hasFullMatchData, voir format.js) : une partie
// qui ne la porte plus (nouveau format d'historique EVA, juillet 2026) est exclue dès qu'au
// moins un joueur est sélectionné, faute de pouvoir vérifier — jamais incluse "par défaut".
// Jamais de comparaison p.data.team === x.data.team non gardée (undefined === undefined vaut
// true en JS) : chaque comparaison vérifie explicitement que les deux équipes sont connues,
// même piège que documenté dans CLAUDE.md pour deriveTeams()/computeDuoNemesisStats().
export function gameMatchesComposition(g, uid, teammateUids, opponentUids) {
  const hasTeammates = teammateUids && teammateUids.size;
  const hasOpponents = opponentUids && opponentUids.size;
  if (!hasTeammates && !hasOpponents) return true;
  if (!hasFullMatchData(g)) return false;
  const self = findPlayerInGame(g, uid);
  const myTeam = self && self.data ? self.data.team : null;
  if (myTeam == null) return false;
  if (hasTeammates) {
    for (const tUid of teammateUids) {
      const p = findPlayerInGame(g, tUid);
      const team = p && p.data ? p.data.team : null;
      if (team == null || team !== myTeam) return false;
    }
  }
  if (hasOpponents) {
    for (const oUid of opponentUids) {
      const p = findPlayerInGame(g, oUid);
      const team = p && p.data ? p.data.team : null;
      if (team == null || team === myTeam) return false;
    }
  }
  return true;
}
// Parties filtrées, restreintes au joueur sélectionné et à la composition d'équipe choisie
// (voir gameMatchesComposition() ci-dessus), triées de la plus récente à la plus ancienne
// (utilisé par l'Historique).
export function sortedGames() {
  return filteredGamesArray()
    .filter(g => findPlayerInGame(g, state.currentUid))
    .filter(g => gameMatchesComposition(g, state.currentUid, state.compositionTeammates, state.compositionOpponents))
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Modes/cartes du matchmaking compétitif standard — tout le reste est exclu par défaut à sa
// PREMIÈRE apparition seulement (voir knownModes/knownMaps ci-dessous), pour que les analyses
// représentent les parties compétitives par défaut sans empêcher l'utilisateur de réintégrer
// manuellement un mode/une carte ensuite (panneau d'exclusion cartes/modes) — un mode/une carte
// déjà vu(e) une fois n'est plus jamais retouché(e) automatiquement, même si son statut par
// défaut changeait plus tard.
const DEFAULT_INCLUDED_MODES = ['Domination', 'Hardpoint'];
const DEFAULT_EXCLUDED_MAPS = ['Bastion', 'Coliseum', 'The Rock'];

// Certains modes (ex: "Moon of the Dead", un mode PvE en co-op contre des vagues d'ennemis)
// réutilisent le même nom de carte qu'un mode PvP classique (ex: "Ceres"), ce qui rend le
// filtre par carte insuffisant pour les séparer — on les distingue donc par mode de jeu. Un
// mode non-PvP (catégorie différente de "Pvp") est toujours exclu d'office (structure de score
// non comparable aux parties PvP Alliance/Rebels) ; parmi les modes PvP, seuls Domination et
// Hardpoint (DEFAULT_INCLUDED_MODES ci-dessus) restent inclus par défaut, les autres (Team
// Deathmatch, Free For All, Skirmish, Gun Game...) étant moins représentatifs du jeu
// compétitif standard. Même logique pour les cartes hors rotation compétitive
// (DEFAULT_EXCLUDED_MAPS). L'utilisateur peut réintégrer/exclure manuellement n'importe quel
// mode ou carte ensuite (panneau d'exclusion) — cette fonction ne fait que poser un point de
// départ raisonnable la première fois que chacun apparaît.
export function ensureFilterDefaults() {
  const seenModes = new Map(); // identifier -> category
  const seenMaps = new Set();
  Object.values(state.gamesById).forEach(g => {
    const id = g.mode && g.mode.identifier;
    const cat = g.mode && g.mode.category;
    if (id && !seenModes.has(id)) seenModes.set(id, cat);
    const mapName = g.map && g.map.name;
    if (mapName) seenMaps.add(mapName);
  });
  let changed = false;
  seenModes.forEach((cat, id) => {
    if (!state.knownModes.has(id)) {
      state.knownModes.add(id);
      if ((cat && cat !== 'Pvp') || !DEFAULT_INCLUDED_MODES.includes(id)) {
        state.excludedModes.add(id);
        changed = true;
      }
    }
  });
  seenMaps.forEach(name => {
    if (!state.knownMaps.has(name)) {
      state.knownMaps.add(name);
      if (DEFAULT_EXCLUDED_MAPS.includes(name)) {
        state.excludedMaps.add(name);
        changed = true;
      }
    }
  });
  return changed;
}

// Parties filtrées pour un joueur donné, triées chronologiquement (plus ancienne en premier) — utilisé pour les graphiques de progression.
export function gamesForPlayerSorted(uid) {
  return filteredGamesArray()
    .filter(g => findPlayerInGame(g, uid))
    .slice()
    .sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
}

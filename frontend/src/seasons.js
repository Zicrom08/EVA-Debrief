import { state } from './state.js';
import { inDateRange } from './game-filters.js';

// ============================================================================
// SAISONS — déduites des captures de profil (playerStatsSnapshots), seul endroit
// où l'info existe : chaque capture (getPlayerByUserId / getPublicPlayerByUsername)
// porte le numéro de saison en cours (experience.seasonId) au moment de la capture.
// Les parties elles-mêmes (cursorAfterhGameHistory) n'en portent aucune trace.
//
// On reconstruit donc les bornes de chaque saison à partir de la première/dernière
// capture connue portant ce numéro, tous joueurs confondus (le numéro de saison est
// global au jeu, pas par joueur). C'est une approximation : la vraie date de reset
// se situe quelque part entre la dernière capture de l'ancienne saison et la première
// de la nouvelle — on prend cette dernière comme frontière, ce qui est suffisant tant
// qu'on réimporte son profil peu après le début d'une nouvelle saison.
// ============================================================================

// Liste des saisons connues, triées de la plus ancienne à la plus récente.
export function computeSeasons() {
  const bounds = new Map(); // seasonId -> { min, max } (timestamps ms)
  Object.values(state.playerStatsSnapshots).forEach(list => {
    list.forEach(s => {
      const sid = s.experience && s.experience.seasonId;
      if (sid == null) return;
      const t = new Date(s.capturedAt).getTime();
      const b = bounds.get(sid);
      if (!b) bounds.set(sid, { min: t, max: t });
      else { if (t < b.min) b.min = t; if (t > b.max) b.max = t; }
    });
  });
  const ids = [...bounds.keys()].sort((a, b) => a - b);
  return ids.map((sid, i) => {
    const next = ids[i + 1];
    return {
      seasonId: sid,
      // saison la plus ancienne connue : borne basse ouverte (son vrai début est antérieur aux données importées)
      startTs: i === 0 ? null : bounds.get(sid).min,
      // null = saison en cours (pas encore de saison suivante détectée)
      endTs: next != null ? bounds.get(next).min : null,
      isCurrent: next == null,
    };
  });
}

// Sélectionne une saison par id (helper pour le filtre UI).
export function findSeason(seasons, seasonId) {
  return seasons.find(s => s.seasonId === seasonId) || null;
}

// Le numéro de saison renvoyé par l'API est décalé de +1 par rapport au numéro
// affiché en jeu (ex: l'API dit "saison 8" quand le jeu affiche "saison 7") — on
// corrige uniquement à l'affichage. Les comparaisons/filtres internes (regroupement,
// egalité, tri) doivent toujours utiliser la valeur brute experience.seasonId,
// jamais celle-ci, pour rester cohérents avec les données telles qu'importées.
export function displaySeasonId(rawSeasonId) {
  return rawSeasonId == null ? rawSeasonId : rawSeasonId - 1;
}

// Captures de profil d'un joueur pour la sélection courante : filtrage exact par
// numéro de saison si une saison est sélectionnée (le plus fiable, puisque le champ
// existe directement sur chaque capture), sinon filtrage par période classique
// (capturedAt), pour rester cohérent avec le filtre appliqué aux parties.
export function filteredSnapshotsForUser(uid) {
  const list = state.playerStatsSnapshots[uid] || [];
  if (state.selectedSeasonId != null) {
    return list.filter(s => s.experience && s.experience.seasonId === state.selectedSeasonId);
  }
  return list.filter(s => inDateRange(s.capturedAt));
}

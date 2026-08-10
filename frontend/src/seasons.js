import { state } from './state.js';
import { inDateRange } from './game-filters.js';
import { canonicalUid, aliasesOf } from './player-links.js';

// ============================================================================
// SAISONS — déduites de deux sources, combinées : les captures de profil
// (playerStatsSnapshots) et, depuis le collecteur v9.0, les parties elles-mêmes.
//
// Où trouver le numéro de saison varie selon la source et la version du collecteur :
// - captures de profil jusqu'à la v7 (capture passive de la réponse brute du site) :
//   experience.seasonId, tel que renvoyé par l'API à l'époque.
// - captures de profil depuis la v8.0 (requête enrichie custom, voir
//   eva_history_collector.user.js) : la requête réécrite ne redemande plus seasonId à
//   l'intérieur du bloc experience, seul le seasonId de la variable de requête (celui
//   qu'on a demandé) est connu — le collecteur le pose donc directement sur la capture
//   (snap.seasonId) plutôt que dans experience. snapshotSeasonId() ci-dessous lit l'un
//   ou l'autre pour rester compatible avec les deux générations : ne JAMAIS relire
//   `s.experience.seasonId` directement ailleurs dans le code, toujours passer par elle.
// - parties, depuis le collecteur v9.0 seulement : l'API ne renvoie le seasonId d'une
//   partie nulle part dans sa réponse (comme pour le profil), donc le collecteur l'attache
//   lui-même sur chaque nœud (`g.seasonId`) à partir de la variable de la requête
//   HistoryBa. Les parties importées avant la v9.0 n'ont pas ce champ. Voir
//   `gameInSelectedRange()` dans game-filters.js, qui l'utilise pour un filtrage exact
//   plutôt que l'approximation par date ci-dessous quand il est présent.
//
// On reconstruit donc les bornes de chaque saison à partir de la première/dernière capture
// (de profil OU de partie) connue portant ce numéro, tous joueurs confondus (le numéro de
// saison est global au jeu, pas par joueur). Mélanger les deux sources rend la liste des
// saisons disponible même pour un import qui ne contient que de l'historique de parties
// (sans capture de profil), et affine les bornes puisque les parties elles-mêmes sont des
// horodatages précis (contrairement aux captures de profil, qui ne datent que le moment où
// le joueur a rechargé sa page). C'est malgré tout toujours une approximation : la vraie
// date de reset se situe quelque part entre la dernière donnée connue de l'ancienne saison
// et la première de la nouvelle — on prend cette dernière comme frontière, ce qui est
// suffisant tant qu'on réimporte peu après le début d'une nouvelle saison.
// ============================================================================

// Numéro de saison brut d'une capture de profil, quelle que soit la génération du
// collecteur qui l'a produite (voir note ci-dessus) — null si aucune des deux sources
// n'est présente. Pour une partie, le champ équivalent est directement `g.seasonId`
// (pas de génération antérieure à gérer, ce champ n'existe que depuis le collecteur v9.0).
export function snapshotSeasonId(snap) {
  if (snap.seasonId != null) return snap.seasonId;
  return (snap.experience && snap.experience.seasonId != null) ? snap.experience.seasonId : null;
}

// Liste des saisons connues, triées de la plus ancienne à la plus récente.
export function computeSeasons() {
  const bounds = new Map(); // seasonId -> { min, max } (timestamps ms)
  function record(sid, t) {
    if (sid == null || Number.isNaN(t)) return;
    const b = bounds.get(sid);
    if (!b) bounds.set(sid, { min: t, max: t });
    else { if (t < b.min) b.min = t; if (t > b.max) b.max = t; }
  }
  Object.values(state.playerStatsSnapshots).forEach(list => {
    list.forEach(s => record(snapshotSeasonId(s), new Date(s.capturedAt).getTime()));
  });
  Object.values(state.gamesById).forEach(g => record(g.seasonId, new Date(g.createdAt).getTime()));
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
// egalité, tri) doivent toujours utiliser la valeur brute (snapshotSeasonId()),
// jamais celle-ci, pour rester cohérents avec les données telles qu'importées.
export function displaySeasonId(rawSeasonId) {
  return rawSeasonId == null ? rawSeasonId : rawSeasonId - 1;
}

// Toutes les captures de profil connues d'un joueur, alias fusionnés compris (voir
// player-links.js) — les captures de profil sont stockées par compte EVA brut et ne
// sont JAMAIS fusionnées entre elles (contrairement aux parties, où findPlayerInGame()
// résout déjà l'identité canonique), donc il faut explicitement rassembler celles de
// chaque alias en plus de celles du compte canonique. Triées par capturedAt croissant,
// comme state.playerStatsSnapshots[uid] l'est individuellement (voir api.js).
function allSnapshotsFor(uid) {
  const canon = canonicalUid(uid);
  const ids = [canon, ...aliasesOf(canon)];
  const combined = [];
  ids.forEach(id => { (state.playerStatsSnapshots[id] || []).forEach(s => combined.push(s)); });
  return combined.sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
}

// Captures de profil d'un joueur pour la sélection courante : filtrage exact par
// numéro de saison si une saison est sélectionnée (le plus fiable, puisque le champ
// existe directement sur chaque capture), sinon filtrage par période classique
// (capturedAt), pour rester cohérent avec le filtre appliqué aux parties.
export function filteredSnapshotsForUser(uid) {
  const list = allSnapshotsFor(uid);
  if (state.selectedSeasonId != null) {
    return list.filter(s => snapshotSeasonId(s) === state.selectedSeasonId);
  }
  return list.filter(s => inDateRange(s.capturedAt));
}

// Ligne de base pour la carte de saison : les stats de saison sont des compteurs
// CUMULÉS (pas des deltas), donc filtrer juste "quelle capture regarder" ne change
// quasiment rien à afficher — la carte montrerait toujours le cumul depuis le tout
// début de la saison, même en filtrant sur "7 derniers jours". Pour que le filtre de
// période ait un effet visible sur CES stats-là aussi, on cherche la dernière capture
// juste AVANT le début de la fenêtre filtrée, pour que renderSeasonCard() puisse
// soustraire et n'afficher que ce qui a été gagné PENDANT la période choisie.
//
// Pas de ligne de base (→ cumul brut affiché tel quel) quand :
// - une saison entière est sélectionnée, ou qu'aucun filtre n'est actif : les
//   compteurs partent alors implicitement de 0 (début de saison), donc le cumul de
//   la dernière capture EST déjà "ce qui a été gagné depuis le début de la période" ;
// - il n'existe aucune capture antérieure à la fenêtre (le filtre commence avant les
//   données connues) ;
// - la capture antérieure trouvée appartient à une AUTRE saison (reset entre les
//   deux) : elle ne veut plus rien dire comme point de comparaison. On compare
//   toujours à la saison de la capture la plus RÉCENTE de la sélection (`latest`,
//   celle que la carte affiche) plutôt qu'à la plus ancienne : si la fenêtre filtrée
//   chevauche elle-même un changement de saison, c'est la saison de `latest` qui
//   définit "depuis quand" on doit compter.
// EVA a changé la forme des stats de saison courant juillet 2026 : la page de profil
// connectée déclenche désormais plusieurs requêtes getPlayerByUserId (une par widget),
// et les stats de bataille sont passées de `statistics.data` (avec gameVictoryCount,
// gameDefeatCount, gameTime, inflictedDamage, bestInflictedDamage, traveledDistanceAverage)
// à `battleArenaStatistics.data` — un jeu de champs plus réduit (winRate, killDeathRatio,
// gameCount, killsAverage, kills, deaths, assists, bestKillStreak, mvpCount,
// traveledDistance) qui n'inclut plus ni le temps de jeu ni les dégâts.
//
// Depuis la v8.0 du collecteur (requête enrichie custom, voir eva_history_collector.user.js),
// la capture de profil redemande explicitement le bloc `statistics.data` complet — les
// nouvelles captures retombent donc à nouveau dans la branche "legacy" ci-dessous, avec
// tous les champs. La branche `battleArenaStatistics` ne reste utile que pour les captures
// plus anciennes déjà en base, faites par une version du collecteur antérieure à la v8.0
// (capture passive de la réponse par défaut du site, réduite depuis juillet 2026).
//
// On normalise les deux formes vers la même forme interne pour que le reste du code
// (carte de saison, tableau d'évolution) n'ait pas à connaître la différence. Les champs
// structurellement absents du format réduit restent marqués `hasPlaytime`/`hasDamage`
// à false plutôt que défaulter à 0 — un "0 dégât infligé" affiché serait trompeur (on ne
// SAIT juste plus), pas une vraie mesure.
export function normalizeSnapshotStats(snap) {
  const legacy = snap.statistics && snap.statistics.data;
  if (legacy) {
    return {
      gameCount: legacy.gameCount || 0,
      gameVictoryCount: legacy.gameVictoryCount || 0,
      gameDefeatCount: legacy.gameDefeatCount || 0,
      gameDrawCount: legacy.gameDrawCount || 0,
      kills: legacy.kills || 0,
      deaths: legacy.deaths || 0,
      assists: legacy.assists || 0,
      bestKillStreak: legacy.bestKillStreak || 0,
      traveledDistance: legacy.traveledDistance || 0,
      gameTime: legacy.gameTime || 0,
      inflictedDamage: legacy.inflictedDamage || 0,
      bestInflictedDamage: legacy.bestInflictedDamage || 0,
      hasPlaytime: true,
      hasDamage: true,
    };
  }
  const ba = snap.battleArenaStatistics && snap.battleArenaStatistics.data;
  if (ba) {
    const gameCount = ba.gameCount || 0;
    // gameVictoryCount n'existe plus tel quel : winRate (fraction 0-1) est la seule
    // trace du ratio V/D, on en déduit un compte approximatif (exact tant que winRate
    // est bien victoires/gameCount sans arrondi caché côté API).
    const gameVictoryCount = Math.round((ba.winRate || 0) * gameCount);
    return {
      gameCount,
      gameVictoryCount,
      gameDefeatCount: Math.max(0, gameCount - gameVictoryCount),
      gameDrawCount: 0,
      kills: ba.kills || 0,
      deaths: ba.deaths || 0,
      assists: ba.assists || 0,
      bestKillStreak: ba.bestKillStreak || 0,
      traveledDistance: ba.traveledDistance || 0,
      // "gameTime" est en fait toujours présent dans battleArenaStatistics.data (confirmé
      // par capture réseau août 2026, cf. eva_history_collector.user.js v9.3) — seuls
      // inflictedDamage/bestInflictedDamage manquent réellement de ce bloc réduit.
      gameTime: ba.gameTime || 0,
      inflictedDamage: 0,
      bestInflictedDamage: 0,
      hasPlaytime: ba.gameTime != null,
      hasDamage: false,
    };
  }
  return null;
}

export function seasonCardBaseline(uid, inRange) {
  if (!inRange.length) return null;
  if (state.selectedSeasonId != null) return null;
  if (state.dateRangeStart == null && state.dateRangeEnd == null) return null;

  const latest = inRange[inRange.length - 1];
  const latestSeason = snapshotSeasonId(latest);
  if (latestSeason == null) return null;

  const all = allSnapshotsFor(uid); // alias fusionnés compris, triés asc par capturedAt
  const windowStartT = new Date(inRange[0].capturedAt).getTime();
  const before = all.filter(s => {
    const sid = snapshotSeasonId(s);
    return sid === latestSeason && new Date(s.capturedAt).getTime() < windowStartT;
  });
  return before.length ? before[before.length - 1] : null;
}

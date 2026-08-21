import { state } from './state.js';
import { hasFullMatchData, deriveTeams } from './format.js';
import { canonicalUid } from './player-links.js';
import { computeMatchRatings } from './profil/compute.js';
import { gameInSelectedRange, isMapExcluded, isModeExcluded } from './game-filters.js';

// ================= RANG COMPÉTITIF (LP façon Elo + paliers) =================
// EVA n'expose aucune notion de LP/rang — c'est une statistique entièrement inventée et
// calculée ici à partir de l'historique de parties, comme tout le reste de cette app (aucune
// logique métier côté backend, rien n'est mis en cache : tout est recalculé à chaque rendu).
//
// Attention de nommage : "rang"/"rank" désigne déjà deux autres concepts dans ce code —
// p.data.rank (position d'arrivée 1-4 DANS un match, voir computeRankStats() dans
// profil/compute.js) et .rank-badge/.rank-badge.r1 (position de LIGNE dans le classement
// Comparatif, voir tables.css). Pour éviter la confusion, ce module n'utilise jamais
// l'identifiant nu `rank` : uniquement `lp`/`tier`. Le libellé UI "Rang" reste tel que
// demandé par l'utilisateur, avec un qualificatif à la première occurrence par vue (ex:
// "Rang compétitif" / "Rang (carrière)").

export const BASE_LP = 1000;
export const LP_FLOOR = 100;
export const K_OUTCOME = 28;
export const K_PERFORMANCE = 10;

// ================= PALIERS =================
// 8 rangs, chacun avec 3 divisions (III = entrée du rang, I = juste avant promotion — même
// convention que la plupart des jeux à ladder), chaque division large de DIVISION_WIDTH LP.
// Première passe non calibrée (aucune population historique pour caler les bornes) — à
// retoucher une fois une vraie saison ou deux jouées avec ce système.
const TIER_NAMES = ['Bronze', 'Argent', 'Or', 'Platine', 'Émeraude', 'Diamant', 'Prodige', 'Légende'];
const DIVISIONS = 3;
const DIVISION_WIDTH = 100;
const TIER_BASE = 100; // début de Bronze III, aligné avec LP_FLOOR
const ROMAN = { 1: 'I', 2: 'II', 3: 'III' };

function slugify(name) {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// Liste APLATIE de 24 paliers (8 rangs x 3 divisions), du plus bas au plus haut. Construite
// une fois au chargement du module, pas recalculée à chaque appel de lpToTier(). Bronze III
// est ouverte vers le bas et Légende I ouverte vers le haut (min/maxExclusive = ±Infinity) —
// sécurité défensive pour lpToTier(), même si LP_FLOOR empêche déjà tout LP réel de sortir
// de cette plage par le bas.
//
// Intervalles semi-ouverts [min, maxExclusive) — PAS [min, max] avec des bornes entières :
// le LP est une valeur flottante (les deltas Elo ne tombent presque jamais sur un entier
// rond), donc des bornes entières inclusives des deux côtés (ex: Or I = [900,999], Platine
// III = [1000,1099]) laissent un trou réel entre 999 et 1000 — toute valeur non-entière dans
// ce trou (ex: 999.4) ne correspond à AUCUN palier, TIERS.find() renvoie undefined, et
// l'ancien repli retombait sur Légende I (bug réel constaté : un joueur à ~999 LP après
// seulement 4 parties affiché en Légende I, alors que BASE_LP=1000 — début de Platine III —
// place justement les joueurs récents pile à la lisière de ce trou). maxExclusive de chaque
// palier == min du palier suivant par construction : aucun trou, aucun chevauchement possible.
// naturalMin reste une borne finie (utilisée pour le calcul de progressPct) ; `max` (entier,
// inclusif) n'est là que pour l'affichage humain d'une plage — jamais utilisé pour le matching.
export const TIERS = TIER_NAMES.flatMap((tierName, tierIndex) =>
  Array.from({ length: DIVISIONS }, (_, i) => {
    const division = DIVISIONS - i; // i=0 -> III, i=1 -> II, i=2 -> I
    const bandIndex = tierIndex * DIVISIONS + i;
    const naturalMin = TIER_BASE + bandIndex * DIVISION_WIDTH;
    const isFirst = bandIndex === 0;
    const isLast = bandIndex === TIER_NAMES.length * DIVISIONS - 1;
    return {
      tierKey: slugify(tierName),
      tierName,
      division,
      name: `${tierName} ${ROMAN[division]}`,
      min: isFirst ? -Infinity : naturalMin,
      maxExclusive: isLast ? Infinity : naturalMin + DIVISION_WIDTH,
      max: isLast ? Infinity : naturalMin + DIVISION_WIDTH - 1, // affichage seulement
      naturalMin,
    };
  })
);

// Recherche linéaire sur les 24 entrées (liste courte, pas besoin de recherche binaire). Les
// intervalles semi-ouverts ci-dessus couvrent tout l'axe réel sans trou, donc .find() trouve
// toujours un palier pour un LP fini valide ; seul un lp non-fini (NaN — ne devrait jamais
// arriver, voir computeLpHistory) retombe sur le palier le plus bas plutôt que le plus haut,
// pour échouer discrètement plutôt que d'afficher un rang flatteur mais faux.
// progressPct = progression DANS la division courante (pas dans tout le rang) — utile pour
// une barre de progression façon "combien avant la division suivante".
export function lpToTier(lp) {
  const tier = TIERS.find(t => lp >= t.min && lp < t.maxExclusive) || TIERS[0];
  const progressPct = Math.max(0, Math.min(100, Math.round(((lp - tier.naturalMin) / DIVISION_WIDTH) * 100)));
  return {
    tierKey: tier.tierKey,
    tierName: tier.tierName,
    division: tier.division,
    name: tier.name,
    min: tier.min,
    max: tier.max,
    lp,
    progressPct,
  };
}

// ================= MOTEUR LP =================
// Rejoue TOUTES les parties fournies (n'importe quel ordre en entrée — re-triées en interne
// par createdAt croissant, condition de correction du rejeu chronologique) et renvoie le LP
// courant + trajectoire de chaque joueur. Ignore les parties sans détail complet (voir
// hasFullMatchData, même garde que computeMatchRatings) et celles où deriveTeams() ne peut
// pas séparer en deux équipes non vides (une moyenne d'équipe vide serait NaN et
// empoisonnerait tout le rejeu qui suit). Un joueur jamais vu dans `games` n'a AUCUNE entrée
// dans les deux Maps (pas de BASE_LP par défaut juste pour exister) — laisse l'appelant
// afficher "n/d" plutôt qu'un chiffre trompeur, même convention que NA ailleurs dans le
// Profil et hasDamage/hasPlaytime dans seasons.js.
//
// Pour chaque partie : les deux équipes sont comparées façon Elo standard sur leur LP moyen
// courant (BASE_LP par défaut pour un joueur jamais vu). Le résultat réel de chaque joueur
// vient de SON PROPRE p.data.outcome (jamais re-dérivé du score d'équipe) — Victory=1,
// Defeat=0, toute autre valeur (match nul, valeur inconnue)=0.5, pour ne pas punir les deux
// équipes comme si elles avaient perdu sur un résultat que personne n'a réellement perdu. Un
// bonus/malus de performance (voir computeMatchRatings — score+dégâts+KDA en un seul chiffre,
// 1.00 = moyenne du lobby de cette partie) s'ajoute ADDITIVEMENT à ce delta d'issue, jamais
// multiplicativement (un multiplicatif inverserait le signe : une bonne perf individuelle
// dans une défaite ferait perdre PLUS de LP au lieu de moins).
export function computeLpHistory(games, opts) {
  opts = opts || {};
  const kOutcome = opts.kOutcome != null ? opts.kOutcome : K_OUTCOME;
  const kPerformance = opts.kPerformance != null ? opts.kPerformance : K_PERFORMANCE;
  const baseLp = opts.baseLp != null ? opts.baseLp : BASE_LP;
  const lpFloor = opts.lpFloor != null ? opts.lpFloor : LP_FLOOR;

  const eligible = games.filter(g => {
    if (!hasFullMatchData(g)) return false;
    const { teamA, teamB } = deriveTeams(g);
    return teamA.length > 0 && teamB.length > 0;
  });
  const sorted = eligible.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const lpByUid = new Map();
  const historyByUid = new Map();
  const lpOf = uid => (lpByUid.has(uid) ? lpByUid.get(uid) : baseLp);

  sorted.forEach(g => {
    const { teamA, teamB } = deriveTeams(g);
    const ratings = computeMatchRatings(g);

    const teamAAvg = teamA.reduce((sum, p) => sum + lpOf(canonicalUid(p.userId)), 0) / teamA.length;
    const teamBAvg = teamB.reduce((sum, p) => sum + lpOf(canonicalUid(p.userId)), 0) / teamB.length;
    const expectedA = 1 / (1 + Math.pow(10, (teamBAvg - teamAAvg) / 400));

    const applyTeam = (team, expected) => {
      team.forEach(p => {
        const uid = canonicalUid(p.userId);
        const oldLp = lpOf(uid);
        const outcome = p.data.outcome;
        const actual = outcome === 'Victory' ? 1 : outcome === 'Defeat' ? 0 : 0.5;
        const perf = ratings.get(uid);
        const perfClamped = perf == null ? 0 : Math.max(-1, Math.min(1, perf - 1));
        const outcomeDelta = kOutcome * (actual - expected);
        const perfBonus = kPerformance * perfClamped;
        const delta = outcomeDelta + perfBonus;
        const newLp = Math.max(lpFloor, oldLp + delta);

        lpByUid.set(uid, newLp);
        if (!historyByUid.has(uid)) historyByUid.set(uid, []);
        historyByUid.get(uid).push({
          gameId: g.id, createdAt: g.createdAt,
          lpBefore: oldLp, lpAfter: newLp, delta, outcomeDelta, perfBonus,
          expected, actual, perf,
        });
      });
    };
    applyTeam(teamA, expectedA);
    applyTeam(teamB, 1 - expectedA);
  });

  return { lpByUid, historyByUid, gamesUsed: sorted.length };
}

// ================= PORTÉE =================
// Portée dédiée au LP — DÉLIBÉRÉMENT différente du contrat uniforme "période + saison +
// carte/mode" que respecte tout le reste de game-filters.js (voir sa docstring : "every tab
// is expected to respect the same period/season/map/mode filters uniformly"). Reste dans CE
// fichier plutôt que game-filters.js pour ne pas casser cette promesse d'uniformité pour
// quiconque lit/étend ce fichier plus tard. Une saison précise sélectionnée (état choisi par
// l'utilisateur) -> LP rejoué depuis une base neutre, restreint aux parties de CETTE saison
// (reset façon ranked saisonnier, réutilise gameInSelectedRange() : seasonId exact si la
// partie le porte, sinon repli sur les bornes de date de la saison). Aucune saison
// sélectionnée -> carrière complète, en ignorant délibérément une période libre/custom
// éventuellement active (dateRangeStart/dateRangeEnd) — seule la sélection de saison change
// la portée du LP. Les exclusions carte/mode (qualité de données, pas un filtre de période)
// s'appliquent, elles, toujours.
export function gamesForLpScope() {
  const base = Object.values(state.gamesById).filter(g => !isMapExcluded(g) && !isModeExcluded(g));
  if (state.selectedSeasonId != null) return base.filter(g => gameInSelectedRange(g));
  return base;
}

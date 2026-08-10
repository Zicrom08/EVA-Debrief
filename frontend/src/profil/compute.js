import { findPlayerInGame, resolvePlayerName } from '../format.js';
import { computeSessions } from '../tendances.js';
import { canonicalUid } from '../player-links.js';

// ================= PROFIL : helpers d'analyse (depuis l'historique de parties) =================

// Extrait la valeur d'une métrique (K/D, dégâts, score, précision) pour un joueur dans une partie donnée.
export function metricValue(p, metric) {
  const d = p.data;
  switch (metric) {
    case 'kd': return d.deaths ? d.kills / d.deaths : (d.kills || 0);
    case 'dmg': return d.inflictedDamage || 0;
    case 'score': return d.score || 0;
    case 'acc': return Math.round((d.firedAccuracy || 0) * 100);
    default: return 0;
  }
}

// Calcule une moyenne glissante sur une série de valeurs.
export function rollingAverage(values, window) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    out.push(slice.reduce((a,b) => a+b, 0) / slice.length);
  }
  return out;
}

// Calcule le taux de victoire glissant sur une fenêtre de N parties.
export function computeRollingWinRate(games, uid, window) {
  const outcomes = games.map(g => {
    const p = findPlayerInGame(g, uid);
    return p && p.data.outcome === 'Victory' ? 1 : 0;
  });
  const rolled = [];
  for (let i = 0; i < outcomes.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = outcomes.slice(start, i + 1);
    rolled.push(Math.round((slice.reduce((a,b)=>a+b,0) / slice.length) * 100));
  }
  return rolled;
}

// Agrège les stats d'un joueur par carte.
export function computeMapStats(games, uid) {
  const map = {};
  games.forEach(g => {
    const p = findPlayerInGame(g, uid);
    if (!p) return;
    const name = (g.map && g.map.name) || '?';
    if (!map[name]) map[name] = { n:0, wins:0, kills:0, deaths:0, dmg:0 };
    const m = map[name];
    m.n++;
    if (p.data.outcome === 'Victory') m.wins++;
    m.kills += p.data.kills || 0;
    m.deaths += p.data.deaths || 0;
    m.dmg += p.data.inflictedDamage || 0;
  });
  return Object.entries(map).map(([name, m]) => ({
    name, n: m.n,
    winrate: Math.round((m.wins / m.n) * 100),
    kd: m.deaths ? (m.kills / m.deaths).toFixed(2) : m.kills.toFixed(2),
    avgDmg: Math.round(m.dmg / m.n),
  })).sort((a,b) => b.n - a.n);
}

// Agrège les stats d'un joueur par mode de jeu.
export function computeModeStats(games, uid) {
  const modes = {};
  games.forEach(g => {
    const p = findPlayerInGame(g, uid);
    if (!p) return;
    const name = (g.mode && g.mode.identifier) || '?';
    if (!modes[name]) modes[name] = { n:0, wins:0, kills:0, deaths:0 };
    const m = modes[name];
    m.n++;
    if (p.data.outcome === 'Victory') m.wins++;
    m.kills += p.data.kills || 0;
    m.deaths += p.data.deaths || 0;
  });
  return Object.entries(modes).map(([name, m]) => ({
    name, n: m.n,
    winrate: Math.round((m.wins / m.n) * 100),
    kd: m.deaths ? (m.kills / m.deaths).toFixed(2) : m.kills.toFixed(2),
  })).sort((a,b) => b.n - a.n);
}

// Agrège le taux de victoire d'un joueur par jour de la semaine.
export function computeDayOfWeekStats(games, uid) {
  const labels = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];
  const n = [0,0,0,0,0,0,0], wins = [0,0,0,0,0,0,0];
  games.forEach(g => {
    const p = findPlayerInGame(g, uid);
    if (!p) return;
    const d = new Date(g.createdAt).getDay();
    n[d]++;
    if (p.data.outcome === 'Victory') wins[d]++;
  });
  // réordonne Lun→Dim pour un affichage plus naturel
  const order = [1,2,3,4,5,6,0];
  return order.map(i => ({
    label: labels[i], n: n[i],
    winrate: n[i] ? Math.round((wins[i]/n[i])*100) : null,
  }));
}

// Agrège le taux de victoire d'un joueur par moment de la journée.
export function computeTimeOfDayStats(games, uid) {
  const buckets = [
    { label: 'Nuit (0h–6h)', from: 0, to: 6 },
    { label: 'Matin (6h–12h)', from: 6, to: 12 },
    { label: 'Après-midi (12h–18h)', from: 12, to: 18 },
    { label: 'Soirée (18h–24h)', from: 18, to: 24 },
  ];
  const counts = buckets.map(() => ({ n: 0, wins: 0 }));
  games.forEach(g => {
    const p = findPlayerInGame(g, uid);
    if (!p) return;
    const h = new Date(g.createdAt).getHours();
    const idx = buckets.findIndex(b => h >= b.from && h < b.to);
    if (idx >= 0) {
      counts[idx].n++;
      if (p.data.outcome === 'Victory') counts[idx].wins++;
    }
  });
  return buckets.map((b, i) => ({
    label: b.label, n: counts[i].n,
    winrate: counts[i].n ? Math.round((counts[i].wins / counts[i].n) * 100) : null,
  }));
}

// Agrège les performances selon la position de la partie dans la séance de jeu (1ère, 2e, 3e...).
export function computeSessionFatigue(games, uid, gapMinutes) {
  const sessions = computeSessions(games, uid, gapMinutes || 45);
  const maxLen = Math.min(6, Math.max(0, ...sessions.map(s => s.games.length)));
  if (maxLen === 0) return [];
  const buckets = [];
  for (let i = 0; i < maxLen; i++) buckets.push({ n:0, wins:0, kills:0, deaths:0 });
  sessions.forEach(s => {
    s.games.forEach((g, idx) => {
      const p = findPlayerInGame(g, uid);
      if (!p) return;
      const bIdx = Math.min(idx, maxLen - 1);
      const b = buckets[bIdx];
      b.n++;
      if (p.data.outcome === 'Victory') b.wins++;
      b.kills += p.data.kills || 0;
      b.deaths += p.data.deaths || 0;
    });
  });
  return buckets.map((b, i) => ({
    label: (i === maxLen - 1) ? `${i+1}e partie et +` : `${i+1}${i===0?'ère':'e'} partie de la séance`,
    n: b.n,
    winrate: b.n ? Math.round((b.wins / b.n) * 100) : null,
    kd: b.deaths ? (b.kills / b.deaths).toFixed(2) : (b.kills||0).toFixed(2),
  })).filter(b => b.n > 0);
}

// Répartit les parties d'un joueur en tranches de ratio K/D, pour l'histogramme de régularité.
export function computeKDDistribution(games, uid) {
  const bins = [
    { label: '0 – 0.5', min: 0, max: 0.5 },
    { label: '0.5 – 1', min: 0.5, max: 1 },
    { label: '1 – 1.5', min: 1, max: 1.5 },
    { label: '1.5 – 2', min: 1.5, max: 2 },
    { label: '2 +', min: 2, max: Infinity },
  ];
  const counts = bins.map(() => 0);
  games.forEach(g => {
    const p = findPlayerInGame(g, uid);
    if (!p) return;
    const kd = p.data.deaths ? p.data.kills / p.data.deaths : (p.data.kills || 0);
    let idx = bins.findIndex(b => kd >= b.min && kd < b.max);
    if (idx < 0) idx = bins.length - 1;
    counts[idx]++;
  });
  const maxCount = Math.max(...counts, 1);
  return bins.map((b, i) => ({ label: b.label, n: counts[i], pct: Math.round((counts[i] / maxCount) * 100) }));
}

// Calcule la série en cours, la meilleure série de victoires et la pire série de défaites.
export function computeStreaks(games, uid) {
  let bestWin = 0, worstLoss = 0, curWin = 0, curLoss = 0;
  games.forEach(g => {
    const p = findPlayerInGame(g, uid);
    if (!p) return;
    if (p.data.outcome === 'Victory') { curWin++; curLoss = 0; bestWin = Math.max(bestWin, curWin); }
    else if (p.data.outcome === 'Defeat') { curLoss++; curWin = 0; worstLoss = Math.max(worstLoss, curLoss); }
  });
  let currentType = null, currentCount = 0;
  for (let i = games.length - 1; i >= 0; i--) {
    const p = findPlayerInGame(games[i], uid);
    if (!p) continue;
    const o = p.data.outcome;
    if (currentType === null) { currentType = o; currentCount = 1; }
    else if (o === currentType) currentCount++;
    else break;
  }
  return { bestWin, worstLoss, currentType, currentCount };
}

// Retrouve les meilleures/pires parties d'un joueur (meilleur K/D, plus gros dégâts, meilleur/pire score).
export function bestWorstGames(games, uid) {
  let bestKD = null, bestDmg = null, bestScore = null, worst = null;
  games.forEach(g => {
    const p = findPlayerInGame(g, uid);
    if (!p) return;
    const kd = p.data.deaths ? p.data.kills / p.data.deaths : (p.data.kills || 0);
    if (!bestKD || kd > bestKD.kd) bestKD = { game:g, player:p, kd };
    if (!bestDmg || (p.data.inflictedDamage||0) > bestDmg.val) bestDmg = { game:g, player:p, val: p.data.inflictedDamage||0 };
    if (!bestScore || (p.data.score||0) > bestScore.val) bestScore = { game:g, player:p, val: p.data.score||0 };
    if (!worst || (p.data.score||0) < worst.val) worst = { game:g, player:p, val: p.data.score||0 };
  });
  return { bestKD, bestDmg, bestScore, worst };
}

// Duo (synergie avec les coéquipiers) & Némésis (adversaires contre qui tu gagnes le moins) —
// calculés en croisant, pour chaque partie du joueur, tous les autres joueurs présents
// (coéquipiers = même "team" que lui, adversaires = l'autre équipe).
export function computeDuoNemesisStats(games, uid, minGames) {
  minGames = minGames || 3;
  const teammates = {};
  const opponents = {};
  const myCanon = canonicalUid(uid);

  games.forEach(g => {
    const me = findPlayerInGame(g, uid);
    if (!me) return;
    const myTeam = me.data.team;
    // Sans assignation d'équipe (nouveau format d'historique EVA, juillet 2026), on ne
    // peut plus distinguer coéquipiers d'adversaires — undefined === undefined classerait
    // TOUT le monde comme coéquipier, ce qui serait faux : on ignore la partie à la place.
    if (myTeam == null) return;
    const won = me.data.outcome === 'Victory';
    (g.players || []).forEach(p => {
      // Comparaison par identifiant canonique (pas seulement p.userId == uid) : si le
      // joueur a deux comptes fusionnés présents dans la même partie (rare mais possible),
      // il ne doit pas apparaître comme son propre duo/némésis.
      if (canonicalUid(p.userId) === myCanon) return;
      const bucket = p.data.team === myTeam ? teammates : opponents;
      const oid = canonicalUid(p.userId);
      const name = p.data.niceName || resolvePlayerName(p.userId);
      if (!bucket[oid]) bucket[oid] = { n: 0, wins: 0, name };
      bucket[oid].n++;
      if (won) bucket[oid].wins++;
      bucket[oid].name = name;
    });
  });

  function toArray(bucket) {
    return Object.entries(bucket)
      .map(([oid, rec]) => ({
        uid: oid, name: rec.name, n: rec.n, wins: rec.wins,
        winrate: rec.n ? Math.round((rec.wins / rec.n) * 100) : 0,
      }))
      .filter(r => r.n >= minGames);
  }

  const duoArr = toArray(teammates).sort((a,b) => b.winrate - a.winrate || b.n - a.n);
  const nemesisArr = toArray(opponents).sort((a,b) => a.winrate - b.winrate || b.n - a.n);

  return { duoArr, nemesisArr, minGames };
}

// Calcule la répartition des rangs d'équipe (classement en fin de partie) et le taux de MVP.
export function computeRankStats(games, uid) {
  const counts = {};
  let total = 0;
  games.forEach(g => {
    const p = findPlayerInGame(g, uid);
    if (!p || p.data.rank == null) return;
    const r = p.data.rank;
    counts[r] = (counts[r] || 0) + 1;
    total++;
  });
  const dist = [];
  for (let r = 1; r <= 4; r++) {
    dist.push({ label: `Rang ${r}${r===1?' (MVP équipe)':''}`, n: counts[r] || 0 });
  }
  let rest = 0;
  Object.entries(counts).forEach(([r, n]) => { if (Number(r) > 4) rest += n; });
  if (rest > 0) dist.push({ label: 'Rang 5+', n: rest });
  const mvpCount = counts[1] || 0;
  const mvpRate = total ? Math.round((mvpCount / total) * 100) : 0;
  return { dist, total, mvpRate };
}

// Calcule, partie par partie, la part du score total de l'équipe apportée par le joueur.
export function computeContributionTrend(games, uid) {
  return games.map(g => {
    const p = findPlayerInGame(g, uid);
    // Sans assignation d'équipe (nouveau format d'historique EVA), impossible de savoir
    // qui est dans l'équipe du joueur — undefined === undefined regrouperait TOUT le
    // monde à tort, donc on exclut la partie plutôt que de calculer une contribution fausse.
    if (!p || p.data.team == null) return null;
    const teamPlayers = (g.players || []).filter(pl => pl.data.team === p.data.team);
    const teamTotal = teamPlayers.reduce((s, pl) => s + (pl.data.score || 0), 0);
    return teamTotal ? Math.round((p.data.score / teamTotal) * 100) : 0;
  }).filter(v => v !== null);
}

// Calcule, partie par partie, la part des dégâts totaux de l'équipe apportée par le joueur.
export function computeDamageContributionTrend(games, uid) {
  return games.map(g => {
    const p = findPlayerInGame(g, uid);
    if (!p || p.data.team == null) return null;
    const teamPlayers = (g.players || []).filter(pl => pl.data.team === p.data.team);
    const teamTotal = teamPlayers.reduce((s, pl) => s + (pl.data.inflictedDamage || 0), 0);
    return teamTotal ? Math.round(((p.data.inflictedDamage || 0) / teamTotal) * 100) : 0;
  }).filter(v => v !== null);
}

// Calcule les dégâts moyens de l'équipe et la part moyenne apportée par le joueur.
export function computeDamageTeamStats(games, uid) {
  let n = 0, teamDmgSum = 0, playerDmgSum = 0;
  games.forEach(g => {
    const p = findPlayerInGame(g, uid);
    if (!p || p.data.team == null) return;
    const teamPlayers = (g.players || []).filter(pl => pl.data.team === p.data.team);
    const teamTotal = teamPlayers.reduce((s, pl) => s + (pl.data.inflictedDamage || 0), 0);
    teamDmgSum += teamTotal;
    playerDmgSum += p.data.inflictedDamage || 0;
    n++;
  });
  return {
    avgTeamDmg: n ? Math.round(teamDmgSum / n) : 0,
    avgPlayerDmg: n ? Math.round(playerDmgSum / n) : 0,
    avgContribPct: teamDmgSum ? Math.round((playerDmgSum / teamDmgSum) * 100) : 0,
  };
}

// Score composite (0-100) pondérant le taux de victoire et l'impact sur l'équipe, plutôt
// que le skill brut (K/D, précision...) — répond à "est-ce que je fais gagner mon équipe ?"
// plutôt qu'à "suis-je performant individuellement ?" (déjà couvert par computeEfficiencyStats).
//
// Le winrate est déjà sur une échelle 0-100 avec un point de référence naturel (50% = pile
// ou face). La contribution aux dégâts d'équipe (part des dégâts totaux de l'équipe apportée
// par le joueur, voir computeDamageTeamStats) n'a pas cette propriété : sa "juste part"
// dépend de la taille de l'équipe ce jour-là (25% pour 4, 33% pour 3...), donc on la
// normalise partie par partie contre cette juste part avant de moyenner. Un ratio de 1.0
// (exactement la juste part) vaut 50 points sur l'indice de contribution — même sémantique
// que le winrate ("50 = dans la moyenne") — un ratio de 2.0+ (le double de la juste part ou
// plus) plafonne à 100. Les parties sans assignation d'équipe (voir hasFullMatchData côté
// format.js) sont ignorées pour ce volet, même garde que computeDamageTeamStats.
//
// Si aucune partie de la période n'a de contribution exploitable (import list-only complet),
// contribIndex reste `null` et le score retombe sur le winrate seul plutôt que d'inventer
// une contribution — l'appelant doit afficher "n/d" pour ce volet dans ce cas, pas un 0.
export function computeImpactScore(games, uid) {
  let wins = 0, n = 0;
  let contribSum = 0, contribGames = 0;
  games.forEach(g => {
    const p = findPlayerInGame(g, uid);
    if (!p) return;
    n++;
    if (p.data.outcome === 'Victory') wins++;
    if (p.data.team == null) return;
    const teamPlayers = (g.players || []).filter(pl => pl.data.team === p.data.team);
    if (teamPlayers.length < 2) return; // seul dans son "équipe" ce jour-là, pas de juste part à comparer
    const teamTotal = teamPlayers.reduce((s, pl) => s + (pl.data.inflictedDamage || 0), 0);
    if (!teamTotal) return;
    const fairShare = 100 / teamPlayers.length;
    const contribPct = ((p.data.inflictedDamage || 0) / teamTotal) * 100;
    const ratio = contribPct / fairShare;
    contribSum += Math.min(100, ratio * 50);
    contribGames++;
  });
  const winrate = n ? Math.round((wins / n) * 100) : 0;
  const contribIndex = contribGames ? Math.round(contribSum / contribGames) : null;
  const score = contribIndex == null ? winrate : Math.round(winrate * 0.5 + contribIndex * 0.5);
  return { score, winrate, contribIndex, n, contribGames };
}

// ================= RATING (façon HLTV) =================
// EVA n'a ni round, ni KAST, ni détection de trade-kill — la vraie formule HLTV Rating
// 2.0/2.1 (régression linéaire sur KAST/KPR/DPR/Impact/ADR calée sur des données pro CS)
// ne peut donc pas être reproduite telle quelle. Ce qu'on reprend de son esprit : UN seul
// chiffre, centré sur 1.00 = performance moyenne, combinant plusieurs stats (pas juste K/D)
// pondérées par importance plutôt qu'une simple somme.
//
// Méthode : chaque stat du joueur (moyenne par partie sur la période) est exprimée en ratio
// par rapport à la moyenne de TOUS les joueurs croisés dans les mêmes parties (voir
// computeRatingBaseline — même population que le classement Comparatif). Un ratio de 1.00
// veut dire "exactement dans la moyenne" pour cette stat ; les morts sont inversées (moins
// mourir que la moyenne doit augmenter le ratio, pas le baisser) pour que les 5 composantes
// partagent la même lecture "plus haut = mieux". Chaque ratio est plafonné à
// RATING_RATIO_CAP avant pondération, pour qu'une partie exceptionnelle (ou une moyenne
// d'échantillon trop petit) ne fasse pas exploser le résultat final. Les poids sont un choix
// arbitraire assumé (kills/dégâts pèsent le plus, à l'image de KPR/ADR dans HLTV 2.0/2.1) —
// à ajuster si l'usage montre qu'une autre pondération reflète mieux "qui a bien joué".
const RATING_WEIGHTS = { kills: 0.30, deaths: 0.25, dmg: 0.25, assists: 0.10, score: 0.10 };
const RATING_RATIO_CAP = 3;

function ratingRatio(playerAvg, baselineAvg, invert) {
  if (!baselineAvg) return 1; // population sans référence exploitable pour cette stat -> composante neutre
  const r = invert
    ? (playerAvg ? baselineAvg / playerAvg : RATING_RATIO_CAP)
    : (playerAvg / baselineAvg);
  return Math.max(0, Math.min(RATING_RATIO_CAP, r));
}

// Moyennes de référence (kills/morts/assists/dégâts/score par partie jouée, tous joueurs
// confondus) sur un ensemble de parties — le "1.00" auquel chaque joueur est comparé par
// computeRating(). À calculer une seule fois sur la période filtrée (voir filteredGamesArray
// côté game-filters.js) et réutiliser pour chaque joueur, pas par joueur individuellement.
export function computeRatingBaseline(games) {
  let n = 0, kills = 0, deaths = 0, assists = 0, dmg = 0, score = 0;
  games.forEach(g => {
    (g.players || []).forEach(p => {
      if (!p || !p.data) return;
      n++;
      kills += p.data.kills || 0;
      deaths += p.data.deaths || 0;
      assists += p.data.assists || 0;
      dmg += p.data.inflictedDamage || 0;
      score += p.data.score || 0;
    });
  });
  return {
    n,
    avgKills: n ? kills / n : 0,
    avgDeaths: n ? deaths / n : 0,
    avgAssists: n ? assists / n : 0,
    avgDmg: n ? dmg / n : 0,
    avgScore: n ? score / n : 0,
  };
}

// Rating façon HLTV pour un joueur sur `games` (déjà filtrées à ce joueur), comparé à
// `baseline` (voir computeRatingBaseline, calculée sur la population complète de la même
// période). Renvoie `rating: null` si `games` ou la baseline sont vides plutôt qu'un chiffre
// trompeur.
export function computeRating(games, uid, baseline) {
  let n = 0, kills = 0, deaths = 0, assists = 0, dmg = 0, score = 0;
  games.forEach(g => {
    const p = findPlayerInGame(g, uid);
    if (!p) return;
    n++;
    kills += p.data.kills || 0;
    deaths += p.data.deaths || 0;
    assists += p.data.assists || 0;
    dmg += p.data.inflictedDamage || 0;
    score += p.data.score || 0;
  });
  if (!n || !baseline || !baseline.n) return { rating: null, n };

  const components = {
    kills: ratingRatio(kills / n, baseline.avgKills),
    deaths: ratingRatio(deaths / n, baseline.avgDeaths, true),
    dmg: ratingRatio(dmg / n, baseline.avgDmg),
    assists: ratingRatio(assists / n, baseline.avgAssists),
    score: ratingRatio(score / n, baseline.avgScore),
  };
  const rating = Object.entries(RATING_WEIGHTS).reduce((sum, [key, w]) => sum + w * components[key], 0);
  return { rating: Math.round(rating * 100) / 100, n, components };
}

// Stats d'efficacité : normalisées par mort plutôt que par partie, pour comparer des
// joueurs qui ne jouent pas le même nombre de parties. Pas de version "par minute"
// (kills/dégâts par minute) : ça dépendrait de g.data.duration, qu'aucune source EVA connue
// ne fournit depuis le changement d'API de juillet 2026 (ni la liste enrichie du collecteur
// HistoryBa, ni le détail getAfterhGameHistoryById ne le redemandent — voir CLAUDE.md), donc
// systématiquement n/d en pratique — retiré plutôt que de garder une stat qui n'affiche
// jamais rien d'exploitable.
export function computeEfficiencyStats(games, uid) {
  let n = 0, kills = 0, deaths = 0, assists = 0, dmg = 0, accSum = 0;
  games.forEach(g => {
    const p = findPlayerInGame(g, uid);
    if (!p) return;
    n++;
    kills += p.data.kills || 0;
    deaths += p.data.deaths || 0;
    assists += p.data.assists || 0;
    dmg += p.data.inflictedDamage || 0;
    accSum += p.data.firedAccuracy || 0;
  });
  return {
    n,
    kda: deaths ? ((kills + assists) / deaths).toFixed(2) : (kills + assists).toFixed(2),
    dmgPerDeath: deaths ? Math.round(dmg / deaths) : dmg,
    avgAccuracy: n ? Math.round((accSum / n) * 100) : 0,
    avgAssists: n ? (assists / n).toFixed(1) : '0.0',
  };
}

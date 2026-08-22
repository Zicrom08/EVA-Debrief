import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/state.js';
import {
  BASE_LP, LP_FLOOR, K_OUTCOME,
  lpToTier, computeLpHistory, gamesForLpScope,
} from '../src/rank.js';

function resetState() {
  state.gamesById = {};
  state.dateRangeStart = null;
  state.dateRangeEnd = null;
  state.selectedSeasonId = null;
  state.excludedMaps = new Set();
  state.excludedModes = new Set();
  state.playerLinks = {};
}

// Stats identiques des deux côtés -> computeMatchRatings donne un rating de 1.00 pile pour
// tout le monde -> perfBonus nul, isole proprement outcomeDelta pour les tests qui n'ont pas
// besoin de perf.
function neutralGame(id, createdAt, winnerId, loserId) {
  return {
    id, createdAt, data: {},
    players: [
      { userId: winnerId, data: { team: 'A', outcome: 'Victory', kills: 10, deaths: 5, assists: 2, inflictedDamage: 1000, score: 500 } },
      { userId: loserId, data: { team: 'B', outcome: 'Defeat', kills: 10, deaths: 5, assists: 2, inflictedDamage: 1000, score: 500 } },
    ],
  };
}

test('computeLpHistory: equal-LP game gives exact +-K_OUTCOME/2 deltas with neutral performance', () => {
  resetState();
  const g = neutralGame('g1', '2026-01-01', 'winner', 'loser');
  const { lpByUid, historyByUid } = computeLpHistory([g]);
  assert.equal(lpByUid.get('winner'), BASE_LP + K_OUTCOME / 2);
  assert.equal(lpByUid.get('loser'), BASE_LP - K_OUTCOME / 2);
  assert.equal(historyByUid.get('winner')[0].outcomeDelta, K_OUTCOME / 2);
  assert.equal(historyByUid.get('winner')[0].perfBonus, 0);
});

test('computeLpHistory: an upset win gains more than an even win, a favored loss costs more than an even loss', () => {
  resetState();
  // Bootstrap a small LP gap: 'fav' beats a fresh opponent once (neutral perf).
  const bootstrapA = neutralGame('boot-a', '2026-01-01', 'fav', 'dogA');
  const upsetGame = neutralGame('g2', '2026-01-02', 'dogA', 'fav'); // dogA (now the underdog) wins
  const { historyByUid: h1 } = computeLpHistory([bootstrapA, upsetGame]);
  const upsetWinDelta = h1.get('dogA')[1].outcomeDelta;
  assert.ok(upsetWinDelta > K_OUTCOME / 2, `upset win outcomeDelta (${upsetWinDelta}) should exceed the even-game baseline (${K_OUTCOME / 2})`);

  resetState();
  const bootstrapB = neutralGame('boot-b', '2026-01-01', 'fav2', 'dogB');
  const favoriteWinsAgain = neutralGame('g2b', '2026-01-02', 'fav2', 'dogB'); // fav2 (now favored) wins again
  const { historyByUid: h2 } = computeLpHistory([bootstrapB, favoriteWinsAgain]);
  const favoriteWinDelta = h2.get('fav2')[1].outcomeDelta;
  assert.ok(favoriteWinDelta < K_OUTCOME / 2, `favored win outcomeDelta (${favoriteWinDelta}) should be below the even-game baseline (${K_OUTCOME / 2})`);
});

test('computeLpHistory: performance bonus rewards/penalizes independently of the team result', () => {
  resetState();
  const g = {
    id: 'g1', createdAt: '2026-01-01', data: {},
    players: [
      { userId: 'weak', data: { team: 'A', outcome: 'Defeat', kills: 2, deaths: 15, assists: 0, inflictedDamage: 200, score: 100 } },
      { userId: 'strong', data: { team: 'A', outcome: 'Defeat', kills: 25, deaths: 3, assists: 5, inflictedDamage: 3000, score: 2500 } },
      { userId: 'opp1', data: { team: 'B', outcome: 'Victory', kills: 10, deaths: 5, assists: 2, inflictedDamage: 1000, score: 500 } },
      { userId: 'opp2', data: { team: 'B', outcome: 'Victory', kills: 10, deaths: 5, assists: 2, inflictedDamage: 1000, score: 500 } },
    ],
  };
  const { historyByUid } = computeLpHistory([g]);
  const weakEntry = historyByUid.get('weak')[0];
  const strongEntry = historyByUid.get('strong')[0];
  assert.equal(weakEntry.outcomeDelta, strongEntry.outcomeDelta); // même équipe, même résultat -> même part "issue"
  assert.ok(strongEntry.perf > weakEntry.perf);
  assert.ok(strongEntry.delta > weakEntry.delta, 'the better performer on the same losing team should lose strictly less LP');
});

test('computeLpHistory: a non-Victory/non-Defeat outcome is treated as a draw (actual = 0.5), not a loss for both sides', () => {
  resetState();
  const g = {
    id: 'g1', createdAt: '2026-01-01', data: {},
    players: [
      { userId: 'x', data: { team: 'A', outcome: 'Draw', kills: 10, deaths: 5, assists: 2, inflictedDamage: 1000, score: 500 } },
      { userId: 'y', data: { team: 'B', outcome: 'Draw', kills: 10, deaths: 5, assists: 2, inflictedDamage: 1000, score: 500 } },
    ],
  };
  const { historyByUid } = computeLpHistory([g]);
  assert.equal(historyByUid.get('x')[0].actual, 0.5);
  assert.equal(historyByUid.get('y')[0].actual, 0.5);
  // Équipes à LP égal + résultat nul -> expected == actual == 0.5 -> aucun mouvement d'issue.
  assert.equal(historyByUid.get('x')[0].outcomeDelta, 0);
  assert.equal(historyByUid.get('y')[0].outcomeDelta, 0);
});

test('computeLpHistory: LP never drops below LP_FLOOR even on a long losing streak', () => {
  resetState();
  // Outcome-only decay asymptotically slows down as the losing side becomes an ever-bigger
  // underdog (expected -> 0 shrinks outcomeDelta toward 0 too, correct Elo behavior) - use a
  // large kPerformance override so each loss still guarantees a big negative delta regardless
  // of how lopsided `expected` has already become, reaching the floor in a handful of games.
  const games = [];
  for (let i = 0; i < 10; i++) {
    games.push({
      id: `g${i}`, createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, data: {},
      players: [
        { userId: 'floorTest', data: { team: 'A', outcome: 'Defeat', kills: 0, deaths: 20, assists: 0, inflictedDamage: 100, score: 50 } },
        { userId: `opp${i}`, data: { team: 'B', outcome: 'Victory', kills: 20, deaths: 0, assists: 5, inflictedDamage: 3000, score: 3000 } },
      ],
    });
  }
  const { lpByUid } = computeLpHistory(games, { kPerformance: 2000 });
  assert.equal(lpByUid.get('floorTest'), LP_FLOOR);
});

test('computeLpHistory: games without full match data are entirely ignored', () => {
  resetState();
  const g = {
    id: 'g1', createdAt: '2026-01-01',
    players: [{ userId: 'x', data: { outcome: 'Victory', kills: 5, deaths: 2, assists: 1 } }], // pas de g.data, pas de team
  };
  const { lpByUid, gamesUsed } = computeLpHistory([g]);
  assert.equal(gamesUsed, 0);
  assert.equal(lpByUid.size, 0);
});

test('computeLpHistory: a game that cannot be split into two non-empty teams is skipped without NaN/throwing', () => {
  resetState();
  const g = {
    id: 'g1', createdAt: '2026-01-01', data: {},
    players: [{ userId: 'x', data: { team: 'ALLIANCE', outcome: 'Victory', kills: 5, deaths: 2, assists: 1, inflictedDamage: 100, score: 100 } }],
  };
  const { lpByUid, gamesUsed } = computeLpHistory([g]);
  assert.equal(gamesUsed, 0);
  assert.equal(lpByUid.has('x'), false);
});

test('computeLpHistory: replay is chronological regardless of input array order', () => {
  resetState();
  const early = neutralGame('early', '2026-01-01', 'A', 'B');
  const late = neutralGame('late', '2026-02-01', 'B', 'C');
  const forward = computeLpHistory([early, late]);
  const reversed = computeLpHistory([late, early]); // même parties, ordre d'entrée inversé
  assert.equal(forward.lpByUid.get('A'), reversed.lpByUid.get('A'));
  assert.equal(forward.lpByUid.get('B'), reversed.lpByUid.get('B'));
  assert.equal(forward.lpByUid.get('C'), reversed.lpByUid.get('C'));
});

test('computeLpHistory: a player appearing for the first time mid-replay starts from BASE_LP, not NaN/undefined', () => {
  resetState();
  const g1 = neutralGame('g1', '2026-01-01', 'A', 'B');
  const g2 = neutralGame('g2', '2026-01-02', 'C', 'A'); // C apparaît seulement ici
  const { historyByUid } = computeLpHistory([g1, g2]);
  assert.equal(historyByUid.get('C')[0].lpBefore, BASE_LP);
});

test('computeLpHistory: merges aliased accounts onto one LP entry via canonicalUid', () => {
  resetState();
  state.playerLinks = { aliasX: 'primaryX' };
  const g1 = neutralGame('g1', '2026-01-01', 'aliasX', 'opp1');
  const g2 = neutralGame('g2', '2026-01-02', 'primaryX', 'opp2');
  const { lpByUid, historyByUid } = computeLpHistory([g1, g2]);
  assert.equal(lpByUid.has('aliasX'), false);
  assert.equal(historyByUid.get('primaryX').length, 2);
  state.playerLinks = {};
});

test('lpToTier: exact division/tier boundaries and defensive clamping at the extremes', () => {
  // Numérotation croissante avec le LP : I = entrée du rang, III = juste avant promotion.
  assert.equal(lpToTier(999).name, 'Or III');
  assert.equal(lpToTier(1000).name, 'Platine I');
  assert.equal(lpToTier(1000).progressPct, 0);
  assert.equal(lpToTier(1099).progressPct, 99);
  assert.equal(lpToTier(-500).name, 'Bronze I');
  assert.equal(lpToTier(-500).progressPct, 0);
  assert.equal(lpToTier(999999).name, 'Légende III');
  assert.equal(lpToTier(999999).progressPct, 100);
});

test('lpToTier: regression - a fractional LP between two integer band boundaries must not fall through to the top tier', () => {
  // Real bug report: a player with only 4 games (LP barely moved from BASE_LP=1000, the
  // start of Platine I) landed at a fractional LP just under 1000 and was shown as the
  // top tier - the old inclusive-integer-bounds table ([900,999] then [1000,1099]) left a
  // real-valued gap between 999 and 1000 that no band matched, so .find() fell through to the
  // last (highest) tier. Any fractional value strictly inside that kind of gap must resolve
  // to the band it visually belongs to, at every internal boundary, not just this one.
  assert.equal(lpToTier(999.5).name, 'Or III');
  assert.equal(lpToTier(999.99).name, 'Or III');
  assert.equal(lpToTier(1099.5).name, 'Platine I');
  assert.equal(lpToTier(1999.5).name, 'Prodige I');
  assert.equal(lpToTier(NaN).name, 'Bronze I'); // repli défensif sûr (le plus bas), jamais le plus haut
});

test('gamesForLpScope: with a season selected, behaves like gameInSelectedRange (exact seasonId, date fallback)', () => {
  resetState();
  state.selectedSeasonId = 8;
  state.gamesById = {
    g1: { id: 'g1', seasonId: 8, createdAt: '2020-01-01' }, // seasonId exact -> inclus malgré la date
    g2: { id: 'g2', seasonId: 7, createdAt: '2026-06-01' }, // seasonId différent -> exclu
  };
  const result = gamesForLpScope().map(g => g.id);
  assert.deepEqual(result, ['g1']);
});

test('gamesForLpScope: with no season selected, a custom date range is ignored (full career)', () => {
  resetState();
  state.dateRangeStart = new Date('2026-06-01').getTime();
  state.dateRangeEnd = new Date('2026-06-30').getTime();
  state.gamesById = {
    g1: { id: 'g1', createdAt: '2020-01-01' }, // bien en dehors de la période custom
  };
  const result = gamesForLpScope().map(g => g.id);
  assert.deepEqual(result, ['g1']); // toujours inclus : la période libre est ignorée hors sélection de saison
});

test('gamesForLpScope: map/mode exclusions are respected with or without a season selected', () => {
  resetState();
  state.excludedMaps.add('Ceres');
  state.gamesById = {
    g1: { id: 'g1', createdAt: '2026-01-01', map: { name: 'Ceres' } },
    g2: { id: 'g2', createdAt: '2026-01-01', map: { name: 'Titan' } },
  };
  assert.deepEqual(gamesForLpScope().map(g => g.id), ['g2']);

  state.selectedSeasonId = 8;
  state.gamesById = {
    g1: { id: 'g1', seasonId: 8, createdAt: '2026-01-01', map: { name: 'Ceres' } },
    g2: { id: 'g2', seasonId: 8, createdAt: '2026-01-01', map: { name: 'Titan' } },
  };
  assert.deepEqual(gamesForLpScope().map(g => g.id), ['g2']);
});

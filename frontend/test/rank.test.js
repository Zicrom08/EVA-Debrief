import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/state.js';
import {
  BASE_MMR, MMR_FLOOR, K_OUTCOME,
  mmrToTier, computeMmrHistory, gamesForMmrScope,
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

test('computeMmrHistory: equal-MMR game gives exact +-K_OUTCOME/2 deltas with neutral performance', () => {
  resetState();
  const g = neutralGame('g1', '2026-01-01', 'winner', 'loser');
  const { mmrByUid, historyByUid } = computeMmrHistory([g]);
  assert.equal(mmrByUid.get('winner'), BASE_MMR + K_OUTCOME / 2);
  assert.equal(mmrByUid.get('loser'), BASE_MMR - K_OUTCOME / 2);
  assert.equal(historyByUid.get('winner')[0].outcomeDelta, K_OUTCOME / 2);
  assert.equal(historyByUid.get('winner')[0].perfBonus, 0);
});

test('computeMmrHistory: an upset win gains more than an even win, a favored loss costs more than an even loss', () => {
  resetState();
  // Bootstrap a small MMR gap: 'fav' beats a fresh opponent once (neutral perf).
  const bootstrapA = neutralGame('boot-a', '2026-01-01', 'fav', 'dogA');
  const upsetGame = neutralGame('g2', '2026-01-02', 'dogA', 'fav'); // dogA (now the underdog) wins
  const { historyByUid: h1 } = computeMmrHistory([bootstrapA, upsetGame]);
  const upsetWinDelta = h1.get('dogA')[1].outcomeDelta;
  assert.ok(upsetWinDelta > K_OUTCOME / 2, `upset win outcomeDelta (${upsetWinDelta}) should exceed the even-game baseline (${K_OUTCOME / 2})`);

  resetState();
  const bootstrapB = neutralGame('boot-b', '2026-01-01', 'fav2', 'dogB');
  const favoriteWinsAgain = neutralGame('g2b', '2026-01-02', 'fav2', 'dogB'); // fav2 (now favored) wins again
  const { historyByUid: h2 } = computeMmrHistory([bootstrapB, favoriteWinsAgain]);
  const favoriteWinDelta = h2.get('fav2')[1].outcomeDelta;
  assert.ok(favoriteWinDelta < K_OUTCOME / 2, `favored win outcomeDelta (${favoriteWinDelta}) should be below the even-game baseline (${K_OUTCOME / 2})`);
});

test('computeMmrHistory: performance bonus rewards/penalizes independently of the team result', () => {
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
  const { historyByUid } = computeMmrHistory([g]);
  const weakEntry = historyByUid.get('weak')[0];
  const strongEntry = historyByUid.get('strong')[0];
  assert.equal(weakEntry.outcomeDelta, strongEntry.outcomeDelta); // même équipe, même résultat -> même part "issue"
  assert.ok(strongEntry.perf > weakEntry.perf);
  assert.ok(strongEntry.delta > weakEntry.delta, 'the better performer on the same losing team should lose strictly less MMR');
});

test('computeMmrHistory: a non-Victory/non-Defeat outcome is treated as a draw (actual = 0.5), not a loss for both sides', () => {
  resetState();
  const g = {
    id: 'g1', createdAt: '2026-01-01', data: {},
    players: [
      { userId: 'x', data: { team: 'A', outcome: 'Draw', kills: 10, deaths: 5, assists: 2, inflictedDamage: 1000, score: 500 } },
      { userId: 'y', data: { team: 'B', outcome: 'Draw', kills: 10, deaths: 5, assists: 2, inflictedDamage: 1000, score: 500 } },
    ],
  };
  const { historyByUid } = computeMmrHistory([g]);
  assert.equal(historyByUid.get('x')[0].actual, 0.5);
  assert.equal(historyByUid.get('y')[0].actual, 0.5);
  // Équipes à MMR égal + résultat nul -> expected == actual == 0.5 -> aucun mouvement d'issue.
  assert.equal(historyByUid.get('x')[0].outcomeDelta, 0);
  assert.equal(historyByUid.get('y')[0].outcomeDelta, 0);
});

test('computeMmrHistory: MMR never drops below MMR_FLOOR even on a long losing streak', () => {
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
  const { mmrByUid } = computeMmrHistory(games, { kPerformance: 2000 });
  assert.equal(mmrByUid.get('floorTest'), MMR_FLOOR);
});

test('computeMmrHistory: games without full match data are entirely ignored', () => {
  resetState();
  const g = {
    id: 'g1', createdAt: '2026-01-01',
    players: [{ userId: 'x', data: { outcome: 'Victory', kills: 5, deaths: 2, assists: 1 } }], // pas de g.data, pas de team
  };
  const { mmrByUid, gamesUsed } = computeMmrHistory([g]);
  assert.equal(gamesUsed, 0);
  assert.equal(mmrByUid.size, 0);
});

test('computeMmrHistory: a game that cannot be split into two non-empty teams is skipped without NaN/throwing', () => {
  resetState();
  const g = {
    id: 'g1', createdAt: '2026-01-01', data: {},
    players: [{ userId: 'x', data: { team: 'ALLIANCE', outcome: 'Victory', kills: 5, deaths: 2, assists: 1, inflictedDamage: 100, score: 100 } }],
  };
  const { mmrByUid, gamesUsed } = computeMmrHistory([g]);
  assert.equal(gamesUsed, 0);
  assert.equal(mmrByUid.has('x'), false);
});

test('computeMmrHistory: replay is chronological regardless of input array order', () => {
  resetState();
  const early = neutralGame('early', '2026-01-01', 'A', 'B');
  const late = neutralGame('late', '2026-02-01', 'B', 'C');
  const forward = computeMmrHistory([early, late]);
  const reversed = computeMmrHistory([late, early]); // même parties, ordre d'entrée inversé
  assert.equal(forward.mmrByUid.get('A'), reversed.mmrByUid.get('A'));
  assert.equal(forward.mmrByUid.get('B'), reversed.mmrByUid.get('B'));
  assert.equal(forward.mmrByUid.get('C'), reversed.mmrByUid.get('C'));
});

test('computeMmrHistory: a player appearing for the first time mid-replay starts from BASE_MMR, not NaN/undefined', () => {
  resetState();
  const g1 = neutralGame('g1', '2026-01-01', 'A', 'B');
  const g2 = neutralGame('g2', '2026-01-02', 'C', 'A'); // C apparaît seulement ici
  const { historyByUid } = computeMmrHistory([g1, g2]);
  assert.equal(historyByUid.get('C')[0].mmrBefore, BASE_MMR);
});

test('computeMmrHistory: merges aliased accounts onto one MMR entry via canonicalUid', () => {
  resetState();
  state.playerLinks = { aliasX: 'primaryX' };
  const g1 = neutralGame('g1', '2026-01-01', 'aliasX', 'opp1');
  const g2 = neutralGame('g2', '2026-01-02', 'primaryX', 'opp2');
  const { mmrByUid, historyByUid } = computeMmrHistory([g1, g2]);
  assert.equal(mmrByUid.has('aliasX'), false);
  assert.equal(historyByUid.get('primaryX').length, 2);
  state.playerLinks = {};
});

test('mmrToTier: exact division/tier boundaries and defensive clamping at the extremes', () => {
  assert.equal(mmrToTier(999).name, 'Or I');
  assert.equal(mmrToTier(1000).name, 'Platine III');
  assert.equal(mmrToTier(1000).progressPct, 0);
  assert.equal(mmrToTier(1099).progressPct, 99);
  assert.equal(mmrToTier(-500).name, 'Bronze III');
  assert.equal(mmrToTier(-500).progressPct, 0);
  assert.equal(mmrToTier(999999).name, 'Légende I');
  assert.equal(mmrToTier(999999).progressPct, 100);
});

test('mmrToTier: regression - a fractional MMR between two integer band boundaries must not fall through to the top tier', () => {
  // Real bug report: a player with only 4 games (MMR barely moved from BASE_MMR=1000, the
  // start of Platine III) landed at a fractional MMR just under 1000 and was shown as
  // "Légende I" - the old inclusive-integer-bounds table ([900,999] then [1000,1099]) left a
  // real-valued gap between 999 and 1000 that no band matched, so .find() fell through to the
  // last (highest) tier. Any fractional value strictly inside that kind of gap must resolve
  // to the band it visually belongs to, at every internal boundary, not just this one.
  assert.equal(mmrToTier(999.5).name, 'Or I');
  assert.equal(mmrToTier(999.99).name, 'Or I');
  assert.equal(mmrToTier(1099.5).name, 'Platine III');
  assert.equal(mmrToTier(1999.5).name, 'Prodige III');
  assert.equal(mmrToTier(NaN).name, 'Bronze III'); // repli défensif sûr (le plus bas), jamais le plus haut
});

test('gamesForMmrScope: with a season selected, behaves like gameInSelectedRange (exact seasonId, date fallback)', () => {
  resetState();
  state.selectedSeasonId = 8;
  state.gamesById = {
    g1: { id: 'g1', seasonId: 8, createdAt: '2020-01-01' }, // seasonId exact -> inclus malgré la date
    g2: { id: 'g2', seasonId: 7, createdAt: '2026-06-01' }, // seasonId différent -> exclu
  };
  const result = gamesForMmrScope().map(g => g.id);
  assert.deepEqual(result, ['g1']);
});

test('gamesForMmrScope: with no season selected, a custom date range is ignored (full career)', () => {
  resetState();
  state.dateRangeStart = new Date('2026-06-01').getTime();
  state.dateRangeEnd = new Date('2026-06-30').getTime();
  state.gamesById = {
    g1: { id: 'g1', createdAt: '2020-01-01' }, // bien en dehors de la période custom
  };
  const result = gamesForMmrScope().map(g => g.id);
  assert.deepEqual(result, ['g1']); // toujours inclus : la période libre est ignorée hors sélection de saison
});

test('gamesForMmrScope: map/mode exclusions are respected with or without a season selected', () => {
  resetState();
  state.excludedMaps.add('Ceres');
  state.gamesById = {
    g1: { id: 'g1', createdAt: '2026-01-01', map: { name: 'Ceres' } },
    g2: { id: 'g2', createdAt: '2026-01-01', map: { name: 'Titan' } },
  };
  assert.deepEqual(gamesForMmrScope().map(g => g.id), ['g2']);

  state.selectedSeasonId = 8;
  state.gamesById = {
    g1: { id: 'g1', seasonId: 8, createdAt: '2026-01-01', map: { name: 'Ceres' } },
    g2: { id: 'g2', seasonId: 8, createdAt: '2026-01-01', map: { name: 'Titan' } },
  };
  assert.deepEqual(gamesForMmrScope().map(g => g.id), ['g2']);
});

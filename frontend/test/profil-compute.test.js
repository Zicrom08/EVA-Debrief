import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDuoNemesisStats, computeStreaks, computeKDDistribution, computeContributionTrend, computeMatchRatings, computeMatchMvpStats, bestWorstGames } from '../src/profil/compute.js';

test('computeMatchMvpStats counts a game as MVP only when the player has the single best score across BOTH teams', () => {
  const games = [
    // "me" a le meilleur score de son équipe, mais PAS de la partie entière (l'adversaire fait mieux) -> pas MVP.
    { data: {}, players: [
      { userId: 'me', data: { team: 'ALLIANCE', score: 2000 } },
      { userId: 'teammate', data: { team: 'ALLIANCE', score: 500 } },
      { userId: 'enemy', data: { team: 'REBELS', score: 3000 } },
    ] },
    // "me" a bien le meilleur score tous camps confondus -> MVP.
    { data: {}, players: [
      { userId: 'me', data: { team: 'ALLIANCE', score: 5000 } },
      { userId: 'teammate', data: { team: 'ALLIANCE', score: 100 } },
      { userId: 'enemy', data: { team: 'REBELS', score: 200 } },
    ] },
  ];
  const stats = computeMatchMvpStats(games, 'me');
  assert.equal(stats.total, 2);
  assert.equal(stats.mvpRate, 50);
  assert.deepEqual(stats.dist, [
    { label: 'MVP de la partie', n: 1 },
    { label: 'Pas MVP', n: 1 },
  ]);
});

test('computeMatchMvpStats falls back to the isMvp flag on reduced-format games (no full match data)', () => {
  const games = [
    { players: [
      { userId: 'me', isMvp: true, data: { kills: 1 } },
      { userId: 'other', isMvp: false, data: { kills: 99 } },
    ] },
  ];
  const stats = computeMatchMvpStats(games, 'me');
  assert.equal(stats.total, 1);
  assert.equal(stats.mvpRate, 100);
});

test('computeMatchMvpStats skips games the player did not play, without counting them', () => {
  const games = [
    { data: {}, players: [{ userId: 'someone-else', data: { team: 'ALLIANCE', score: 100 } }] },
  ];
  const stats = computeMatchMvpStats(games, 'me');
  assert.equal(stats.total, 0);
  assert.equal(stats.mvpRate, 0);
});

test('bestWorstGames tracks the single game with the highest firedAccuracy', () => {
  const games = [
    { id: 'g1', map: { name: 'A' }, createdAt: '2026-01-01T00:00:00Z', players: [{ userId: 'me', data: { kills: 1, deaths: 1, firedAccuracy: 0.2 } }] },
    { id: 'g2', map: { name: 'B' }, createdAt: '2026-01-02T00:00:00Z', players: [{ userId: 'me', data: { kills: 1, deaths: 1, firedAccuracy: 0.55 } }] },
    { id: 'g3', map: { name: 'C' }, createdAt: '2026-01-03T00:00:00Z', players: [{ userId: 'me', data: { kills: 1, deaths: 1, firedAccuracy: 0.4 } }] },
  ];
  const { bestAcc } = bestWorstGames(games, 'me');
  assert.equal(bestAcc.val, 0.55);
  assert.equal(bestAcc.game.id, 'g2');
});

test('bestWorstGames never picks a game with no exploitable accuracy (null/missing), rather than defaulting it to 0%', () => {
  const games = [
    { id: 'g1', map: { name: 'A' }, createdAt: '2026-01-01T00:00:00Z', players: [{ userId: 'me', data: { kills: 1, deaths: 1, firedAccuracy: null } }] },
    { id: 'g2', map: { name: 'B' }, createdAt: '2026-01-02T00:00:00Z', players: [{ userId: 'me', data: { kills: 1, deaths: 1 } }] }, // firedAccuracy absent
  ];
  const { bestAcc } = bestWorstGames(games, 'me');
  assert.equal(bestAcc, null);
});

test('computeDuoNemesisStats ignores games without a team assignment instead of treating everyone as a teammate', () => {
  // Regression test for the bug documented in CLAUDE.md: p.data.team === x.data.team
  // used to be true when BOTH were undefined (list-only games, no team field),
  // wrongly lumping every other player in as a "duo" teammate.
  const games = [
    { players: [
      { userId: 'me', data: { outcome: 'Victory', team: undefined } },
      { userId: 'other', data: { outcome: 'Victory', team: undefined } },
    ] },
  ];
  const { duoArr, nemesisArr } = computeDuoNemesisStats(games, 'me', 1);
  assert.equal(duoArr.length, 0);
  assert.equal(nemesisArr.length, 0);
});

test('computeDuoNemesisStats correctly buckets teammates vs opponents once team is known', () => {
  const games = [
    { players: [
      { userId: 'me', data: { outcome: 'Victory', team: 'Alliance' } },
      { userId: 'ally', data: { outcome: 'Victory', team: 'Alliance' } },
      { userId: 'foe', data: { outcome: 'Defeat', team: 'Rebels' } },
    ] },
  ];
  const { duoArr, nemesisArr } = computeDuoNemesisStats(games, 'me', 1);
  assert.equal(duoArr.length, 1);
  assert.equal(duoArr[0].uid, 'ally');
  assert.equal(nemesisArr.length, 1);
  assert.equal(nemesisArr[0].uid, 'foe');
});

test('computeStreaks tracks the best win streak, worst loss streak, and the current streak', () => {
  const outcomes = ['Victory', 'Victory', 'Defeat', 'Victory', 'Victory', 'Victory'];
  const games = outcomes.map(o => ({ players: [{ userId: 'me', data: { outcome: o } }] }));
  const { bestWin, worstLoss, currentType, currentCount } = computeStreaks(games, 'me');
  assert.equal(bestWin, 3);
  assert.equal(worstLoss, 1);
  assert.equal(currentType, 'Victory');
  assert.equal(currentCount, 3);
});

test('computeKDDistribution buckets K/D ratios into the right bin', () => {
  const games = [
    { players: [{ userId: 'me', data: { kills: 0, deaths: 4 } }] },  // 0.0   -> bin "0 - 0.5"
    { players: [{ userId: 'me', data: { kills: 6, deaths: 4 } }] },  // 1.5   -> bin "1.5 - 2"
    { players: [{ userId: 'me', data: { kills: 10, deaths: 2 } }] }, // 5.0   -> bin "2 +"
  ];
  const dist = computeKDDistribution(games, 'me');
  assert.equal(dist[0].n, 1);
  assert.equal(dist[3].n, 1);
  assert.equal(dist[4].n, 1);
});

test('computeContributionTrend excludes games without a team assignment (same guard as computeDuoNemesisStats)', () => {
  const games = [
    { players: [{ userId: 'me', data: { team: undefined, score: 100 } }] },
    { players: [
      { userId: 'me', data: { team: 'Alliance', score: 50 } },
      { userId: 'ally', data: { team: 'Alliance', score: 50 } },
    ] },
  ];
  const trend = computeContributionTrend(games, 'me');
  assert.deepEqual(trend, [50]); // only the second game counted, 50% of the team's 100 total
});

test('computeMatchRatings rates a player above 1.00 for above-average performance within that single match\'s lobby', () => {
  const g = {
    data: {},
    players: [
      { userId: 'star', data: { team: 'ALLIANCE', kills: 20, deaths: 5, assists: 2, inflictedDamage: 4000, score: 3000 } },
      { userId: 'average', data: { team: 'ALLIANCE', kills: 8, deaths: 8, assists: 2, inflictedDamage: 1500, score: 1200 } },
      { userId: 'weak', data: { team: 'REBELS', kills: 2, deaths: 12, assists: 1, inflictedDamage: 500, score: 400 } },
    ],
  };
  const ratings = computeMatchRatings(g);
  assert.ok(ratings.get('star') > 1);
  assert.ok(ratings.get('weak') < 1);
});

test('computeMatchRatings returns an empty Map for a game without full match data (reduced/list-only format)', () => {
  const g = { players: [{ userId: 'me', data: { outcome: 'Victory', kills: 5, deaths: 2, assists: 1 } }] };
  const ratings = computeMatchRatings(g);
  assert.equal(ratings.size, 0);
});

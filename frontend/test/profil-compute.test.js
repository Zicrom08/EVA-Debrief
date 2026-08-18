import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDuoNemesisStats, computeStreaks, computeKDDistribution, computeContributionTrend, computeMatchRatings } from '../src/profil/compute.js';

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

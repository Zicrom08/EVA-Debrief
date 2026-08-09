import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDuoNemesisStats, computeStreaks, computeKDDistribution, computeContributionTrend } from '../src/profil/compute.js';

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

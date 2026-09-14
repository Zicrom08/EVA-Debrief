import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateGames } from '../src/tendances.js';

test('aggregateGames averages firedAccuracy across games that report it', () => {
  const games = [
    { players: [{ userId: 'me', data: { outcome: 'Victory', kills: 1, deaths: 1, firedAccuracy: 0.2 } }] },
    { players: [{ userId: 'me', data: { outcome: 'Defeat', kills: 1, deaths: 1, firedAccuracy: 0.6 } }] },
  ];
  const agg = aggregateGames(games, 'me');
  assert.equal(agg.avgAcc, 40); // (0.2 + 0.6) / 2 * 100
});

test('aggregateGames returns null (not 0) for avgAcc when no game in the set has exploitable accuracy', () => {
  const games = [
    { players: [{ userId: 'me', data: { outcome: 'Victory', kills: 1, deaths: 1 } }] }, // firedAccuracy absent
  ];
  const agg = aggregateGames(games, 'me');
  assert.equal(agg.avgAcc, null);
});

test('aggregateGames excludes games without accuracy from the average rather than treating them as 0%', () => {
  const games = [
    { players: [{ userId: 'me', data: { outcome: 'Victory', kills: 1, deaths: 1, firedAccuracy: 0.5 } }] },
    { players: [{ userId: 'me', data: { outcome: 'Victory', kills: 1, deaths: 1 } }] }, // pas de firedAccuracy
  ];
  const agg = aggregateGames(games, 'me');
  assert.equal(agg.avgAcc, 50); // pas (0.5 + 0) / 2 = 25
});

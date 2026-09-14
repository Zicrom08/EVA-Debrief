import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGroupGames } from '../src/game-groups.js';

test('resolveGroupGames resolves each gameId to the real game object, in order', () => {
  const gamesById = { g1: { id: 'g1' }, g2: { id: 'g2' }, g3: { id: 'g3' } };
  const group = { gameIds: ['g2', 'g1', 'g3'] };
  const games = resolveGroupGames(group, gamesById);
  assert.deepEqual(games.map(g => g.id), ['g2', 'g1', 'g3']);
});

test('resolveGroupGames silently filters out ids of games that no longer exist (deleted after the group was created)', () => {
  const gamesById = { g1: { id: 'g1' } };
  const group = { gameIds: ['g1', 'deleted-game', 'also-gone'] };
  const games = resolveGroupGames(group, gamesById);
  assert.deepEqual(games.map(g => g.id), ['g1']);
});

test('resolveGroupGames returns an empty array for an empty or missing gameIds', () => {
  const gamesById = { g1: { id: 'g1' } };
  assert.deepEqual(resolveGroupGames({ gameIds: [] }, gamesById), []);
  assert.deepEqual(resolveGroupGames({}, gamesById), []);
});

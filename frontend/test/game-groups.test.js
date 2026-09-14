import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/state.js';
import { resolveGroupGames, computeGroupPlayerAggregates } from '../src/game-groups.js';

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

const GROUP_GAMES = [
  { id: 'g1', players: [
    { userId: 'p1', data: { outcome: 'Victory', kills: 10, deaths: 2, assists: 3, inflictedDamage: 1000, score: 2000, firedAccuracy: 0.5 } },
    { userId: 'p2', data: { outcome: 'Defeat', kills: 2, deaths: 8, assists: 1, inflictedDamage: 400, score: 800 } },
  ] },
  { id: 'g2', players: [
    { userId: 'p1', data: { outcome: 'Defeat', kills: 4, deaths: 6, assists: 2, inflictedDamage: 600, score: 1200, firedAccuracy: 0.3 } },
    { userId: 'p2', data: { outcome: 'Victory', kills: 9, deaths: 3, assists: 4, inflictedDamage: 900, score: 1800 } },
  ] },
];

test('computeGroupPlayerAggregates sums K/D/A across every game, averages score/dégâts per game played', () => {
  const [p1, p2] = computeGroupPlayerAggregates(GROUP_GAMES).sort((a, b) => a.uid.localeCompare(b.uid));
  assert.equal(p1.uid, 'p1');
  assert.equal(p1.n, 2);
  assert.equal(p1.wins, 1);
  assert.equal(p1.losses, 1);
  assert.equal(p1.winrate, 50);
  assert.equal(p1.kills, 14);
  assert.equal(p1.deaths, 8);
  assert.equal(p1.assists, 5);
  assert.equal(p1.kd, 14 / 8);
  assert.equal(p1.kda, (14 + 5) / 8);
  assert.equal(p1.avgScore, 1600);
  assert.equal(p1.avgDmg, 800);

  assert.equal(p2.uid, 'p2');
  assert.equal(p2.kills, 11);
  assert.equal(p2.deaths, 11);
  assert.equal(p2.kd, 1);
});

test('computeGroupPlayerAggregates averages accuracy only over games that actually reported it, null when never reported', () => {
  const players = computeGroupPlayerAggregates(GROUP_GAMES);
  const p1 = players.find(p => p.uid === 'p1');
  const p2 = players.find(p => p.uid === 'p2');
  assert.ok(Math.abs(p1.avgAcc - 0.4) < 1e-9); // (0.5 + 0.3) / 2, les deux parties de g1/g2 en ont une
  assert.equal(p2.avgAcc, null); // jamais reportée dans les fixtures ci-dessus
});

test('computeGroupPlayerAggregates leaves rating null when no game in the group has full match data', () => {
  // Les fixtures GROUP_GAMES n'ont ni g.data ni p.data.team -> hasFullMatchData() est faux
  // pour les deux -> computeMatchRatings() renvoie une Map vide pour chacune.
  const players = computeGroupPlayerAggregates(GROUP_GAMES);
  assert.ok(players.every(p => p.rating === null));
});

test('computeGroupPlayerAggregates averages Rating only over games that have full match data (hasFullMatchData)', () => {
  const games = [
    // Partie complète (g.data + team assignés) : le Rating est calculable pour les deux.
    { id: 'full', data: {}, players: [
      { userId: 'p1', data: { team: 'ALLIANCE', outcome: 'Victory', kills: 10, deaths: 2, assists: 3, inflictedDamage: 1000, score: 2000 } },
      { userId: 'p2', data: { team: 'REBELS', outcome: 'Defeat', kills: 2, deaths: 8, assists: 1, inflictedDamage: 400, score: 800 } },
    ] },
    // Partie réduite (pas de g.data/team) : hasFullMatchData() est faux, computeMatchRatings()
    // renvoie une Map vide pour cette partie -> ne doit pas compter dans la moyenne de p1.
    { id: 'reduced', players: [
      { userId: 'p1', data: { outcome: 'Defeat', kills: 1, deaths: 5, assists: 0 } },
    ] },
  ];
  const players = computeGroupPlayerAggregates(games);
  const p1 = players.find(p => p.uid === 'p1');
  const p2 = players.find(p => p.uid === 'p2');
  assert.equal(p1.n, 2); // a joué les 2 parties...
  assert.notEqual(p1.rating, null); // ...mais le Rating ne vient QUE de la partie complète
  assert.notEqual(p2.rating, null);
  assert.ok(p1.rating > p2.rating); // p1 a largement mieux performé que p2 sur la partie complète
});

test('computeGroupPlayerAggregates merges a player and their merged alias into a single row', () => {
  state.playerLinks = { alias1: 'primary1' };
  const games = [
    { id: 'g1', players: [{ userId: 'primary1', data: { outcome: 'Victory', kills: 5, deaths: 1, assists: 0 } }] },
    { id: 'g2', players: [{ userId: 'alias1', data: { outcome: 'Defeat', kills: 3, deaths: 2, assists: 1 } }] },
  ];
  const players = computeGroupPlayerAggregates(games);
  state.playerLinks = {};
  assert.equal(players.length, 1);
  assert.equal(players[0].n, 2);
  assert.equal(players[0].kills, 8);
});

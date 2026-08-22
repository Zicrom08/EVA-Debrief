import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/state.js';
import { detectTeamsFromNicknames } from '../src/team-detect.js';

function resetState() {
  state.gamesById = {};
  state.playerLinks = {};
}

function game(id, createdAt, players) {
  return { id, createdAt, players: players.map(([userId, niceName]) => ({ userId, data: { niceName } })) };
}

test('detects a team tag shared by at least 2 players', () => {
  resetState();
  state.gamesById = {
    g1: game('g1', '2026-01-01T00:00:00Z', [['u1', 'ALPHAxJoueur1'], ['u2', 'ALPHAxJoueur2']]),
  };
  const teams = detectTeamsFromNicknames();
  assert.equal(teams.length, 1);
  assert.equal(teams[0].tag, 'ALPHA');
  assert.deepEqual(teams[0].members.map(m => m.uid).sort(), ['u1', 'u2']);
  assert.deepEqual(teams[0].members.map(m => m.playerName).sort(), ['Joueur1', 'Joueur2']);
});

test('rejects a tag seen for only 1 player (false positive case: a pseudo like "Boxeur" parses as tag "Bo" + "xeur")', () => {
  resetState();
  state.gamesById = {
    g1: game('g1', '2026-01-01T00:00:00Z', [['u1', 'Boxeur'], ['u2', 'Faucon']]),
  };
  assert.deepEqual(detectTeamsFromNicknames(), []);
});

test('the regex itself rejects pseudos where "x" is the very last character', () => {
  resetState();
  state.gamesById = {
    g1: game('g1', '2026-01-01T00:00:00Z', [['u1', 'Joueurx'], ['u2', 'UnPseudoQuiFinitParx']]),
  };
  assert.deepEqual(detectTeamsFromNicknames(), []);
});

test('uses each player\'s MOST RECENT nickname only: a player who left the team is not counted', () => {
  resetState();
  state.gamesById = {
    g1: game('g1', '2026-01-01T00:00:00Z', [['u1', 'ALPHAxJoueur1'], ['u2', 'ALPHAxJoueur2']]),
    // u1 a quitté le tag ALPHA depuis, sa dernière partie ne le porte plus
    g2: game('g2', '2026-02-01T00:00:00Z', [['u1', 'Joueur1']]),
  };
  const teams = detectTeamsFromNicknames();
  assert.equal(teams.length, 0); // ALPHA ne compte plus que u2 -> sous le seuil de 2
});

test('groups tags case-insensitively but keeps the most recently seen casing for display', () => {
  resetState();
  state.gamesById = {
    g1: game('g1', '2026-01-01T00:00:00Z', [['u1', 'BetaxJoueur3']]),
    g2: game('g2', '2026-02-01T00:00:00Z', [['u2', 'BETAxJoueur4']]),
  };
  const teams = detectTeamsFromNicknames();
  assert.equal(teams.length, 1);
  assert.equal(teams[0].tag, 'BETA'); // casse de la partie la plus récente (g2)
  assert.equal(teams[0].members.length, 2);
});

test('resolves merged aliases to their canonical uid before grouping', () => {
  resetState();
  state.playerLinks = { aliasOfU1: 'u1' };
  state.gamesById = {
    g1: game('g1', '2026-01-01T00:00:00Z', [['aliasOfU1', 'ALPHAxOld'], ['u2', 'ALPHAxJoueur2']]),
  };
  const teams = detectTeamsFromNicknames();
  assert.equal(teams.length, 1);
  assert.deepEqual(teams[0].members.map(m => m.uid).sort(), ['u1', 'u2']); // pas 'aliasOfU1'
});

test('sorts detected teams by member count descending', () => {
  resetState();
  state.gamesById = {
    g1: game('g1', '2026-01-01T00:00:00Z', [
      ['u1', 'BIGxAA'], ['u2', 'BIGxBB'], ['u3', 'BIGxCC'],
      ['u4', 'SMLxAA'], ['u5', 'SMLxBB'],
    ]),
  };
  const teams = detectTeamsFromNicknames();
  assert.deepEqual(teams.map(t => t.tag), ['BIG', 'SML']);
});

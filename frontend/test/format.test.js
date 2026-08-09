import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/state.js';
import { hasFullMatchData, resolvePlayerName, findPlayerInGame, fmtDuration, fmtHM, fmtDelta } from '../src/format.js';

test('findPlayerInGame finds a player by userId with loose equality (string/number mix)', () => {
  const g = { players: [{ userId: '123', data: {} }] };
  assert.equal(findPlayerInGame(g, 123), g.players[0]);
  assert.equal(findPlayerInGame(g, '123'), g.players[0]);
  assert.equal(findPlayerInGame(g, '999'), undefined);
});

test('hasFullMatchData is true only when g.data exists AND at least one player has data.team', () => {
  assert.equal(hasFullMatchData({ data: {}, players: [{ data: { team: 'Alliance' } }] }), true);
  assert.equal(hasFullMatchData({ data: {}, players: [{ data: { outcome: 'Victory' } }] }), false); // list-only game, no team
  assert.equal(hasFullMatchData({ players: [{ data: { team: 'Alliance' } }] }), false); // no g.data at all
  assert.equal(hasFullMatchData({ data: {}, players: [] }), false);
});

test('resolvePlayerName falls back from known niceName -> profile snapshot displayName -> raw id', () => {
  state.players = {};
  state.playerStatsSnapshots = {};
  assert.equal(resolvePlayerName('u1'), 'Joueur #u1');

  state.playerStatsSnapshots['u1'] = [{ user: { displayName: 'Zicrom' } }];
  assert.equal(resolvePlayerName('u1'), 'Zicrom');

  state.players['u1'] = { niceNames: { ZicromTag: 5, OldTag: 1 } };
  assert.equal(resolvePlayerName('u1'), 'ZicromTag');
});

test('fmtDuration pads seconds to two digits', () => {
  assert.equal(fmtDuration(65), '1:05');
  assert.equal(fmtDuration(0), '0:00');
});

test('fmtHM switches from minutes to "h min" past one hour', () => {
  assert.equal(fmtHM(1800), '30 min');
  assert.equal(fmtHM(3660), '1 h 1 min');
});

test('fmtDelta always shows an explicit sign for positive values, none for zero', () => {
  assert.ok(fmtDelta(5).startsWith('+'));
  assert.equal(fmtDelta(0), '0');
  assert.ok(!fmtDelta(-5).startsWith('+'));
});

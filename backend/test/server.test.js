// server.js requires ./db at load time, which has the same DATA_DIR isolation
// requirement as backend/test/db.test.js — set it before requiring server.js.
// require.main !== module here, so the require.main guard in server.js (see
// server.js) skips app.listen() — requiring this module never binds a port.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-debrief-server-test-'));
process.env.DATA_DIR = tmpDir;
process.env.USERS_DATA_DIR = tmpDir;

const { isPveGame, extractFromPayload } = require('../server');

test('isPveGame flags Pve-category games and the MoonOfTheDead identifier, leaves normal Pvp games alone', () => {
  assert.equal(isPveGame({ mode: { category: 'Pve', identifier: 'Horde' } }), true);
  assert.equal(isPveGame({ mode: { category: 'Pvp', identifier: 'MoonOfTheDead' } }), true);
  assert.equal(isPveGame({ mode: { category: 'Pvp', identifier: 'Domination' } }), false);
  assert.equal(isPveGame({}), false);
  assert.equal(isPveGame(null), false);
});

test('extractFromPayload recognizes a raw cursorAfterhGameHistory list response', () => {
  const payload = { data: { cursorAfterhGameHistory: { nodes: [{ id: 'g1' }, { id: 'g2' }] } } };
  const { nodes, playerStats } = extractFromPayload(payload);
  assert.equal(nodes.length, 2);
  assert.equal(playerStats.length, 0);
});

test('extractFromPayload recognizes a getAfterhGameHistoryById detail response', () => {
  const payload = { data: { getAfterhGameHistoryById: { id: 'g1', data: {} } } };
  const { nodes } = extractFromPayload(payload);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, 'g1');
});

test('extractFromPayload recognizes a getPlayerByUserId profile response, falling back from user.id to a bare id', () => {
  const withUser = { data: { getPlayerByUserId: { user: { id: 'u1', username: 'Zic' }, statistics: { data: {} } } } };
  const statsA = extractFromPayload(withUser).playerStats;
  assert.equal(statsA[0].user.id, 'u1');

  const bareId = { data: { getPlayerByUserId: { id: 'u2', statistics: { data: {} } } } };
  const statsB = extractFromPayload(bareId).playerStats;
  assert.equal(statsB[0].user.id, 'u2');
});

test('extractFromPayload recognizes a collector export shape ({ nodes, playerStats })', () => {
  const payload = { nodes: [{ id: 'g1' }], playerStats: [{ user: { id: 'u1' }, statistics: null }] };
  const { nodes, playerStats } = extractFromPayload(payload);
  assert.equal(nodes.length, 1);
  assert.equal(playerStats.length, 1);
});

test('extractFromPayload recognizes a bare array of game nodes', () => {
  const { nodes } = extractFromPayload([{ id: 'g1' }, { id: 'g2' }]);
  assert.equal(nodes.length, 2);
});

test('extractFromPayload recognizes an array of GraphQL responses (mixed history + profile)', () => {
  const payload = [
    { data: { cursorAfterhGameHistory: { nodes: [{ id: 'g1' }] } } },
    { data: { getPlayerByUserId: { user: { id: 'u1' }, statistics: null } } },
  ];
  const { nodes, playerStats } = extractFromPayload(payload);
  assert.equal(nodes.length, 1);
  assert.equal(playerStats.length, 1);
});

test('extractFromPayload returns empty arrays for an unrecognized shape', () => {
  const { nodes, playerStats } = extractFromPayload({ foo: 'bar' });
  assert.equal(nodes.length, 0);
  assert.equal(playerStats.length, 0);
});

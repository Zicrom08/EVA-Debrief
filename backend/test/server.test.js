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

const { isPveGame, extractFromPayload, resolveImportAuth, requireImportAccess } = require('../server');
const db = require('../db');

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

// resolveImportAuth()/requireImportAccess() : authentification de POST /api/import (pont
// collecteur, voir eva_history_collector.user.js). Testés directement avec de faux req/res/next
// plutôt qu'un vrai serveur qui écoute — même philosophie que ce fichier pour isPveGame/
// extractFromPayload, aucune dépendance supplémentaire.
function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

test('resolveImportAuth: a session already resolved by the global middleware short-circuits token lookup entirely', () => {
  const req = { user: { userId: 'already-a-session', role: 'contributor' }, headers: {} };
  const res = fakeRes();
  let calledNext = false;
  resolveImportAuth(req, res, () => { calledNext = true; });
  assert.equal(calledNext, true);
  assert.equal(req.user.userId, 'already-a-session'); // inchangé, jamais écrasé par une résolution de jeton
});

test('resolveImportAuth: a valid X-Import-Token resolves req.user to the matching account', () => {
  const user = db.createUser({ username: 'bridgeuser1', role: 'contributor', passwordSalt: 's', passwordHash: 'h' });
  db.updateUser(user.id, { importToken: 'valid-token-1' });
  const req = { headers: { 'x-import-token': 'valid-token-1' } };
  const res = fakeRes();
  let calledNext = false;
  resolveImportAuth(req, res, () => { calledNext = true; });
  assert.equal(calledNext, true);
  assert.equal(req.user.userId, user.id);
  assert.equal(req.user.role, 'contributor');
});

test('resolveImportAuth: missing session AND missing/invalid token -> 401, next never called', () => {
  const req = { headers: { 'x-import-token': 'this-token-does-not-exist' } };
  const res = fakeRes();
  let calledNext = false;
  resolveImportAuth(req, res, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(res.statusCode, 401);

  const req2 = { headers: {} };
  const res2 = fakeRes();
  resolveImportAuth(req2, res2, () => {});
  assert.equal(res2.statusCode, 401);
});

test('resolveImportAuth + requireImportAccess: a readonly account\'s own valid import token still gets blocked 403 (confirmed policy: readonly never imports, whatever the transport)', () => {
  const user = db.createUser({ username: 'bridgeuser2', role: 'readonly', passwordSalt: 's', passwordHash: 'h' });
  db.updateUser(user.id, { importToken: 'readonly-token-1' });
  const req = { headers: { 'x-import-token': 'readonly-token-1' } };
  const res = fakeRes();
  let resolvedOk = false;
  resolveImportAuth(req, res, () => { resolvedOk = true; });
  assert.equal(resolvedOk, true); // le jeton lui-même est valide et se résout...
  assert.equal(req.user.role, 'readonly');

  const res2 = fakeRes();
  let reachedRoute = false;
  requireImportAccess(req, res2, () => { reachedRoute = true; });
  assert.equal(reachedRoute, false); // ...mais requireImportAccess bloque quand même
  assert.equal(res2.statusCode, 403);
});

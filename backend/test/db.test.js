// db.js reads/writes DATA_FILE at module-load time (see db.js top-level code), so
// DATA_DIR must point at an isolated temp directory BEFORE the module is required —
// otherwise this suite would read/corrupt the real data.json/users.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-debrief-db-test-'));
process.env.DATA_DIR = tmpDir;
process.env.USERS_DATA_DIR = tmpDir;

const db = require('../db');

test('upsertGame merges a list-only capture with a later detail-only capture instead of overwriting', () => {
  const listOnly = {
    id: 'g1',
    createdAt: '2026-01-01T00:00:00Z',
    players: [
      { userId: 'u1', data: { outcome: 'Victory', kills: 10, deaths: 2, assists: 3 } },
    ],
  };
  db.upsertGame(listOnly);

  const detailOnly = {
    id: 'g1',
    data: { teamOne: { name: 'Alliance', score: 10 }, teamTwo: { name: 'Rebels', score: 4 } },
    players: [
      { userId: 'u1', data: { team: 'Alliance', score: 500, inflictedDamage: 2000, niceName: 'Zicrom' } },
    ],
  };
  db.upsertGame(detailOnly);

  const merged = db.getAllGames().find(g => g.id === 'g1');
  assert.equal(merged.players[0].data.kills, 10); // preserved from the list capture
  assert.equal(merged.players[0].data.team, 'Alliance'); // added by the detail capture
  assert.equal(merged.players[0].data.niceName, 'Zicrom');
  assert.equal(merged.data.teamOne.name, 'Alliance');
});

test('upsertGame derives a missing player outcome from team scores once team is known', () => {
  db.upsertGame({
    id: 'g2',
    createdAt: '2026-01-01T00:00:00Z',
    data: { teamOne: { name: 'Alliance', score: 10 }, teamTwo: { name: 'Rebels', score: 4 } },
    players: [
      { userId: 'u1', data: { team: 'Alliance' } },
      { userId: 'u2', data: { team: 'Rebels' } },
    ],
  });
  const g = db.getAllGames().find(g => g.id === 'g2');
  assert.equal(g.players.find(p => p.userId === 'u1').data.outcome, 'Victory');
  assert.equal(g.players.find(p => p.userId === 'u2').data.outcome, 'Defeat');
});

test('gameExists / deleteGame is idempotent', () => {
  db.upsertGame({ id: 'g3', createdAt: '2026-01-01T00:00:00Z', players: [] });
  assert.equal(db.gameExists('g3'), true);
  db.deleteGame('g3');
  assert.equal(db.gameExists('g3'), false);
  assert.doesNotThrow(() => db.deleteGame('g3'));
});

test('hashSnapshot includes seasonId so identical stats in different seasons are not deduped', () => {
  const snap1 = { user: { id: 'u1' }, statistics: { data: { kills: 5 } }, experience: null, seasonId: 7 };
  const snap2 = { user: { id: 'u1' }, statistics: { data: { kills: 5 } }, experience: null, seasonId: 8 };
  assert.notEqual(db.hashSnapshot(snap1), db.hashSnapshot(snap2));
});

test('snapshotHashExists / insertSnapshot dedupe by content hash', () => {
  const snap = { user: { id: 'u1' }, capturedAt: '2026-02-01T00:00:00Z', statistics: { data: { kills: 1 } }, experience: null };
  const hash = db.hashSnapshot(snap);
  assert.equal(db.snapshotHashExists('u1', hash), false);
  db.insertSnapshot(snap, hash);
  assert.equal(db.snapshotHashExists('u1', hash), true);
});

test('insertSnapshot keeps a player\'s snapshots sorted ascending by capturedAt regardless of insertion order', () => {
  db.insertSnapshot({ user: { id: 'u2' }, capturedAt: '2026-03-01T00:00:00Z', statistics: null }, 'hashB');
  db.insertSnapshot({ user: { id: 'u2' }, capturedAt: '2026-01-01T00:00:00Z', statistics: null }, 'hashA');
  const all = db.getAllSnapshots().filter(s => s.user.id === 'u2');
  assert.ok(new Date(all[0].capturedAt) < new Date(all[1].capturedAt));
});

test('getAllSnapshots never leaks the internal __hash field', () => {
  db.insertSnapshot({ user: { id: 'u3' }, capturedAt: '2026-01-01T00:00:00Z', statistics: null }, 'hashC');
  const snap = db.getAllSnapshots().find(s => s.user.id === 'u3');
  assert.equal(snap.__hash, undefined);
});

test('createTeam / updateTeam / deleteTeam', () => {
  const team = db.createTeam('Escouade Alpha', ['u1', 'u2']);
  assert.equal(team.name, 'Escouade Alpha');
  const updated = db.updateTeam(team.id, 'Escouade Bravo', ['u1']);
  assert.equal(updated.name, 'Escouade Bravo');
  assert.deepEqual(updated.members, ['u1']);
  db.deleteTeam(team.id);
  assert.equal(db.getAllTeams().find(t => t.id === team.id), undefined);
});

test('createUser / countAdmins / deleteUser', () => {
  const admin = db.createUser({ username: 'admin1', role: 'admin', passwordSalt: 's', passwordHash: 'h' });
  assert.equal(db.countAdmins(), 1);
  db.deleteUser(admin.id);
  assert.equal(db.countAdmins(), 0);
});

test('linkPlayer / unlinkPlayer / getAllPlayerLinks', () => {
  const link = db.linkPlayer('alias1', 'primary1');
  assert.deepEqual(link, { aliasUserId: 'alias1', primaryUserId: 'primary1' });
  assert.deepEqual(db.getAllPlayerLinks(), [{ aliasUserId: 'alias1', primaryUserId: 'primary1' }]);
  db.unlinkPlayer('alias1');
  assert.deepEqual(db.getAllPlayerLinks(), []);
  assert.doesNotThrow(() => db.unlinkPlayer('alias1')); // idempotent
});

test('linkPlayer rejects a self-link, including indirect (A already merged into B, then B into A)', () => {
  assert.equal(db.linkPlayer('same', 'same'), null);
  db.linkPlayer('A', 'B');
  assert.equal(db.linkPlayer('B', 'A'), null); // A est déjà un alias de B -> reviendrait à fusionner B avec lui-même
  db.unlinkPlayer('A');
});

test('linkPlayer always flattens: never stores an alias -> alias -> primary chain', () => {
  db.linkPlayer('X', 'Y');
  const link = db.linkPlayer('Y', 'Z'); // Y était déjà primary pour X ; Y devient à son tour alias de Z
  assert.equal(link.primaryUserId, 'Z');
  const all = Object.fromEntries(db.getAllPlayerLinks().map(l => [l.aliasUserId, l.primaryUserId]));
  assert.equal(all.X, 'Z'); // X repointé directement vers la nouvelle racine, jamais X -> Y -> Z
  assert.equal(all.Y, 'Z');
  db.unlinkPlayer('X'); db.unlinkPlayer('Y');
});

// Placed last: resetAll wipes games/snapshots/teams (but not users) for the whole
// shared db.js module instance, so no other test in this file can run after it.
test('resetAll empties games/snapshots/teams/playerLinks but never touches user accounts', () => {
  db.upsertGame({ id: 'g4', createdAt: '2026-01-01T00:00:00Z', players: [] });
  db.createTeam('Temp', ['u1']);
  db.linkPlayer('aliasR', 'primaryR');
  const user = db.createUser({ username: 'survivor', role: 'admin', passwordSalt: 's', passwordHash: 'h' });
  db.resetAll();
  assert.equal(db.gameCount(), 0);
  assert.equal(db.getAllTeams().length, 0);
  assert.equal(db.getAllPlayerLinks().length, 0);
  assert.notEqual(db.getUserById(user.id), null);
});

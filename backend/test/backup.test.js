// Fichier séparé de db.test.js pour pouvoir fixer BACKUP_RETENTION à une petite valeur sans
// affecter les autres tests (même isolation DATA_DIR/USERS_DATA_DIR que db.test.js — voir
// le commentaire là-bas). BACKUP_INTERVAL_HOURS=0 désactive le minuteur automatique : ces
// tests appellent runBackupNow()/pruneOldBackups() directement, sans dépendre du temps réel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-debrief-backup-test-'));
process.env.DATA_DIR = tmpDir;
process.env.USERS_DATA_DIR = tmpDir;
process.env.BACKUP_RETENTION = '2';
process.env.BACKUP_INTERVAL_HOURS = '0';

const db = require('../db');

test('runBackupNow only backs up files that already exist on disk (users.json is written at module load, data.json is not until the first game)', () => {
  const set = db.runBackupNow();
  assert.deepEqual(set.files.map(f => f.split('-')[0]), ['users']);
});

test('runBackupNow backs up both files once data.json exists too', () => {
  db.upsertGame({ id: 'g1', createdAt: '2026-01-01T00:00:00Z', players: [] });
  const set = db.runBackupNow();
  const kinds = set.files.map(f => f.split('-')[0]).sort();
  assert.deepEqual(kinds, ['data', 'users']);
});

test('runBackupNow disambiguates a timestamp collision instead of silently overwriting a previous backup', () => {
  const a = db.runBackupNow();
  const b = db.runBackupNow(); // peut retomber sur le même horodatage à la milliseconde près
  assert.notEqual(a.timestamp, b.timestamp);
  // BACKUP_RETENTION=2 dans ce fichier : pruneOldBackups() (appelé par runBackupNow()) peut
  // avoir déjà supprimé des sets plus anciens entre les deux appels — seule la survie de la
  // plus récente des deux (b) est garantie, pas le nombre total de sets.
  assert.ok(db.listBackups().some(s => s.timestamp === b.timestamp));
});

test('listBackups groups data/users pairs into sets, most recent first, with a real createdAt', () => {
  const sets = db.listBackups();
  assert.ok(sets.length >= 2);
  assert.ok(sets[0].createdAt);
  assert.ok(new Date(sets[0].createdAt).getTime() >= new Date(sets[sets.length - 1].createdAt).getTime());
});

test('backupFilePath rejects anything outside the exact backup filename format (defends against path traversal), accepts a real one', () => {
  assert.equal(db.backupFilePath('../../etc/passwd'), null);
  assert.equal(db.backupFilePath('not-a-real-backup.json'), null);
  assert.equal(db.backupFilePath('data-../../etc-passwd.json'), null);
  const real = db.listBackups()[0].files[0].name;
  assert.ok(db.backupFilePath(real));
});

test('pruneOldBackups keeps only the BACKUP_RETENTION most recent sets', () => {
  // BACKUP_RETENTION=2 pour ce fichier ; on ajoute 3 sets "anciens" avec des mtimes
  // contrôlées via fs.utimesSync plutôt que d'appeler runBackupNow() en boucle serrée
  // (non représentatif d'un usage réel, et sujet à collision d'horodatage à la milliseconde).
  const backupDir = path.join(tmpDir, 'backups');
  for (let i = 0; i < 3; i++) {
    const name = `data-fake-${i}.json`;
    fs.writeFileSync(path.join(backupDir, name), '{}');
    const old = new Date(2020 + i, 0, 1);
    fs.utimesSync(path.join(backupDir, name), old, old);
  }
  db.pruneOldBackups();
  const sets = db.listBackups();
  assert.equal(sets.length, 2);
  sets.forEach(s => assert.ok(!s.timestamp.startsWith('fake'))); // les anciens ont bien été purgés
});

test('restoreBackup rejects an unknown/malformed timestamp (also defends against path traversal)', () => {
  assert.equal(db.restoreBackup('../../etc/passwd'), null);
  assert.equal(db.restoreBackup('not-a-real-set'), null);
});

test('restoreBackup reloads in-memory state AND makes it durable (survives a later mutation)', () => {
  db.upsertGame({ id: 'g-before', createdAt: '2026-01-01T00:00:00Z', players: [] });
  const set = db.runBackupNow(); // capture l'état avec seulement g-before
  db.upsertGame({ id: 'g-after', createdAt: '2026-01-02T00:00:00Z', players: [] });
  assert.ok(db.gameExists('g-after'));

  const result = db.restoreBackup(set.timestamp, ['data']);
  assert.deepEqual(result.restored, ['data']);
  assert.ok(db.gameExists('g-before'));
  assert.ok(!db.gameExists('g-after')); // état d'avant la restauration bien remplacé

  // Une mutation ultérieure ne doit pas faire ressurgir g-after depuis un état en mémoire
  // resté périmé (c'était le bug possible sans réassignation de `state`) — mais surtout,
  // le fichier data.json sur disque doit déjà refléter la restauration, pas seulement la
  // mémoire du process courant : on le relit directement.
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'data.json'), 'utf-8'));
  assert.ok(onDisk.games['g-before']);
  assert.ok(!onDisk.games['g-after']);
});

test('restoreBackup takes its own safety backup of the current on-disk state before overwriting anything', () => {
  db.upsertGame({ id: 'g-safety-before', createdAt: '2026-01-01T00:00:00Z', players: [] });
  const target = db.runBackupNow();
  db.upsertGame({ id: 'g-safety-current', createdAt: '2026-01-02T00:00:00Z', players: [] });

  const result = db.restoreBackup(target.timestamp, ['data']);
  assert.ok(result.safetyBackup);
  assert.notEqual(result.safetyBackup.timestamp, target.timestamp);
  // BACKUP_RETENTION=2 dans ce fichier : le set de sécurité peut faire dépasser la
  // rétention et provoquer une purge immédiate — on vérifie donc juste qu'il existe
  // encore (pas que le compte total ait grandi, qui n'est pas garanti sous rétention).
  assert.ok(db.listBackups().some(s => s.timestamp === result.safetyBackup.timestamp));

  // Le set de sécurité, lui, doit contenir l'état d'AVANT la restauration (g-safety-current).
  const safetySet = db.listBackups().find(s => s.timestamp === result.safetyBackup.timestamp);
  const dataFile = safetySet.files.find(f => f.kind === 'data');
  const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'backups', dataFile.name), 'utf-8'));
  assert.ok(raw.games['g-safety-current']);
});

test('restoreBackup with kinds=["data"] never touches usersState even if the set also has a users file', () => {
  db.createUser({ username: 'temp-user', passwordSalt: 's', passwordHash: 'h', role: 'readonly' });
  const set = db.runBackupNow(); // set complet (data + users)
  const usersBefore = db.getAllUsers().length;

  db.createUser({ username: 'another-user', passwordSalt: 's', passwordHash: 'h', role: 'readonly' });
  const result = db.restoreBackup(set.timestamp, ['data']);
  assert.deepEqual(result.restored, ['data']);
  assert.equal(db.getAllUsers().length, usersBefore + 1); // pas touché par la restauration 'data' seule
});

test('restoreBackup returns an empty result (no throw) when the requested kind is absent from that set', () => {
  const tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-debrief-backup-test3-'));
  process.env.DATA_DIR = tmpDir3;
  process.env.USERS_DATA_DIR = tmpDir3;
  delete require.cache[require.resolve('../db')];
  const freshDb = require('../db');

  const set = freshDb.runBackupNow(); // aucune partie importée : seulement users.json
  const result = freshDb.restoreBackup(set.timestamp, ['data']);
  assert.deepEqual(result, { restored: [], safetyBackup: null });
});

test('startAutoBackup takes an immediate backup when none exist, and stopAutoBackup clears the timer without throwing', () => {
  const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-debrief-backup-test2-'));
  process.env.DATA_DIR = tmpDir2;
  process.env.USERS_DATA_DIR = tmpDir2;
  process.env.BACKUP_INTERVAL_HOURS = '24';
  delete require.cache[require.resolve('../db')];
  const freshDb = require('../db');

  assert.equal(freshDb.listBackups().length, 0);
  freshDb.startAutoBackup();
  assert.equal(freshDb.listBackups().length, 1); // aucune sauvegarde connue -> une immédiate
  assert.doesNotThrow(() => freshDb.stopAutoBackup());
});

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

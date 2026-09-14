import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/state.js';
import { snapshotSeasonId, displaySeasonId, normalizeSnapshotStats, computeSeasons, filteredSnapshotsForUser } from '../src/seasons.js';

test('snapshotSeasonId reads the root seasonId (v8.0+ collector) before falling back to experience.seasonId (pre-v8.0)', () => {
  assert.equal(snapshotSeasonId({ seasonId: 8, experience: { seasonId: 5 } }), 8);
  assert.equal(snapshotSeasonId({ experience: { seasonId: 5 } }), 5);
  assert.equal(snapshotSeasonId({}), null);
});

test('displaySeasonId corrects the API off-by-one and passes null through unchanged', () => {
  assert.equal(displaySeasonId(8), 7);
  assert.equal(displaySeasonId(null), null);
});

test('normalizeSnapshotStats: legacy statistics.data format reports playtime and damage as available', () => {
  const snap = { statistics: { data: { gameCount: 10, gameVictoryCount: 6, kills: 50, deaths: 20, gameTime: 3600, inflictedDamage: 1000 } } };
  const norm = normalizeSnapshotStats(snap);
  assert.equal(norm.hasPlaytime, true);
  assert.equal(norm.hasDamage, true);
  assert.equal(norm.gameCount, 10);
});

test('normalizeSnapshotStats: reduced battleArenaStatistics format derives gameVictoryCount from winRate and flags damage as unavailable', () => {
  const snap = { battleArenaStatistics: { data: { gameCount: 10, winRate: 0.6, kills: 50, deaths: 20, gameTime: 1800 } } };
  const norm = normalizeSnapshotStats(snap);
  assert.equal(norm.gameVictoryCount, 6);
  assert.equal(norm.gameDefeatCount, 4);
  assert.equal(norm.hasDamage, false);
  assert.equal(norm.inflictedDamage, 0);
});

test('normalizeSnapshotStats returns null for a fragment matching neither known shape', () => {
  assert.equal(normalizeSnapshotStats({}), null);
});

test('computeSeasons derives bounds from both profile snapshots and games, sorted ascending, only the last is current', () => {
  state.playerStatsSnapshots = {
    u1: [{ seasonId: 7, capturedAt: '2026-01-10T00:00:00Z' }],
  };
  state.gamesById = {
    g1: { seasonId: 8, createdAt: '2026-02-01T00:00:00Z' },
  };
  const seasons = computeSeasons();
  assert.deepEqual(seasons.map(s => s.seasonId), [7, 8]);
  assert.equal(seasons[0].isCurrent, false);
  assert.equal(seasons[1].isCurrent, true);
});

test('filteredSnapshotsForUser gathers snapshots from merged aliases too, not just the canonical account', () => {
  state.playerLinks = { aliasY: 'primaryY' };
  state.playerStatsSnapshots = {
    primaryY: [{ capturedAt: '2026-01-01T00:00:00Z', seasonId: 7 }],
    aliasY: [{ capturedAt: '2026-01-02T00:00:00Z', seasonId: 7 }],
  };
  state.selectedSeasonId = null;
  state.dateRangeStart = null;
  state.dateRangeEnd = null;
  const snaps = filteredSnapshotsForUser('primaryY');
  assert.equal(snaps.length, 2);
  assert.ok(new Date(snaps[0].capturedAt) < new Date(snaps[1].capturedAt));
  state.playerLinks = {};
});

// Régression : importer une VIEILLE saison APRÈS avoir déjà la saison en cours donne à cette
// vieille capture un capturedAt PLUS RÉCENT (le moment où on l'a importée) que son numéro de
// saison ne le suggère. Un tri par capturedAt seul la plaçait donc en toute fin de liste,
// faisant détecter à tort une "nouvelle saison" par renderEvolutionTable() (voir
// profil/season.js) juste après la dernière capture de la saison en cours.
test('filteredSnapshotsForUser orders snapshots by SEASON first, not just capturedAt — importing an old season after the current one must not reorder it to the end', () => {
  state.playerStatsSnapshots = {
    p1: [
      // Saison en cours (8), capturée il y a un moment.
      { capturedAt: '2026-03-01T00:00:00Z', seasonId: 8 },
      // Vieille saison (5), importée AUJOURD'HUI (capturedAt le plus récent de tous), donc
      // APRÈS la saison en cours dans le temps réel — mais elle doit rester trouvée AVANT
      // dans la liste, puisque saison 5 précède saison 8.
      { capturedAt: '2026-06-01T00:00:00Z', seasonId: 5 },
    ],
  };
  state.selectedSeasonId = null;
  state.dateRangeStart = null;
  state.dateRangeEnd = null;
  const snaps = filteredSnapshotsForUser('p1');
  assert.deepEqual(snaps.map(s => s.seasonId), [5, 8]);
});

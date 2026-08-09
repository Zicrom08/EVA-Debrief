import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/state.js';
import { inDateRange, gameInSelectedRange, isMapExcluded, isModeExcluded, filteredGamesArray } from '../src/game-filters.js';

function resetState() {
  state.gamesById = {};
  state.dateRangeStart = null;
  state.dateRangeEnd = null;
  state.selectedSeasonId = null;
  state.excludedMaps = new Set();
  state.excludedModes = new Set();
}

test('inDateRange respects both bounds; no bound set = unrestricted', () => {
  resetState();
  const iso = '2026-06-15T12:00:00Z';
  assert.equal(inDateRange(iso), true);
  state.dateRangeStart = new Date('2026-06-16').getTime();
  assert.equal(inDateRange(iso), false);
  state.dateRangeStart = null;
  state.dateRangeEnd = new Date('2026-06-01').getTime();
  assert.equal(inDateRange(iso), false);
});

test('gameInSelectedRange compares seasonId exactly when a season is selected and the game carries one', () => {
  resetState();
  state.selectedSeasonId = 8;
  // createdAt is intentionally outside any sane date range - seasonId match alone must decide
  assert.equal(gameInSelectedRange({ seasonId: 8, createdAt: '2020-01-01' }), true);
  assert.equal(gameInSelectedRange({ seasonId: 7, createdAt: '2026-06-01' }), false);
});

test('gameInSelectedRange falls back to the date-range approximation when the game has no seasonId', () => {
  resetState();
  state.selectedSeasonId = 8;
  state.dateRangeStart = new Date('2026-01-01').getTime();
  state.dateRangeEnd = new Date('2026-12-31').getTime();
  assert.equal(gameInSelectedRange({ createdAt: '2026-06-01' }), true);
  assert.equal(gameInSelectedRange({ createdAt: '2020-06-01' }), false);
});

test('isMapExcluded / isModeExcluded only match named exclusions', () => {
  resetState();
  state.excludedMaps.add('Ceres');
  state.excludedModes.add('MoonOfTheDead');
  assert.equal(isMapExcluded({ map: { name: 'Ceres' } }), true);
  assert.equal(isMapExcluded({ map: { name: 'Titan' } }), false);
  assert.equal(isMapExcluded({}), false);
  assert.equal(isModeExcluded({ mode: { identifier: 'MoonOfTheDead' } }), true);
  assert.equal(isModeExcluded({ mode: { identifier: 'Domination' } }), false);
});

test('filteredGamesArray combines the range filter with map/mode exclusions', () => {
  resetState();
  state.excludedMaps.add('Ceres');
  state.gamesById = {
    g1: { id: 'g1', createdAt: '2026-06-01', map: { name: 'Ceres' } },
    g2: { id: 'g2', createdAt: '2026-06-01', map: { name: 'Titan' } },
  };
  const result = filteredGamesArray();
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'g2');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/state.js';
import { inDateRange, gameInSelectedRange, isMapExcluded, isModeExcluded, filteredGamesArray, gameMatchesComposition } from '../src/game-filters.js';

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

function fullGame(rosterByTeam) {
  // rosterByTeam: { ALLIANCE: [uid,...], REBELS: [uid,...] } — construit un roster minimal
  // à détail complet (voir hasFullMatchData) pour tester gameMatchesComposition().
  const players = [];
  Object.entries(rosterByTeam).forEach(([team, uids]) => {
    uids.forEach(uid => players.push({ userId: uid, data: { team } }));
  });
  return { data: {}, players };
}

test('gameMatchesComposition is a no-op (always true) when no teammates/opponents are selected', () => {
  const g = fullGame({ ALLIANCE: ['me', 'a'], REBELS: ['b'] });
  assert.equal(gameMatchesComposition(g, 'me', new Set(), new Set()), true);
  assert.equal(gameMatchesComposition({}, 'me', new Set(), new Set()), true);
});

test('gameMatchesComposition requires every selected teammate on the same team as the reference player', () => {
  const g = fullGame({ ALLIANCE: ['me', 'a'], REBELS: ['b', 'c'] });
  assert.equal(gameMatchesComposition(g, 'me', new Set(['a']), new Set()), true);
  assert.equal(gameMatchesComposition(g, 'me', new Set(['b']), new Set()), false, 'b is on the opposing team, not a teammate');
  assert.equal(gameMatchesComposition(g, 'me', new Set(['ghost']), new Set()), false, 'ghost never played this game');
});

test('gameMatchesComposition requires every selected opponent on the opposing team', () => {
  const g = fullGame({ ALLIANCE: ['me', 'a'], REBELS: ['b', 'c'] });
  assert.equal(gameMatchesComposition(g, 'me', new Set(), new Set(['b', 'c'])), true);
  assert.equal(gameMatchesComposition(g, 'me', new Set(), new Set(['a'])), false, 'a is a teammate, not an opponent');
});

test('gameMatchesComposition combines teammate and opponent requirements', () => {
  const g = fullGame({ ALLIANCE: ['me', 'a'], REBELS: ['b', 'c'] });
  assert.equal(gameMatchesComposition(g, 'me', new Set(['a']), new Set(['b'])), true);
  assert.equal(gameMatchesComposition(g, 'me', new Set(['a']), new Set(['c', 'ghost'])), false);
});

test('gameMatchesComposition excludes games without full team-assignment data as soon as a filter is active', () => {
  // Nouveau format d'historique EVA (juillet 2026) : plus d'assignation d'équipe par joueur —
  // voir hasFullMatchData() dans format.js. Une partie sans ça ne peut jamais satisfaire un
  // filtre de composition actif, faute de pouvoir vérifier qui était dans quelle équipe.
  const g = { data: {}, players: [{ userId: 'me', data: {} }, { userId: 'a', data: {} }] };
  assert.equal(gameMatchesComposition(g, 'me', new Set(['a']), new Set()), false);
});

test('gameMatchesComposition never treats two unknown teams as a match (the classic undefined===undefined trap)', () => {
  // hasFullMatchData(g) est vrai (un joueur porte une équipe) mais le joueur ciblé par le
  // filtre, lui, n'a pas d'équipe connue — un bug naïf (comparaison non gardée) le
  // regrouperait à tort avec n'importe qui d'autre sans équipe connue non plus.
  const g = { data: {}, players: [
    { userId: 'me', data: { team: 'ALLIANCE' } },
    { userId: 'a', data: {} },
  ] };
  assert.equal(gameMatchesComposition(g, 'me', new Set(['a']), new Set()), false);
  assert.equal(gameMatchesComposition(g, 'me', new Set(), new Set(['a'])), false);
});

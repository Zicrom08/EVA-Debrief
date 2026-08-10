import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/state.js';
import { canonicalUid, aliasesOf } from '../src/player-links.js';

function resetState() {
  state.playerLinks = {};
}

test('canonicalUid returns the uid itself when not merged', () => {
  resetState();
  assert.equal(canonicalUid('u1'), 'u1');
});

test('canonicalUid follows the alias -> primary map, and coerces to string', () => {
  resetState();
  state.playerLinks = { alias1: 'primary1' };
  assert.equal(canonicalUid('alias1'), 'primary1');
  assert.equal(canonicalUid(123), '123'); // pas d'alias -> renvoyé tel quel, en string
});

test('canonicalUid returns null/undefined unchanged', () => {
  resetState();
  assert.equal(canonicalUid(null), null);
  assert.equal(canonicalUid(undefined), undefined);
});

test('aliasesOf returns every alias pointing to a given primary, empty if none', () => {
  resetState();
  state.playerLinks = { a1: 'p1', a2: 'p1', a3: 'p2' };
  assert.deepEqual(aliasesOf('p1').sort(), ['a1', 'a2']);
  assert.deepEqual(aliasesOf('p2'), ['a3']);
  assert.deepEqual(aliasesOf('p3'), []);
});

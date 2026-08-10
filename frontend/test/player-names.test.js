import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/state.js';
import { applyPlayerNameOverrides } from '../src/player-names.js';

function resetState() {
  state.playerNames = {};
  state.playerLinks = {};
}

test('applyPlayerNameOverrides sets the custom name with an infinite weight, winning any niceName tally', () => {
  resetState();
  state.playerNames = { u1: 'NouveauTag' };
  const players = { u1: { niceNames: { AncienTag: 50 }, games: 50 } };
  applyPlayerNameOverrides(players);
  assert.equal(players.u1.niceNames.NouveauTag, Infinity);
  assert.equal(players.u1.niceNames.AncienTag, 50); // pas effacé, juste dominé par le tri de mostCommonName()
});

test('applyPlayerNameOverrides creates the player entry if it does not exist yet', () => {
  resetState();
  state.playerNames = { u2: 'SoloName' };
  const players = {};
  applyPlayerNameOverrides(players);
  assert.equal(players.u2.niceNames.SoloName, Infinity);
  assert.equal(players.u2.games, 0);
});

test('applyPlayerNameOverrides follows a later merge: a rename set before merging still applies to the new canonical id', () => {
  resetState();
  state.playerNames = { u3: 'RenamedBeforeMerge' };
  state.playerLinks = { u3: 'u4' }; // u3 fusionné dans u4 APRÈS avoir été renommé
  const players = { u4: { niceNames: { OtherTag: 10 }, games: 10 } };
  applyPlayerNameOverrides(players);
  assert.equal(players.u4.niceNames.RenamedBeforeMerge, Infinity);
  assert.equal(players.u3, undefined); // aucune entrée fantôme créée sous l'ancien id
});

test('applyPlayerNameOverrides ignores empty/falsy names', () => {
  resetState();
  state.playerNames = { u5: '' };
  const players = {};
  applyPlayerNameOverrides(players);
  assert.equal(players.u5, undefined);
});

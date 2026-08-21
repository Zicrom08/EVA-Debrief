import test from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/state.js';
import { hasFullMatchData, deriveTeams, findMvp, resolvePlayerName, findPlayerInGame, latestNiceName, nameFreshness, fmtDuration, fmtHM, fmtDelta } from '../src/format.js';

test('findPlayerInGame finds a player by userId with loose equality (string/number mix)', () => {
  const g = { players: [{ userId: '123', data: {} }] };
  assert.equal(findPlayerInGame(g, 123), g.players[0]);
  assert.equal(findPlayerInGame(g, '123'), g.players[0]);
  assert.equal(findPlayerInGame(g, '999'), undefined);
});

test('findPlayerInGame matches through a merged player alias, in either direction', () => {
  state.playerLinks = { alias1: 'primary1' };
  const g = { players: [{ userId: 'alias1', data: {} }] };
  assert.equal(findPlayerInGame(g, 'primary1'), g.players[0]); // recherche par primary, trouve l'alias qui a joué
  assert.equal(findPlayerInGame(g, 'alias1'), g.players[0]);
  state.playerLinks = {};
});

test('latestNiceName picks the highest-weighted niceName (a game timestamp in practice, or Infinity for a forced rename)', () => {
  assert.equal(latestNiceName({ niceNames: { OldTag: 1000, NewTag: 2000 } }), 'NewTag');
  assert.equal(latestNiceName({ niceNames: { OldTag: 2000, ForcedName: Infinity } }), 'ForcedName');
});

test('nameFreshness reports the winning niceName\'s own timestamp as its "as of" date, and flags Infinity as a forced rename', () => {
  const auto = nameFreshness({ niceNames: { OldTag: new Date('2026-01-01').getTime(), NewTag: new Date('2026-06-01').getTime() } });
  assert.equal(auto.name, 'NewTag');
  assert.equal(auto.forced, false);
  assert.equal(auto.asOf, new Date('2026-06-01').toISOString());

  const forced = nameFreshness({ niceNames: { AutoTag: new Date('2026-06-01').getTime(), ForcedName: Infinity } });
  assert.equal(forced.name, 'ForcedName');
  assert.equal(forced.forced, true);
  assert.equal(forced.asOf, null);
});

test('hasFullMatchData is true only when g.data exists AND at least one player has data.team', () => {
  assert.equal(hasFullMatchData({ data: {}, players: [{ data: { team: 'Alliance' } }] }), true);
  assert.equal(hasFullMatchData({ data: {}, players: [{ data: { outcome: 'Victory' } }] }), false); // list-only game, no team
  assert.equal(hasFullMatchData({ players: [{ data: { team: 'Alliance' } }] }), false); // no g.data at all
  assert.equal(hasFullMatchData({ data: {}, players: [] }), false);
});

test('deriveTeams splits by team name when both gd.teamOne/teamTwo.name are present', () => {
  const g = {
    data: { teamOne: { name: 'ALLIANCE' }, teamTwo: { name: 'REBELS' } },
    players: [
      { userId: 'a1', data: { team: 'ALLIANCE' } },
      { userId: 'r1', data: { team: 'REBELS' } },
      { userId: 'r2', data: { team: 'REBELS' } },
    ],
  };
  const { teamAKey, teamBKey, teamA, teamB } = deriveTeams(g);
  assert.equal(teamAKey, 'ALLIANCE');
  assert.equal(teamBKey, 'REBELS');
  assert.deepEqual(teamA.map(p => p.userId), ['a1']);
  assert.deepEqual(teamB.map(p => p.userId), ['r1', 'r2']);
});

test('deriveTeams falls back to the two distinct p.data.team values when a team name is null', () => {
  const g = {
    data: { teamOne: { name: null }, teamTwo: { name: null } },
    players: [
      { userId: 'a1', data: { team: 'HASHIRAS' } },
      { userId: 'r1', data: { team: 'ARISE' } },
    ],
  };
  const { teamAKey, teamBKey, teamA, teamB } = deriveTeams(g);
  assert.equal(teamAKey, 'HASHIRAS');
  assert.equal(teamBKey, 'ARISE');
  assert.deepEqual(teamA.map(p => p.userId), ['a1']);
  assert.deepEqual(teamB.map(p => p.userId), ['r1']);
});

test('deriveTeams never lumps two players with an undefined team into the same side (undefined === undefined regression)', () => {
  const g = {
    data: {},
    players: [
      { userId: 'p1', data: { outcome: 'Victory' } }, // no team field at all
      { userId: 'p2', data: { outcome: 'Defeat' } },
    ],
  };
  const { teamAKey, teamBKey, teamA, teamB } = deriveTeams(g);
  assert.equal(teamAKey, null);
  assert.equal(teamBKey, null);
  assert.equal(teamA.length, 0);
  assert.equal(teamB.length, 0);
});

test('findMvp picks the highest score across both teams on a full-match-data game', () => {
  const g = {
    data: {},
    players: [
      { userId: 'u1', data: { team: 'ALLIANCE', score: 1200 } },
      { userId: 'u2', data: { team: 'ALLIANCE', score: 1800 } },
      { userId: 'u3', data: { team: 'REBELS', score: 1500 } },
    ],
  };
  assert.equal(findMvp(g).userId, 'u2');
});

test('findMvp uses EVA\'s isMvp flag on a reduced (list-only) game, falling back to most kills if absent', () => {
  const flagged = {
    players: [
      { userId: 'u1', isMvp: false, data: { outcome: 'Victory', kills: 10 } },
      { userId: 'u2', isMvp: true, data: { outcome: 'Victory', kills: 3 } },
    ],
  };
  assert.equal(findMvp(flagged).userId, 'u2');

  const unflagged = {
    players: [
      { userId: 'u1', data: { outcome: 'Victory', kills: 10 } },
      { userId: 'u2', data: { outcome: 'Defeat', kills: 3 } },
    ],
  };
  assert.equal(findMvp(unflagged).userId, 'u1');
});

test('findMvp returns null for a game with no players', () => {
  assert.equal(findMvp({ players: [] }), null);
  assert.equal(findMvp({}), null);
});

test('resolvePlayerName falls back from known niceName -> profile snapshot displayName -> raw id', () => {
  state.players = {};
  state.playerStatsSnapshots = {};
  assert.equal(resolvePlayerName('u1'), 'Joueur #u1');

  state.playerStatsSnapshots['u1'] = [{ user: { displayName: 'Zicrom' } }];
  assert.equal(resolvePlayerName('u1'), 'Zicrom');

  state.players['u1'] = { niceNames: { ZicromTag: 5, OldTag: 1 } };
  assert.equal(resolvePlayerName('u1'), 'ZicromTag');
});

test('resolvePlayerName falls back to a merged alias\'s profile snapshot when the canonical account has none of its own', () => {
  state.players = {};
  state.playerStatsSnapshots = { aliasX: [{ user: { displayName: 'AliasName' } }] };
  state.playerLinks = { aliasX: 'primaryX' };
  assert.equal(resolvePlayerName('primaryX'), 'AliasName');
  state.playerLinks = {};
});

test('fmtDuration pads seconds to two digits', () => {
  assert.equal(fmtDuration(65), '1:05');
  assert.equal(fmtDuration(0), '0:00');
});

test('fmtHM switches from minutes to "h min" past one hour', () => {
  assert.equal(fmtHM(1800), '30 min');
  assert.equal(fmtHM(3660), '1 h 1 min');
});

test('fmtDelta always shows an explicit sign for positive values, none for zero', () => {
  assert.ok(fmtDelta(5).startsWith('+'));
  assert.equal(fmtDelta(0), '0');
  assert.ok(!fmtDelta(-5).startsWith('+'));
});

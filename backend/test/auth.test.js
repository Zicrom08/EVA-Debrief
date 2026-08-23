const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../auth');

test('hashPassword/verifyPassword round-trips correctly and rejects a wrong password', () => {
  const { salt, hash } = auth.hashPassword('correct horse battery staple');
  assert.equal(auth.verifyPassword('correct horse battery staple', salt, hash), true);
  assert.equal(auth.verifyPassword('wrong password', salt, hash), false);
});

test('verifyPassword handles empty/undefined candidates without throwing', () => {
  const { salt, hash } = auth.hashPassword('secret');
  assert.equal(auth.verifyPassword(undefined, salt, hash), false);
  assert.equal(auth.verifyPassword('', salt, hash), false);
});

test('createSession / getSession / destroySession lifecycle', () => {
  const token = auth.createSession('u1', 'admin');
  const session = auth.getSession(token);
  assert.equal(session.userId, 'u1');
  assert.equal(session.role, 'admin');
  auth.destroySession(token);
  assert.equal(auth.getSession(token), null);
});

test('getSession returns null for an unknown or missing token', () => {
  assert.equal(auth.getSession('nonexistent-token'), null);
  assert.equal(auth.getSession(null), null);
});

test('destroySessionsForUser invalidates every session for that user, and only that user', () => {
  const t1 = auth.createSession('u2', 'contributor');
  const t2 = auth.createSession('u2', 'contributor');
  const t3 = auth.createSession('u3', 'readonly');
  auth.destroySessionsForUser('u2');
  assert.equal(auth.getSession(t1), null);
  assert.equal(auth.getSession(t2), null);
  assert.notEqual(auth.getSession(t3), null);
});

test('destroyAllSessions invalidates every session regardless of user', () => {
  const t1 = auth.createSession('ua', 'admin');
  const t2 = auth.createSession('ub', 'readonly');
  auth.destroyAllSessions();
  assert.equal(auth.getSession(t1), null);
  assert.equal(auth.getSession(t2), null);
});

test('bearerToken extracts the token from a well-formed Authorization header, case-insensitive on "Bearer"', () => {
  assert.equal(auth.bearerToken({ headers: { authorization: 'Bearer abc123' } }), 'abc123');
});

test('bearerToken returns null when the header is absent or malformed', () => {
  assert.equal(auth.bearerToken({ headers: {} }), null);
  assert.equal(auth.bearerToken({ headers: { authorization: 'abc123' } }), null); // pas de préfixe "Bearer "
  assert.equal(auth.bearerToken({ headers: { authorization: 'Basic abc123' } }), null); // mauvais schéma
});

test('parseCookies parses a Cookie header into key/value pairs, URL-decoded', () => {
  const req = { headers: { cookie: 'eva_session=abc123; other=hello%20world' } };
  const cookies = auth.parseCookies(req);
  assert.equal(cookies.eva_session, 'abc123');
  assert.equal(cookies.other, 'hello world');
});

test('parseCookies returns an empty object when there is no cookie header', () => {
  assert.deepEqual(auth.parseCookies({ headers: {} }), {});
});

test('sessionCookieHeader marks Secure only for HTTPS requests (direct or via X-Forwarded-Proto)', () => {
  const httpHeader = auth.sessionCookieHeader('tok', { secure: false, headers: {} }, 60);
  assert.ok(!httpHeader.includes('Secure'));

  const httpsHeader = auth.sessionCookieHeader('tok', { secure: true, headers: {} }, 60);
  assert.ok(httpsHeader.includes('Secure'));

  const proxiedHeader = auth.sessionCookieHeader('tok', { secure: false, headers: { 'x-forwarded-proto': 'https' } }, 60);
  assert.ok(proxiedHeader.includes('Secure'));
});

test('sessionCookieHeader defaults to SameSite=Lax, no CORS_ORIGIN set', () => {
  assert.equal(process.env.CORS_ORIGIN, undefined); // hypothèse de départ du test
  const header = auth.sessionCookieHeader('tok', { secure: false, headers: {} }, 60);
  assert.ok(header.includes('SameSite=Lax'));
});

test('sessionCookieHeader switches to SameSite=None + forces Secure when CORS_ORIGIN is set (cross-site cookie, ex: frontend sur GitHub Pages)', () => {
  process.env.CORS_ORIGIN = 'https://example.github.io';
  try {
    const header = auth.sessionCookieHeader('tok', { secure: false, headers: {} }, 60);
    assert.ok(header.includes('SameSite=None'));
    assert.ok(header.includes('Secure')); // SameSite=None exige Secure, même sans HTTPS détecté sur CETTE requête
  } finally {
    delete process.env.CORS_ORIGIN;
  }
});

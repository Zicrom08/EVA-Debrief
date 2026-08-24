// auth.js lit/écrit sessions.json au chargement du module (voir SESSIONS_DATA_DIR/
// SESSIONS_FILE dans auth.js, même raison que DATA_DIR dans db.js/backend/test/db.test.js) —
// DATA_DIR doit pointer vers un dossier temporaire isolé AVANT le require, sinon cette suite
// lirait/écrirait le vrai sessions.json du dépôt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-debrief-auth-test-'));
process.env.DATA_DIR = tmpDir;

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

test('sessions survive a process restart (persisted to sessions.json, reloaded on require)', () => {
  const token = auth.createSession('u-persist', 'admin');
  delete require.cache[require.resolve('../auth')];
  const freshAuth = require('../auth'); // simule un redémarrage : mémoire vidée, relit le disque

  const session = freshAuth.getSession(token);
  assert.ok(session);
  assert.equal(session.userId, 'u-persist');
  assert.equal(session.role, 'admin');
});

test('a session destroyed before restart never comes back after reload', () => {
  const token = auth.createSession('u-gone', 'readonly');
  auth.destroySession(token);
  delete require.cache[require.resolve('../auth')];
  const freshAuth = require('../auth');
  assert.equal(freshAuth.getSession(token), null);
});

test('an already-expired session is dropped on reload rather than reappearing forever', () => {
  const raw = fs.readFileSync(path.join(tmpDir, 'sessions.json'), 'utf-8');
  const sessions = JSON.parse(raw);
  sessions['expired-token'] = { userId: 'u-old', role: 'admin', expires: Date.now() - 1000 };
  fs.writeFileSync(path.join(tmpDir, 'sessions.json'), JSON.stringify(sessions));

  delete require.cache[require.resolve('../auth')];
  const freshAuth = require('../auth');
  assert.equal(freshAuth.getSession('expired-token'), null);
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

test('recordLoginFailure locks out an IP only once LOGIN_RATE_LIMIT_MAX failures land within the window', () => {
  process.env.LOGIN_RATE_LIMIT_MAX = '3';
  process.env.LOGIN_RATE_LIMIT_MINUTES = '15';
  const ip = '1.2.3.4';
  assert.equal(auth.loginRateLimitStatus(ip).locked, false);
  auth.recordLoginFailure(ip);
  auth.recordLoginFailure(ip);
  assert.equal(auth.loginRateLimitStatus(ip).locked, false); // 2 échecs, seuil à 3
  auth.recordLoginFailure(ip);
  const status = auth.loginRateLimitStatus(ip);
  assert.equal(status.locked, true);
  assert.ok(status.retryAfterSeconds > 0 && status.retryAfterSeconds <= 15 * 60);
  delete process.env.LOGIN_RATE_LIMIT_MAX;
  delete process.env.LOGIN_RATE_LIMIT_MINUTES;
});

test('recordLoginSuccess clears prior failures for that IP (a legitimate mistyped password should not linger)', () => {
  process.env.LOGIN_RATE_LIMIT_MAX = '2';
  const ip = '5.6.7.8';
  auth.recordLoginFailure(ip);
  auth.recordLoginSuccess(ip);
  auth.recordLoginFailure(ip);
  assert.equal(auth.loginRateLimitStatus(ip).locked, false); // repart de zéro après le succès
  delete process.env.LOGIN_RATE_LIMIT_MAX;
});

test('login rate limiting is scoped per IP, never shared across different IPs', () => {
  process.env.LOGIN_RATE_LIMIT_MAX = '1';
  auth.recordLoginFailure('9.9.9.9');
  assert.equal(auth.loginRateLimitStatus('9.9.9.9').locked, true);
  assert.equal(auth.loginRateLimitStatus('8.8.8.8').locked, false);
  delete process.env.LOGIN_RATE_LIMIT_MAX;
});

test('loginRateLimitStatus auto-clears once the lockout window has passed', async () => {
  process.env.LOGIN_RATE_LIMIT_MAX = '1';
  process.env.LOGIN_RATE_LIMIT_MINUTES = String(10 / 60000); // ~10ms, pour ne pas ralentir la suite
  const ip = '10.10.10.10';
  auth.recordLoginFailure(ip);
  assert.equal(auth.loginRateLimitStatus(ip).locked, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(auth.loginRateLimitStatus(ip).locked, false);
  delete process.env.LOGIN_RATE_LIMIT_MAX;
  delete process.env.LOGIN_RATE_LIMIT_MINUTES;
});

test('registerRateLimitStatus uses its own REGISTER_RATE_LIMIT_MAX, independent of LOGIN_RATE_LIMIT_MAX', () => {
  process.env.LOGIN_RATE_LIMIT_MAX = '1';
  process.env.REGISTER_RATE_LIMIT_MAX = '2';
  const ip = '4.4.4.4';
  auth.recordRegisterFailure(ip);
  assert.equal(auth.registerRateLimitStatus(ip).locked, false); // 1 échec, seuil register à 2
  auth.recordRegisterFailure(ip);
  assert.equal(auth.registerRateLimitStatus(ip).locked, true);
  delete process.env.LOGIN_RATE_LIMIT_MAX;
  delete process.env.REGISTER_RATE_LIMIT_MAX;
});

test('login and register rate limits for the same IP never share a counter', () => {
  process.env.LOGIN_RATE_LIMIT_MAX = '1';
  process.env.REGISTER_RATE_LIMIT_MAX = '1';
  const ip = '3.3.3.3';
  auth.recordLoginFailure(ip);
  assert.equal(auth.loginRateLimitStatus(ip).locked, true);
  assert.equal(auth.registerRateLimitStatus(ip).locked, false); // pas affecté par l'échec de login
  delete process.env.LOGIN_RATE_LIMIT_MAX;
  delete process.env.REGISTER_RATE_LIMIT_MAX;
});

test('recordRegisterSuccess clears prior failures for that IP', () => {
  process.env.REGISTER_RATE_LIMIT_MAX = '1';
  const ip = '2.2.2.2';
  auth.recordRegisterFailure(ip);
  auth.recordRegisterSuccess(ip);
  assert.equal(auth.registerRateLimitStatus(ip).locked, false);
  delete process.env.REGISTER_RATE_LIMIT_MAX;
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

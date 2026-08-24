import test from 'node:test';
import assert from 'node:assert/strict';
import { safeNextPath } from '../src/safe-redirect.js';

test('safeNextPath accepts a plain relative path', () => {
  assert.equal(safeNextPath('/EVA-Debrief/'), '/EVA-Debrief/');
  assert.equal(safeNextPath('/'), '/');
  assert.equal(safeNextPath('/some/path?x=1'), '/some/path?x=1');
});

test('safeNextPath rejects an absolute URL to another origin (open redirect)', () => {
  assert.equal(safeNextPath('https://site-malveillant.example/phishing'), null);
  assert.equal(safeNextPath('http://evil.example'), null);
});

test('safeNextPath rejects a protocol-relative URL (still points to another host)', () => {
  assert.equal(safeNextPath('//evil.example/'), null);
});

test('safeNextPath rejects a javascript: URI (DOM XSS via location.href assignment)', () => {
  assert.equal(safeNextPath('javascript:alert(document.cookie)'), null);
  assert.equal(safeNextPath('data:text/html,<script>alert(1)</script>'), null);
});

test('safeNextPath rejects a backslash-containing path (browser backslash/slash confusion bypass)', () => {
  assert.equal(safeNextPath('/\\evil.example'), null);
  assert.equal(safeNextPath('\\\\evil.example'), null);
});

test('safeNextPath rejects empty, missing, or non-string input', () => {
  assert.equal(safeNextPath(''), null);
  assert.equal(safeNextPath(null), null);
  assert.equal(safeNextPath(undefined), null);
});

// logger.js patches console.log/warn/error at require() time — LOG_DIR/LOG_FILE must point at
// an isolated temp directory BEFORE requiring it, same isolation requirement as db.js/server.js
// (see db.test.js/server.test.js) so this suite never writes into the real repo's logs/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-debrief-logger-test-'));
process.env.LOG_DIR = tmpDir;
process.env.LOG_FILE = 'test.log';

const { LOG_FILE } = require('../logger');

test('console.log still prints normally AND also lands in the log file, timestamped and leveled', async () => {
  console.log('hello from a test');
  // stream.write() flushes asynchronously — same reasoning as the debounce test in db.test.js,
  // a short real wait is simpler here than plumbing a callback through console.log itself.
  await new Promise(resolve => setTimeout(resolve, 50));
  const content = fs.readFileSync(LOG_FILE, 'utf-8');
  assert.match(content, /\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[LOG\] hello from a test/);
});

test('console.error serializes a non-string argument (e.g. an object) instead of printing "[object Object]"', async () => {
  console.error('failed:', { code: 42 });
  await new Promise(resolve => setTimeout(resolve, 50));
  const content = fs.readFileSync(LOG_FILE, 'utf-8');
  assert.match(content, /\[ERROR\] failed: \{"code":42\}/);
});

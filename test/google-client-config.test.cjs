'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadDesktopClientSecret } = require('../src/desktop/google-client-config.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-client-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'google-desktop-client.json');
  return { dir, write: value => fs.writeFileSync(file, JSON.stringify(value)) };
}

test('Desktop client secret is optional and loads only matching installed credentials', t => {
  const f = fixture(t);
  assert.equal(loadDesktopClientSecret(f.dir, 'desktop-id'), '');
  f.write({ installed: { client_id: 'desktop-id', client_secret: 'local-test-secret' } });
  assert.equal(loadDesktopClientSecret(f.dir, 'desktop-id'), 'local-test-secret');
  for (const value of [
    { web: { client_id: 'desktop-id', client_secret: 'local-test-secret' } },
    { installed: { client_id: 'different-id', client_secret: 'local-test-secret' } },
    { installed: { client_id: 'desktop-id', client_secret: '' } }
  ]) {
    f.write(value);
    assert.throws(() => loadDesktopClientSecret(f.dir, 'desktop-id'), error => {
      assert.equal(error.message.includes('local-test-secret'), false);
      return true;
    });
  }
});

test('malformed and oversized local credentials fail without echoing file contents', t => {
  const f = fixture(t);
  const file = path.join(f.dir, 'google-desktop-client.json');
  for (const content of ['private-malformed-content', 'private'.repeat(10000)]) {
    fs.writeFileSync(file, content);
    assert.throws(() => loadDesktopClientSecret(f.dir, 'desktop-id'), error => {
      assert.match(error.message, /認証情報JSONを読み込めません/);
      assert.equal(error.message.includes('private'), false);
      return true;
    });
  }
});

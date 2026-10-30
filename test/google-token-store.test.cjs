'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createGoogleTokenStore } = require('../src/desktop/google-token-store.cjs');

const sample = { clientId: 'test-desktop.apps.googleusercontent.com', refreshToken: 'secret-refresh-token',
  identity: { sub: 'account-1', email: 'person@example.test' }, scope: 'https://www.googleapis.com/auth/drive.appdata openid email' };
function encryptedStorage() {
  const key = crypto.randomBytes(32);
  const storage = {
    async isAsyncEncryptionAvailable() { return true; },
    getSelectedStorageBackend() { return 'gnome_libsecret'; },
    async encryptStringAsync(text) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    async decryptStringAsync(bytes) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return { result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'), shouldReEncrypt: false };
    }
  };
  return storage;
}
async function fixture(t, options = {}) {
  const parent = path.resolve(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(parent, 'michi-google-token-store-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)), parent);
    assert.ok(path.basename(dir).startsWith('michi-google-token-store-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const safeStorage = options.safeStorage || encryptedStorage();
  const store = createGoogleTokenStore({ userData: dir, safeStorage, platform: 'win32', ...options });
  return { store, safeStorage, dir, file: path.join(dir, 'google-refresh-token.enc') };
}
async function assertSafeFailure(promise) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'GOOGLE_TOKEN_STORE_ERROR');
    assert.doesNotMatch(error.message, /secret|person@example|account-1/);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('refresh credentials round-trip through encrypted disk bytes and clear only owned files', async t => {
  const f = await fixture(t);
  assert.equal(await f.store.load(), null);
  await f.store.save({ ...sample, accessToken: 'must-not-persist' });
  const bytes = await fs.readFile(f.file);
  assert.equal(bytes.includes(Buffer.from(sample.refreshToken)), false);
  assert.equal(bytes.includes(Buffer.from(sample.identity.email)), false);
  assert.equal(bytes.includes(Buffer.from('must-not-persist')), false);
  assert.deepEqual(await f.store.load(), sample);
  const restarted = createGoogleTokenStore({ userData: f.dir, safeStorage: f.safeStorage, platform: 'win32' });
  assert.deepEqual(await restarted.load(), sample);
  const tasks = path.join(f.dir, 'operations.json');
  await fs.writeFile(tasks, 'keep-tasks');
  await fs.writeFile(f.file + '.tmp', 'stale-ciphertext');
  await restarted.clear();
  assert.equal(await restarted.load(), null);
  assert.deepEqual(await fs.readdir(f.dir), ['operations.json']);
  assert.equal(await fs.readFile(tasks, 'utf8'), 'keep-tasks');
});

test('invalid records and malformed or oversized encrypted files never expose contents', async t => {
  const f = await fixture(t);
  for (const record of [null, [], {}, { ...sample, refreshToken: '' }, { ...sample, refreshToken: 'secret'.repeat(3000) },
    { ...sample, clientId: 'bad-id' }, { ...sample, identity: { sub: 'account-1', email: 'secret-invalid-email' } }])
    await assertSafeFailure(f.store.save(record));
  assert.deepEqual(await fs.readdir(f.dir), []);
  for (const content of [Buffer.from('secret-bad-ciphertext'), Buffer.alloc(65537)]) {
    await fs.writeFile(f.file, content);
    await assertSafeFailure(f.store.load());
  }
  for (const plaintext of ['secret-not-json', JSON.stringify({ version: 2, ...sample }), JSON.stringify({ version: 1, ...sample, refreshToken: 42 })]) {
    await fs.writeFile(f.file, await f.safeStorage.encryptStringAsync(plaintext));
    await assertSafeFailure(f.store.load());
  }
});

test('unavailable encryption and Linux plaintext fallback cannot write credentials', async t => {
  for (const options of [
    { safeStorage: {} },
    { safeStorage: { ...encryptedStorage(), isAsyncEncryptionAvailable: async () => false } },
    { platform: 'linux', safeStorage: { ...encryptedStorage(), getSelectedStorageBackend: () => 'basic_text' } },
    { platform: 'linux', safeStorage: { ...encryptedStorage(), getSelectedStorageBackend: () => 'unknown' } }
  ]) {
    const f = await fixture(t, options);
    assert.equal(await f.store.load(), null);
    await assertSafeFailure(f.store.save(sample));
    assert.deepEqual(await fs.readdir(f.dir), []);
  }
});

test('clear waits for an in-flight save and failed operations do not poison the queue', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const storage = encryptedStorage(), encrypt = storage.encryptStringAsync;
  storage.encryptStringAsync = async text => { entered(); await new Promise(resolve => { release = resolve; }); return encrypt(text); };
  const f = await fixture(t, { safeStorage: storage });
  const saving = f.store.save(sample);
  await waiting;
  const clearing = f.store.clear();
  release();
  await Promise.all([saving, clearing]);
  assert.equal(await f.store.load(), null);
  assert.deepEqual(await fs.readdir(f.dir), []);
  storage.encryptStringAsync = async () => { throw Error('secret-native-error'); };
  await assertSafeFailure(f.store.save(sample));
  storage.encryptStringAsync = encrypt;
  await f.store.save(sample);
  assert.deepEqual(await f.store.load(), sample);
});

test('key rotation replaces ciphertext after validating the decrypted record', async t => {
  const f = await fixture(t);
  await f.store.save(sample);
  const before = await fs.readFile(f.file);
  const decrypt = f.safeStorage.decryptStringAsync;
  f.safeStorage.decryptStringAsync = async bytes => ({ ...await decrypt(bytes), shouldReEncrypt: true });
  assert.deepEqual(await f.store.load(), sample);
  const after = await fs.readFile(f.file);
  assert.notDeepEqual(after, before);
  assert.equal(after.includes(Buffer.from(sample.refreshToken)), false);
  assert.deepEqual(JSON.parse((await decrypt(after)).result), { version: 1, ...sample });
});

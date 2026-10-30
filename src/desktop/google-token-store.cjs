'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_PLAINTEXT = 32 * 1024;
const MAX_CIPHERTEXT = 64 * 1024;
function storageError() {
  return Object.assign(new Error('Googleログイン情報を安全に保存・読み込みできません。PCの保護された保存領域を確認してください。'),
    { code: 'GOOGLE_TOKEN_STORE_ERROR' });
}
function boundedString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function validateRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !boundedString(value.clientId, 256) || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value.clientId) ||
      !boundedString(value.refreshToken, 16384) || !boundedString(value.scope, 4096) ||
      !value.identity || typeof value.identity !== 'object' || Array.isArray(value.identity) ||
      !boundedString(value.identity.sub, 255) || !boundedString(value.identity.email, 320) || !value.identity.email.includes('@'))
    throw storageError();
  return { clientId: value.clientId, refreshToken: value.refreshToken,
    identity: { sub: value.identity.sub, email: value.identity.email }, scope: value.scope };
}

// This module belongs to Electron's main process. Only encrypted bytes reach disk.
function createGoogleTokenStore({ userData, safeStorage, platform = process.platform }) {
  if (typeof userData !== 'string' || !path.isAbsolute(userData)) throw storageError();
  const directory = path.resolve(userData);
  const file = path.join(directory, 'google-refresh-token.enc');
  const temporary = file + '.tmp';
  let queue = Promise.resolve();
  function enqueue(operation) {
    const result = queue.then(operation).catch(() => { throw storageError(); });
    queue = result.catch(() => {});
    return result;
  }
  async function encryptionAvailable() {
    if (typeof safeStorage?.isAsyncEncryptionAvailable !== 'function' ||
        typeof safeStorage?.encryptStringAsync !== 'function' ||
        typeof safeStorage?.decryptStringAsync !== 'function' ||
        await safeStorage.isAsyncEncryptionAvailable() !== true) throw storageError();
    if (platform === 'linux') {
      const backend = safeStorage.getSelectedStorageBackend?.();
      if (!backend || backend === 'basic_text' || backend === 'unknown') throw storageError();
    }
  }
  async function unlinkOwned(target) {
    try { await fs.unlink(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function writeEncrypted(record) {
    const plaintext = JSON.stringify({ version: 1, ...record });
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT) throw storageError();
    const encrypted = await safeStorage.encryptStringAsync(plaintext);
    if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_CIPHERTEXT) throw storageError();
    await fs.mkdir(directory, { recursive: true });
    // Remove only this store's stale temporary file before exclusive creation.
    await unlinkOwned(temporary);
    try {
      await fs.writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
    } catch (error) {
      await unlinkOwned(temporary).catch(() => {});
      throw error;
    }
  }
  function load() {
    return enqueue(async () => {
      let stat;
      try { stat = await fs.stat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CIPHERTEXT) throw storageError();
      await encryptionAvailable();
      const encrypted = await fs.readFile(file);
      if (!encrypted.length || encrypted.length > MAX_CIPHERTEXT) throw storageError();
      const decrypted = await safeStorage.decryptStringAsync(encrypted);
      if (typeof decrypted?.result !== 'string' || Buffer.byteLength(decrypted.result, 'utf8') > MAX_PLAINTEXT)
        throw storageError();
      const payload = JSON.parse(decrypted.result);
      if (payload?.version !== 1) throw storageError();
      const record = validateRecord(payload);
      if (decrypted.shouldReEncrypt === true) await writeEncrypted(record);
      return record;
    });
  }
  function save(value) {
    // Snapshot the accepted fields before waiting behind an in-flight operation.
    let record;
    try { record = validateRecord(value); } catch (_) { return Promise.reject(storageError()); }
    return enqueue(async () => {
      await encryptionAvailable();
      await writeEncrypted(record);
    });
  }
  function clear() {
    return enqueue(async () => {
      const results = await Promise.allSettled([unlinkOwned(file), unlinkOwned(temporary)]);
      if (results.some(result => result.status === 'rejected')) throw storageError();
    });
  }
  return { load, save, clear };
}

module.exports = { createGoogleTokenStore };

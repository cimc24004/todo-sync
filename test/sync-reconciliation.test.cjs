'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { validateCache } = require('../src/desktop/cache.cjs');

const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const base = { id: 'op-base', taskId: 'task-one', device: 'pc', clock: 1,
  patch: { title: 'Earlier PC task', done: false, deletedAt: null, priority: 'normal' } };
const latest = { id: 'op-latest', taskId: base.taskId, device: 'pc', clock: 2,
  patch: { title: 'Latest PC task', done: true } };

class FakeDrive {
  constructor(entries = [['file-base', base]]) {
    this.files = new Map(entries.map(([id, op]) => [id, clone(op)]));
    this.requests = [];
    this.uploads = [];
    this.beforeUpload = null;
    this.listResponse = null;
    this.nextId = 1;
  }
  async fetch(url, options = {}) {
    const parsed = new URL(url);
    if (options.method === 'POST') {
      assert.equal(parsed.pathname, '/upload/drive/v3/files');
      const boundary = options.headers['Content-Type'].split('boundary=')[1];
      const parts = options.body.split(`--${boundary}`);
      const readPart = part => JSON.parse(part.slice(part.indexOf('\r\n\r\n') + 4, -2));
      const metadata = readPart(parts[1]), op = readPart(parts[2]);
      assert.equal(metadata.name, `michi-op-${op.id}.json`);
      assert.deepEqual(metadata.parents, ['appDataFolder']);
      this.requests.push({ kind: 'upload', op: clone(op) });
      if (this.beforeUpload) {
        const response = await this.beforeUpload(op);
        if (response) return response;
      }
      const id = `uploaded-${this.nextId++}`;
      this.files.set(id, clone(op));
      this.uploads.push(clone(op));
      return json({ id });
    }
    if (parsed.searchParams.get('alt') === 'media') {
      const id = decodeURIComponent(parsed.pathname.split('/').at(-1));
      this.requests.push({ kind: 'read', id });
      const op = this.files.get(id);
      return json(op || { error: 'missing' }, op ? 200 : 404);
    }
    assert.equal(parsed.pathname, '/drive/v3/files');
    this.requests.push({ kind: 'list' });
    if (this.listResponse) return this.listResponse(parsed);
    return json({ incompleteSearch: false, files: [...this.files].map(([id, op]) => ({ id, name: `michi-op-${op.id}.json` })) });
  }
}

function client(drive, { desktop = false, seed = null } = {}) {
  let cache = clone(seed), state;
  const saves = [], listeners = new Map(), deadlines = [];
  const listen = (type, callback) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(callback);
  };
  const dispatch = event => {
    for (const callback of listeners.get(event.type) || []) callback(event);
    return true;
  };
  const w = {
    MICHI_CONFIG: { googleWebClientId: 'test.apps.googleusercontent.com' },
    crypto: webcrypto, URL, URLSearchParams, Response, Event, CustomEvent, AbortController,
    AbortSignal: { any: AbortSignal.any, timeout(ms) {
      const controller = new AbortController(); deadlines.push({ ms, controller }); return controller.signal;
    } },
    navigator: { locks: { request: (name, options, callback) => callback({ name }) } },
    document: { visibilityState: 'visible', hidden: false, addEventListener: listen },
    localStorage: {
      getItem: () => cache == null ? null : JSON.stringify(cache),
      setItem: (key, value) => { cache = JSON.parse(value); saves.push(clone(cache)); }
    },
    confirm: () => true, setTimeout: () => 1, clearTimeout() {}, setInterval() {},
    addEventListener: listen, dispatchEvent: dispatch,
    google: { accounts: { oauth2: { initTokenClient: options => ({ requestAccessToken() {
      options.callback({ access_token: 'test-token', expires_in: 3600 });
    } }) } } },
    async fetch(url, options) {
      return url.includes('/userinfo') ? json({ sub: 'same-account' }) : drive.fetch(url, options);
    }
  };
  if (desktop) w.todo = {
    async request(action, next) {
      if (action === 'cache-load') return { ok: true, data: clone(cache) };
      assert.equal(action, 'cache-save');
      cache = validateCache(clone(next)); saves.push(clone(cache)); return { ok: true };
    },
    async driveAuth(action) {
      return { ok: true, data: { connected: action !== 'disconnect', identity: { sub: 'same-account' } } };
    },
    async driveRequest({ url, options, account }) {
      assert.equal(account, 'same-account');
      const response = await drive.fetch(url, options);
      return { ok: true, data: { status: response.status, text: await response.text() } };
    }
  };
  w.window = w;
  listen('michi-sync-state', event => { state = clone(event.detail); });
  const context = vm.createContext(w);
  for (const file of ['sync-core.js', 'drive-sync.js', 'data-adapter.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  return { w, saves, deadlines, get cache() { return clone(cache); }, get state() { return state; },
    async tasks() { const result = await w.todoClient.request('list'); assert.equal(result.ok, true); return clone(result.data.tasks); } };
}

function pcCache(ops = [base, latest]) {
  return { device: 'pc', account: 'same-account', ops: clone(ops), pending: [], knownFiles: ['file-base', 'file-missing-latest'] };
}
function assertSynced(c) {
  assert.equal(c.state.connected, true);
  assert.equal(c.state.syncing, false);
  assert.equal(c.state.pending, 0);
  assert.equal(c.state.error, '');
  assert.ok(c.state.lastSync > 0);
}

test('missing acknowledged PC edit is restored to Drive and reaches a fresh phone', async () => {
  const drive = new FakeDrive(), pc = client(drive, { desktop: true, seed: pcCache() });
  drive.beforeUpload = op => {
    assert.equal(op.id, latest.id);
    assert.ok(pc.cache.pending.includes(latest.id), 'repair queue must be saved before upload');
  };
  await pc.w.todoClient.connect();
  assert.deepEqual(drive.uploads, [latest]);
  assertSynced(pc);
  assert.ok(pc.cache.verifiedFiles.some(file => file.opId === latest.id));
  const phone = client(drive);
  await phone.w.todoClient.connect();
  assertSynced(phone);
  assert.deepEqual(await phone.tasks(), await pc.tasks());
  assert.equal((await phone.tasks())[0].title, latest.patch.title);
  assert.equal((await phone.tasks())[0].done, true);
});

test('repair replays the missing tombstone without reviving a deleted task', async () => {
  const deleted = { id: 'op-deleted', taskId: base.taskId, device: 'pc', clock: 3,
    patch: { deletedAt: '2026-11-14T02:00:00Z' } };
  const drive = new FakeDrive([['file-base', base], ['file-edit', latest]]);
  const pc = client(drive, { desktop: true, seed: pcCache([base, latest, deleted]) });
  await pc.w.todoClient.connect();
  assert.deepEqual(drive.uploads, [deleted]);
  const phone = client(drive);
  await phone.w.todoClient.connect();
  assert.equal((await phone.tasks())[0].deletedAt, deleted.patch.deletedAt);
  assert.deepEqual(await phone.tasks(), await pc.tasks());
});

test('verified inventory and upload receipts avoid repeated reads and duplicate repair uploads', async () => {
  const drive = new FakeDrive(), pc = client(drive, { desktop: true, seed: pcCache() });
  await pc.w.todoClient.connect();
  const afterFirst = drive.requests.length;
  await pc.w.todoClient.sync();
  assert.deepEqual(drive.requests.slice(afterFirst), [{ kind: 'list' }]);
  assert.deepEqual(drive.uploads, [latest]);
  const reloaded = client(drive, { desktop: true, seed: pc.cache });
  const afterReload = drive.requests.length;
  await reloaded.w.todoClient.connect();
  assert.deepEqual(drive.requests.slice(afterReload), [{ kind: 'list' }]);
  assertSynced(reloaded);
});

test('an operation remains present while any verified duplicate Drive file survives', async () => {
  const drive = new FakeDrive([['file-base', base], ['file-one', latest], ['file-two', latest]]);
  const pc = client(drive, { desktop: true, seed: pcCache() });
  await pc.w.todoClient.connect();
  assert.equal(pc.cache.verifiedFiles.filter(file => file.opId === latest.id).length, 2);
  drive.files.delete('file-one');
  const before = drive.requests.length;
  await pc.w.todoClient.sync();
  assert.deepEqual(drive.requests.slice(before), [{ kind: 'list' }]);
  assert.deepEqual(drive.uploads, []);
  assert.equal(pc.cache.verifiedFiles.some(file => file.fileId === 'file-one'), false);
  assertSynced(pc);
});

test('an acknowledged file disappearing after a successful sync is repaired from verified cache', async () => {
  const drive = new FakeDrive([['file-base', base], ['file-latest', latest]]);
  const seed = { ...pcCache(), knownFiles: ['file-base', 'file-latest'], verifiedFiles: [
    { fileId: 'file-base', opId: base.id }, { fileId: 'file-latest', opId: latest.id }
  ] };
  const pc = client(drive, { desktop: true, seed });
  await pc.w.todoClient.connect();
  assert.deepEqual(drive.requests, [{ kind: 'list' }]);
  drive.files.delete('file-latest');
  await pc.w.todoClient.sync();
  assert.deepEqual(drive.uploads, [latest]);
  assert.equal(pc.cache.verifiedFiles.some(file => file.fileId === 'file-latest'), false);
  assertSynced(pc);
  const phone = client(drive, { seed: { device: 'phone', account: 'same-account', ops: [base], pending: [],
    knownFiles: ['file-base'], verifiedFiles: [{ fileId: 'file-base', opId: base.id }] } });
  await phone.w.todoClient.connect();
  assert.deepEqual(await phone.tasks(), await pc.tasks());
});

test('incomplete or malformed inventory cannot trigger repair writes or report success', async t => {
  for (const response of [{ incompleteSearch: true, files: [] }, { files: 'not-an-array' }, { files: [{ id: 'file-base', name: 'wrong-name.json' }] }]) {
    await t.test(JSON.stringify(response), async () => {
      const drive = new FakeDrive(); drive.listResponse = () => json(response);
      const seed = pcCache(), pc = client(drive, { desktop: true, seed });
      await assert.rejects(pc.w.todoClient.connect());
      assert.equal(pc.state.lastSync, 0);
      assert.equal(pc.state.syncing, false);
      assert.deepEqual(pc.cache, seed);
      assert.equal(drive.requests.some(request => request.kind === 'upload'), false);
    });
  }
});

test('failed repair upload retains pending operation and succeeds on retry', async () => {
  const drive = new FakeDrive(), pc = client(drive, { desktop: true, seed: pcCache() });
  drive.beforeUpload = () => json({ error: 'temporarily unavailable' }, 503);
  await assert.rejects(pc.w.todoClient.connect(), /503/);
  assert.deepEqual(pc.cache.pending, [latest.id]);
  assert.equal(pc.state.lastSync, 0);
  assert.equal(pc.cache.ops.length, 2);
  drive.beforeUpload = null;
  await pc.w.todoClient.sync();
  assert.deepEqual(drive.uploads, [latest]);
  assertSynced(pc);
});

test('disconnect during repair preserves its queue and ignores a late upload result', async () => {
  let finishUpload;
  const drive = new FakeDrive(), pc = client(drive, { desktop: true, seed: pcCache() });
  drive.beforeUpload = () => new Promise(resolve => { finishUpload = resolve; });
  const connecting = pc.w.todoClient.connect(), cancelled = assert.rejects(connecting, /キャンセル/);
  await tick();
  assert.equal(typeof finishUpload, 'function');
  assert.deepEqual(pc.cache.pending, [latest.id]);
  await pc.w.todoClient.disconnect(); await cancelled;
  const before = pc.cache;
  finishUpload(json({ id: 'late-uploaded-file' })); await tick();
  assert.deepEqual(pc.cache, before);
  assert.equal(pc.state.connected, false);
  assert.equal(pc.state.lastSync, 0);
  assert.equal(pc.state.syncing, false);
});

test('concurrent same-field edits converge without changing operation clocks during repair', async () => {
  const concurrent = { ...latest, id: 'op-phone', device: 'phone', patch: { title: 'Phone concurrent edit' } };
  const drive = new FakeDrive([['file-base', base], ['file-phone', concurrent]]);
  const pc = client(drive, { desktop: true, seed: pcCache() }), phone = client(drive);
  await pc.w.todoClient.connect(); await phone.w.todoClient.connect();
  assert.deepEqual(drive.uploads, [latest]);
  assert.deepEqual(await phone.tasks(), await pc.tasks());
  assert.equal(pc.cache.ops.find(op => op.id === latest.id).clock, latest.clock);
  assert.equal(pc.cache.ops.find(op => op.id === concurrent.id).clock, concurrent.clock);
});

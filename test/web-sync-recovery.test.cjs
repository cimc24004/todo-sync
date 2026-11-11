'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const tick = () => new Promise(resolve => setImmediate(resolve));
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const cacheKey = 'michi-todo-operations-v1';
function setup(handle) {
  const storage = new Map(), listeners = new Map(), deadlines = [], requests = [], states = [];
  const w = {
    MICHI_CONFIG: { googleWebClientId: 'test-client' }, crypto: webcrypto,
    URLSearchParams, Response, Event, CustomEvent, AbortController,
    AbortSignal: { any: AbortSignal.any, timeout(ms) {
      const controller = new AbortController(); deadlines.push({ ms, controller }); return controller.signal;
    } },
    navigator: { locks: { request: (name, options, callback) => callback({ name }) } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    confirm: () => true, setTimeout: () => 1, clearTimeout() {}, setInterval() {},
    google: { accounts: { oauth2: { initTokenClient: options => ({ requestAccessToken() {
      options.callback({ access_token: 'test-token', expires_in: 3600 });
    } }) } } },
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); },
    dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); return true; },
    async fetch(url, options) {
      requests.push({ url, options });
      if (url.includes('/userinfo')) return json({ sub: 'account-a' });
      return handle(url, options);
    }
  };
  w.window = w;
  w.addEventListener('michi-sync-state', event => states.push(event.detail));
  const context = vm.createContext(w);
  for (const file of ['sync-core.js', 'drive-sync.js', 'data-adapter.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  return { w, states, requests, deadlines,
    get state() { return states.at(-1); }, get cache() { return JSON.parse(storage.get(cacheKey)); },
    expire() { const deadline = deadlines.at(-1); assert.equal(deadline.ms, 30000); deadline.controller.abort(); }
  };
}

test('stalled Web Drive list exits syncing after 30 seconds and can retry', async () => {
  let stalled = true;
  const f = setup(() => stalled ? new Promise(() => {}) : json({ files: [] }));
  const connecting = f.w.todoClient.connect();
  const failed = assert.rejects(connecting, /タイムアウト/);
  await tick(); assert.equal(f.state.syncing, true);
  assert.match(f.state.progress, /一覧/);
  f.expire(); await failed;
  assert.equal(f.state.syncing, false);
  assert.equal(f.state.lastSync, 0);
  stalled = false;
  await f.w.todoClient.sync();
  assert.ok(f.state.lastSync > 0);
});

test('stalled upload body preserves the pending task and never reports success', async () => {
  let stalled = true;
  const f = setup((url, options) => options.method === 'POST'
    ? stalled ? { status: 200, text: () => new Promise(() => {}) } : json({ id: 'uploaded-file' })
    : json({ files: [] }));
  await f.w.todoClient.request('add', { title: 'keep my task', priority: 'normal' });
  const connecting = f.w.todoClient.connect(), failed = assert.rejects(connecting, /タイムアウト/);
  await tick(); assert.match(f.state.progress, /送信/);
  f.expire(); await failed;
  assert.equal(f.cache.pending.length, 1);
  assert.equal(f.cache.ops[0].patch.title, 'keep my task');
  assert.equal(f.state.lastSync, 0);
  assert.equal(f.state.syncing, false);
  stalled = false; await f.w.todoClient.sync();
  assert.equal(f.cache.pending.length, 0);
});

test('disconnect cancels a stalled Web read, restores local edits and ignores its late response', async () => {
  let finishRead, stalled = true;
  const f = setup(() => stalled ? new Promise(resolve => { finishRead = resolve; }) : json({ files: [] }));
  const connecting = f.w.todoClient.connect(), cancelled = assert.rejects(connecting, /キャンセル/);
  await tick(); const signal = f.requests.at(-1).options.signal;
  await f.w.todoClient.disconnect(); await cancelled;
  assert.equal(signal.aborted, true);
  assert.equal(f.state.connected, false);
  assert.equal(f.state.syncing, false);
  assert.equal((await f.w.todoClient.request('add', { title: 'offline edit', priority: 'normal' })).ok, true);
  const before = JSON.stringify(f.cache);
  finishRead(json({ files: [{ id: 'late-file' }] })); await tick();
  assert.equal(JSON.stringify(f.cache), before);
  assert.equal(f.state.lastSync, 0);
  stalled = false; await f.w.todoClient.connect();
  assert.equal(f.state.connected, true);
  assert.equal(f.cache.pending.length, 0);
});

test('Web 401 preserves pending data and enables a fresh Google connection', async () => {
  let expired = true;
  const f = setup((url, options) => expired ? json({}, 401) : json(options.method === 'POST' ? { id: 'saved' } : { files: [] }));
  await f.w.todoClient.request('add', { title: 'pending', priority: 'normal' });
  await assert.rejects(f.w.todoClient.connect(), /再接続/);
  assert.equal(f.state.connected, false);
  assert.equal(f.state.syncing, false);
  assert.equal(f.cache.pending.length, 1);
  expired = false; await f.w.todoClient.connect();
  assert.equal(f.state.connected, true);
  assert.equal(f.cache.pending.length, 0);
});

test('initial Web download reports completed counts and caches only verified files', async () => {
  const op = { id: 'op-1', taskId: 'task-1', device: 'other-device', clock: 1,
    patch: { title: 'remote task', priority: 'normal' } };
  const f = setup(url => url.includes('?alt=media') ? json(op) : json({ files: [{ id: 'file-1' }] }));
  await f.w.todoClient.connect();
  assert.ok(f.states.some(state => state.progress === '同期中…（受信 1/1）'));
  assert.deepEqual(f.cache.knownFiles, ['file-1']);
  assert.equal(f.cache.ops[0].patch.title, 'remote task');
});

test('stalled account identity body is bounded and can reconnect without reloading', async () => {
  const f = setup(() => json({ files: [] }));
  const originalFetch = f.w.fetch;
  f.w.fetch = async () => ({ ok: true, json: () => new Promise(() => {}) });
  const connecting = f.w.todoClient.connect(), failed = assert.rejects(connecting, /タイムアウト/);
  await tick(); f.expire(); await failed;
  assert.equal(f.state.connected, false);
  f.w.fetch = originalFetch; await f.w.todoClient.connect();
  assert.ok(f.state.lastSync > 0);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const tick = () => new Promise(resolve => setImmediate(resolve));
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const operation = { id: 'op-1', taskId: 'task-1', device: 'web-1', clock: 1, patch: { title: '未同期のタスク' } };

function setup({ fetch, todo, legacy = false } = {}) {
  const deadlines = [], requests = [], timers = new Map();
  let nextTimer = 0;
  const w = {
    URLSearchParams, Response, AbortController, crypto: webcrypto,
    AbortSignal: legacy ? {} : {
      timeout(ms) { const controller = new AbortController(); deadlines.push({ ms, controller }); return controller.signal; },
      any: signals => AbortSignal.any(signals)
    },
    setTimeout(callback, ms) { const id = ++nextTimer; timers.set(id, callback); deadlines.push({ ms, fire: callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, options) { requests.push({ url, options }); return fetch ? fetch(url, options) : Promise.resolve(json({ files: [] })); },
    todo
  };
  w.window = w;
  const context = vm.createContext(w);
  for (const name of ['sync-core.js', 'drive-sync.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', name), 'utf8'), context);
  return { w, deadlines, requests, timers, drive: signal => new w.MichiDrive(() => 'memory-only-token', () => 'account-a', () => signal) };
}

test('static Drive request times out while waiting for headers and aborts its fetch', async () => {
  const f = setup({ fetch: () => new Promise(() => {}) });
  const pending = f.drive().list();
  const rejected = assert.rejects(pending, error => error.code === 'NETWORK_TIMEOUT' && /ローカルの変更は保持/.test(error.message));
  await tick();
  assert.equal(f.deadlines[0].ms, 30000);
  f.deadlines[0].controller.abort();
  await rejected;
  assert.equal(f.requests[0].options.signal.aborted, true);
});

test('static Drive deadline also covers a stalled response body', async () => {
  let readingBody = false;
  const f = setup({ fetch: async () => ({ status: 200, text() { readingBody = true; return new Promise(() => {}); } }) });
  const pending = f.drive().list();
  const rejected = assert.rejects(pending, { code: 'NETWORK_TIMEOUT' });
  await tick();
  assert.equal(readingBody, true);
  f.deadlines[0].controller.abort();
  await rejected;
});

test('upload acknowledgement timeout rejects and a subsequent attempt can succeed', async () => {
  let attempt = 0;
  const f = setup({ fetch: async () => ++attempt === 1
    ? { status: 200, text: () => new Promise(() => {}) }
    : json({ id: 'saved-file' }) });
  const drive = f.drive();
  const pending = drive.push(operation);
  const rejected = assert.rejects(pending, { code: 'NETWORK_TIMEOUT' });
  await tick(); f.deadlines[0].controller.abort(); await rejected;
  assert.equal((await drive.push(operation)).id, 'saved-file');
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].options.method, 'POST');
});

test('disconnect aborts a pending read and late response cannot start another download', async () => {
  const controller = new AbortController();
  let finish;
  const f = setup({ fetch: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.drive(controller.signal).pull([{ id: 'first' }, { id: 'second' }]);
  const rejected = assert.rejects(pending, { code: 'NETWORK_CANCELLED' });
  await tick(); controller.abort(); await rejected;
  finish(json(operation)); await tick();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].options.signal.aborted, true);
});

test('an already cancelled sync never sends a Drive request', async () => {
  const f = setup(), controller = new AbortController();
  controller.abort();
  await assert.rejects(f.drive(controller.signal).list(), { code: 'NETWORK_CANCELLED' });
  assert.equal(f.requests.length, 0);
});

test('static Drive 401 marks the session as requiring reconnection', async () => {
  const f = setup({ fetch: async () => new Response('{}', { status: 401 }) });
  await assert.rejects(f.drive().list(), error => error.authRequired === true && /再接続/.test(error.message));
});

test('Desktop IPC request timeout does not pass a non-serializable AbortSignal to main', async () => {
  let input;
  const f = setup({ todo: { driveRequest: request => { input = request; return new Promise(() => {}); } } });
  const pending = f.drive().list();
  const rejected = assert.rejects(pending, { code: 'NETWORK_TIMEOUT' });
  await tick();
  assert.equal(input.account, 'account-a');
  assert.equal(input.options.signal, undefined);
  assert.equal(f.deadlines[0].ms, 45000);
  f.deadlines[0].controller.abort(); await rejected;
});

test('server logout waits for a pending body or its deadline before deleting the cookie', async () => {
  const f = setup({ fetch: async url => url.endsWith('session')
    ? { status: 200, text: () => new Promise(() => {}) }
    : json({ ok: true }) });
  const pending = f.w.MichiServerAuth.request('session');
  const rejected = assert.rejects(pending, { code: 'NETWORK_TIMEOUT' });
  await tick();
  const disconnecting = f.w.MichiServerAuth.disconnect();
  await tick();
  assert.equal(f.requests.length, 1);
  assert.equal(f.deadlines[0].ms, 45000);
  f.deadlines[0].controller.abort();
  await rejected; await disconnecting;
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[1].url, /action=disconnect$/);
  assert.equal(f.requests[1].options.credentials, 'same-origin');
});

test('timeout and cancellation work when AbortSignal.timeout and any are unavailable', async () => {
  const f = setup({ legacy: true, fetch: () => new Promise(() => {}) });
  const controller = new AbortController();
  const first = f.drive(controller.signal).list();
  const firstRejected = assert.rejects(first, { code: 'NETWORK_TIMEOUT' });
  await tick(); f.deadlines[0].fire(); await firstRejected;
  assert.equal(f.requests[0].options.signal.aborted, true);
  assert.equal(f.timers.size, 0);
  const second = f.drive(controller.signal).list();
  const secondRejected = assert.rejects(second, { code: 'NETWORK_CANCELLED' });
  await tick(); controller.abort(); await secondRejected;
  assert.equal(f.requests[1].options.signal.aborted, true);
  assert.equal(f.timers.size, 0);
});

test('pull reports completed files while retaining deterministic operation merging', async () => {
  const f = setup({ fetch: async () => json(operation) }), progress = [];
  const result = await f.drive().pull([{ id: 'one' }, { id: 'duplicate' }], (done, total) => progress.push([done, total]));
  assert.equal(result.length, 1);
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
});

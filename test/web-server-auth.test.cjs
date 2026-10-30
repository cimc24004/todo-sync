'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const cacheKey = 'michi-todo-operations-v1';
const session = (sub = 'account-a', expiresAt = Date.now() + 3600000) => ({
  ok: true, data: { connected: true, identity: { sub, email: 'person@example.test' }, account: 'person@example.test', expiresAt }
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function setup(t, { account = 'account-a', initialCache, sessionResult = session(), confirm = () => true, handle } = {}) {
  const storage = new Map(), listeners = new Map(), timers = new Set();
  const requests = [], navigations = [], timeoutDelays = [], intervals = [];
  let lastState, prompts = 0;
  storage.set(cacheKey, JSON.stringify(initialCache || { device: 'web-1', ops: [], pending: [], ...(account ? { account } : {}) }));
  const w = {
    MICHI_CONFIG: { googleAuthMode: 'server' }, crypto: webcrypto, URL, URLSearchParams, Response, Event, CustomEvent, AbortSignal,
    location: { assign: url => navigations.push(url) },
    navigator: { locks: { request: (name, options, callback) => callback({ name }) } },
    document: { createElement() { throw Error('Server mode must not load Google JavaScript'); } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    confirm: message => { prompts++; return confirm(message); },
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); },
    dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); return true; },
    setTimeout(callback, delay) { timeoutDelays.push(delay); const timer = setTimeout(callback, delay); timers.add(timer); return timer; },
    clearTimeout: timer => clearTimeout(timer),
    setInterval: callback => { intervals.push(callback); return intervals.length; },
    clearInterval() {},
    async fetch(url, options = {}) {
      const action = new URL(url, 'https://todo.example.test').searchParams.get('action');
      const request = { url, action, options, body: options.body ? JSON.parse(options.body) : null };
      requests.push(request);
      if (handle) { const response = await handle(request); if (response !== undefined) return response; }
      if (action === 'session') return json(sessionResult);
      if (action === 'disconnect') return json({ ok: true, data: { connected: false } });
      if (action === 'drive') {
        const result = request.body.options.method === 'POST' ? { id: 'remote-operation' } : { files: [] };
        return json({ ok: true, data: { status: 200, text: JSON.stringify(result) } });
      }
      throw Error('Unexpected fetch');
    }
  };
  w.window = w;
  w.addEventListener('michi-sync-state', event => { lastState = event.detail; });
  const context = vm.createContext(w);
  for (const file of ['sync-core.js', 'drive-sync.js', 'data-adapter.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), context);
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  return { w, requests, navigations, timeoutDelays, intervals, storage,
    get cache() { return JSON.parse(storage.get(cacheKey)); }, get state() { return lastState; }, get prompts() { return prompts; },
    get driveRequests() { return requests.filter(request => request.action === 'drive'); },
    get uploads() { return requests.filter(request => request.action === 'drive' && request.body.options.method === 'POST'); } };
}

test('server mode automatically restores a cookie session and proxies Drive requests without browser tokens', async t => {
  const f = setup(t);
  await f.w.todoClient.request('list'); await tick(); await tick();
  assert.equal(f.state.connected, true);
  assert.ok(f.state.lastSync > 0);
  assert.equal(f.prompts, 0);
  assert.equal(f.requests[0].action, 'session');
  assert.equal(f.requests[0].options.credentials, 'same-origin');
  assert.equal(f.driveRequests.length, 1);
  const request = f.driveRequests[0];
  assert.equal(request.url, '/api/google?action=drive');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.headers['X-Michi-Request'], '1');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.match(request.body.url, /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\?/);
  assert.equal(request.body.account, 'account-a');
  assert.doesNotMatch(JSON.stringify(f.requests), /server-session|Bearer|access_token|refresh_token/);
  assert.doesNotMatch(f.storage.get(cacheKey), /token|cookie|secret/i);
});

test('server mode connect navigates to the backend instead of opening the GIS token popup', async t => {
  const f = setup(t);
  await f.w.todoClient.connect();
  assert.deepEqual(f.navigations, ['/api/google?action=start']);
  assert.equal(f.requests.length, 0);
  assert.equal(f.state.connected, false);
});

test('server session confirms account binding once before uploading previously local tasks', async t => {
  let f;
  f = setup(t, { account: null, confirm: message => {
    assert.match(message, /person@example.test/);
    assert.equal(f.driveRequests.length, 0);
    return true;
  } });
  const added = await f.w.todoClient.request('add', { title: 'local task', priority: 'normal' });
  assert.equal(added.ok, true);
  await f.w.todoClient.restore();
  assert.equal(f.prompts, 1);
  assert.equal(f.cache.account, 'account-a');
  assert.equal(f.uploads.length, 1);
  assert.equal(f.cache.pending.length, 0);
  const reloaded = setup(t, { initialCache: f.cache });
  await reloaded.w.todoClient.restore();
  assert.equal(reloaded.prompts, 0);
  assert.equal(reloaded.state.connected, true);
});

test('declining server account binding clears the cookie and retains unsynced local tasks', async t => {
  const f = setup(t, { account: null, confirm: () => false });
  await f.w.todoClient.request('add', { title: 'private local task', priority: 'normal' });
  await f.w.todoClient.restore();
  assert.equal(f.driveRequests.length, 0);
  assert.equal(f.cache.account, undefined);
  assert.equal(f.cache.pending.length, 1);
  const disconnect = f.requests.find(request => request.action === 'disconnect');
  assert.equal(disconnect.options.method, 'POST');
  assert.equal(disconnect.options.credentials, 'same-origin');
  assert.equal(disconnect.options.headers['X-Michi-Request'], '1');
  assert.deepEqual(disconnect.body, {});
  const count = f.requests.length;
  f.w.dispatchEvent(new Event('focus')); await tick();
  assert.equal(f.requests.length, count);
  assert.equal(f.state.connected, false);
});

test('a different server account is rejected before Drive reads or uploads', async t => {
  const f = setup(t, { sessionResult: session('account-b') });
  await assert.rejects(f.w.todoClient.restore(), /別のGoogleアカウント/);
  assert.equal(f.cache.account, 'account-a');
  assert.equal(f.driveRequests.length, 0);
  assert.deepEqual(f.requests.map(request => request.action), ['session', 'disconnect']);
  assert.equal(f.state.connected, false);
});

test('an expired server cookie stays disconnected without navigation or popup', async t => {
  const f = setup(t, { handle: request => request.action === 'session' ? json({ ok: false, error: '再接続してください', code: 'AUTH_REQUIRED' }, 401) : undefined });
  await f.w.todoClient.restore();
  assert.equal(f.state.connected, false);
  assert.equal(f.driveRequests.length, 0);
  assert.deepEqual(f.navigations, []);
});

test('server mode lets the backend renew an expired Google access token', async t => {
  const f = setup(t, { sessionResult: session('account-a', Date.now() - 1000) });
  await f.w.todoClient.restore(); await tick();
  assert.equal(f.state.connected, true);
  assert.deepEqual(f.timeoutDelays, []);
  await f.w.todoClient.sync();
  assert.equal(f.driveRequests.length, 2);
  assert.equal(f.state.connected, true);
});

test('disconnect rejects a late server session response and prevents silent reconnect', async t => {
  let finishSession;
  const f = setup(t, { handle: request => request.action === 'session' ? new Promise(resolve => { finishSession = resolve; }) : undefined });
  const restoring = f.w.todoClient.restore();
  const rejected = assert.rejects(restoring, /キャンセル/);
  await tick(); const disconnecting=f.w.todoClient.disconnect(); await tick();
  assert.deepEqual(f.requests.map(request => request.action), ['session']);
  await assert.rejects(f.w.MichiServerAuth.request('session'), /解除しています/);
  finishSession(json(session())); await rejected; await disconnecting;
  f.w.dispatchEvent(new Event('focus')); await tick();
  assert.deepEqual(f.requests.map(request => request.action), ['session', 'disconnect']);
  assert.equal(f.driveRequests.length, 0);
  assert.equal(f.state.connected, false);
});

test('server connect waits for cookie deletion before navigating to login', async t => {
  let finishDisconnect;
  const f = setup(t, { handle: request => request.action === 'disconnect' ? new Promise(resolve => { finishDisconnect = resolve; }) : undefined });
  await f.w.todoClient.restore();
  const disconnecting = f.w.todoClient.disconnect();
  const connecting = f.w.todoClient.connect(); await tick();
  assert.deepEqual(f.navigations, []);
  finishDisconnect(json({ ok: true })); await disconnecting; await connecting;
  assert.deepEqual(f.navigations, ['/api/google?action=start']);
});

test('server startup retries temporary unavailability on focus without automatic login navigation', async t => {
  let attempts = 0;
  const f = setup(t, { handle: request => request.action === 'session' && ++attempts === 1
    ? json({ ok: false, error: '一時的に接続できません', code: 'TEMPORARY_UNAVAILABLE' }, 503) : undefined });
  await f.w.todoClient.request('list'); await tick(); await tick();
  assert.equal(f.state.connected, false);
  f.w.dispatchEvent(new Event('focus')); await tick(); await tick();
  assert.equal(f.state.connected, true);
  assert.equal(attempts, 2);
  assert.deepEqual(f.navigations, []);
});

test('server Drive authorization failure preserves pending operations and shows disconnected state', async t => {
  let expired = false;
  const f = setup(t, { handle: request => request.action === 'drive' && expired
    ? json({ ok: false, error: 'Googleへの再接続が必要です', code: 'AUTH_REQUIRED' }, 401) : undefined });
  await f.w.todoClient.restore(); expired = true;
  await f.w.todoClient.request('add', { title: 'pending task', priority: 'normal' });
  await assert.rejects(f.w.todoClient.sync(), /再接続/); await tick();
  assert.equal(f.cache.pending.length, 1);
  assert.equal(f.state.connected, false);
  assert.equal(f.state.error, 'Googleへの再接続が必要です');
  assert.equal(f.uploads.length, 0);
});

test('server Drive proxy never reads an access token from the browser', async t => {
  const f = setup(t);
  const drive = new f.w.MichiDrive(() => { throw Error('Browser token getter must not run'); },()=> 'account-a');
  await drive.list();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].action, 'drive');
  assert.equal(f.requests[0].options.headers.Authorization, undefined);
});

test('server Drive proxy refuses requests without a locally verified account', async t => {
  const f=setup(t);
  const drive=new f.w.MichiDrive(()=> 'unused');
  await assert.rejects(drive.list(),/Googleアカウントを確認/);
  assert.equal(f.requests.length,0);
});

test('server disconnect clears cookies after an in-flight Drive response and stops further uploads', async t => {
  let finishDrive, cookie='initial';
  const f = setup(t, { handle: request => {
    if(request.action==='drive')return new Promise(resolve=>{finishDrive=()=>{cookie='renewed';resolve(json({ok:true,data:{status:200,text:'{"files":[]}'}}));};});
    if(request.action==='disconnect'){cookie='';return json({ok:true});}
  } });
  await f.w.todoClient.request('add',{title:'pending task',priority:'normal'});
  const restoring=f.w.todoClient.restore();const rejected=assert.rejects(restoring,/キャンセル/);
  await tick();const disconnecting=f.w.todoClient.disconnect();await tick();
  assert.equal(f.requests.some(request=>request.action==='disconnect'),false);
  finishDrive();await rejected;await disconnecting;
  assert.equal(f.requests.at(-1).action,'disconnect');
  assert.equal(cookie,'');
  assert.equal(f.uploads.length,0);
  assert.equal(f.cache.pending.length,1);
});

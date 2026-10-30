'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const connected = (sub = 'account-a', expiresAt = Date.now() + 3600000) => ({
  ok: true, data: { connected: true, account: { sub, email: 'person@example.test' }, expiresAt }
});

function setup(t, { account = 'account-a', auth, list } = {}) {
  const dom = new JSDOM('', { runScripts: 'outside-only', url: 'https://example.test' });
  const w = dom.window;
  t.after(() => w.close());
  let cache = { device: 'desktop-1', ops: [], pending: [], ...(account ? { account } : {}) };
  let lastState, prompts = 0, reads = 0, uploads = 0;
  const authCalls = [];
  w.addEventListener('michi-sync-state', e => { lastState = e.detail; });
  w.confirm = () => { prompts++; return true; };
  w.MichiDrive = class {
    async list() { reads++; return list ? list() : []; }
    async pull() { return []; }
    async push() { uploads++; return { id: 'remote-file' }; }
  };
  w.todo = {
    async request(action, value) {
      if (action === 'cache-load') return { ok: true, data: JSON.parse(JSON.stringify(cache)) };
      if (action === 'cache-save') { cache = JSON.parse(JSON.stringify(value)); return { ok: true }; }
      throw Error('Unexpected cache action');
    },
    async driveAuth(action) {
      authCalls.push(action);
      return auth ? auth(action) : action === 'disconnect' ? { ok: true, data: { connected: false } } : connected();
    }
  };
  w.eval(fs.readFileSync(path.join(__dirname, '../src/sync-core.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(__dirname, '../src/data-adapter.js'), 'utf8'));
  return { w, authCalls, get cache() { return cache; }, get state() { return lastState; },
    get prompts() { return prompts; }, get reads() { return reads; }, get uploads() { return uploads; } };
}

test('Desktop initial list restores saved login and syncs without interactive login', async t => {
  const f = setup(t);
  const response = await f.w.todoClient.request('list');
  assert.equal(response.ok, true);
  await tick(); await tick();
  assert.deepEqual(f.authCalls, ['restore']);
  assert.equal(f.prompts, 0);
  assert.equal(f.reads, 1);
  assert.equal(f.state.connected, true);
  assert.ok(f.state.lastSync > 0);
});

test('Desktop restore with no saved credential stays offline and never asks for consent', async t => {
  const f = setup(t, { auth: async () => ({ ok: true, data: { connected: false } }) });
  await f.w.todoClient.restore();
  assert.deepEqual(f.authCalls, ['restore']);
  assert.equal(f.prompts, 0);
  assert.equal(f.reads, 0);
  assert.equal(f.state.connected, false);
});

test('Desktop silent restore never uploads an unbound local cache', async t => {
  const f = setup(t, { account: null });
  const added = await f.w.todoClient.request('add', { title: 'local task', priority: 'normal' });
  assert.equal(added.ok, true);
  await f.w.todoClient.restore();
  assert.deepEqual(f.authCalls, []);
  assert.equal(f.prompts, 0);
  assert.equal(f.reads, 0);
  assert.equal(f.uploads, 0);
  assert.equal(f.cache.pending.length, 1);
});

test('Desktop restore rejects a different account before reading or uploading Drive data', async t => {
  const f = setup(t, { auth: async action => action === 'restore' ? connected('account-b') : { ok: true } });
  await assert.rejects(f.w.todoClient.restore(), /別のGoogleアカウント/);
  assert.deepEqual(f.authCalls, ['restore', 'disconnect']);
  assert.equal(f.reads, 0);
  assert.equal(f.uploads, 0);
  assert.equal(f.cache.account, 'account-a');
  assert.equal(f.state.connected, false);
  f.w.dispatchEvent(new f.w.Event('focus')); await tick();
  assert.equal(f.authCalls.length, 2);
});

test('Desktop renderer keeps its session when the previous access token expiry has passed', async t => {
  const f = setup(t, { auth: async () => connected('account-a', Date.now() - 1000) });
  await f.w.todoClient.restore(); await tick();
  assert.equal(f.state.connected, true);
  await f.w.todoClient.sync();
  assert.equal(f.reads, 2);
  assert.equal(f.state.connected, true);
});

test('Desktop focus retries a transient startup restore failure without browser login', async t => {
  let attempts = 0;
  const f = setup(t, { auth: async () => ++attempts === 1 ? { ok: false, error: 'temporarily offline' } : connected() });
  await f.w.todoClient.request('list'); await tick(); await tick();
  assert.equal(f.state.connected, false);
  assert.equal(f.state.error, 'temporarily offline');
  f.w.dispatchEvent(new f.w.Event('focus')); await tick(); await tick();
  assert.deepEqual(f.authCalls, ['restore', 'restore']);
  assert.equal(f.state.connected, true);
  assert.equal(f.reads, 1);
});

test('disconnect rejects a late Desktop restore and suppresses automatic reconnect', async t => {
  let resolveRestore;
  const f = setup(t, { auth: action => action === 'restore' ? new Promise(resolve => { resolveRestore = resolve; }) : { ok: true } });
  const pending = f.w.todoClient.restore();
  const rejected = assert.rejects(pending, /キャンセル/);
  await tick(); await f.w.todoClient.disconnect();
  resolveRestore(connected()); await rejected;
  f.w.dispatchEvent(new f.w.Event('focus')); await tick();
  assert.deepEqual(f.authCalls, ['restore', 'disconnect']);
  assert.equal(f.reads, 0);
  assert.equal(f.state.connected, false);
});

test('interactive Desktop connect waits for a silent restore and opens login only if needed', async t => {
  let resolveRestore;
  const f = setup(t, { auth: action => action === 'restore' ? new Promise(resolve => { resolveRestore = resolve; }) : connected() });
  const restoring = f.w.todoClient.restore(); await tick();
  const first = f.w.todoClient.connect(), second = f.w.todoClient.connect();
  assert.equal(first, second);
  assert.deepEqual(f.authCalls, ['restore']);
  resolveRestore({ ok: true, data: { connected: false } });
  await restoring; await first;
  assert.deepEqual(f.authCalls, ['restore', 'connect']);
  assert.equal(f.state.connected, true);
  assert.equal(f.reads, 1);
});

test('disconnect during a Drive read preserves pending tasks and sends no later uploads', async t => {
  let finishRead;
  const f = setup(t, { list: () => new Promise(resolve => { finishRead = resolve; }) });
  await f.w.todoClient.request('add', { title: 'pending task', priority: 'normal' });
  const pending = f.w.todoClient.restore();
  const rejected = assert.rejects(pending, /キャンセル/);
  await tick(); await f.w.todoClient.disconnect(); finishRead([]); await rejected;
  assert.equal(f.uploads, 0);
  assert.equal(f.cache.pending.length, 1);
  assert.equal(f.state.connected, false);
  assert.equal(f.state.lastSync, 0);
});

test('Desktop revoked session returns to reconnect state after a failed sync', async t => {
  let fail = false;
  const f = setup(t, {
    auth: async action => action === 'status' ? { ok: true, data: { connected: false } } : connected(),
    list: () => { if (fail) throw Error('再接続してください'); return []; }
  });
  await f.w.todoClient.restore(); fail = true;
  await assert.rejects(f.w.todoClient.sync(), /再接続/);
  assert.equal(f.state.connected, false);
  assert.equal(f.state.error, '再接続してください');
});

test('Desktop disconnect handles IPC failure and reports it without an unhandled rejection', async t => {
  const f = setup(t, { auth: async action => {
    if (action === 'disconnect') throw Error('保存した接続を解除できませんでした');
    return connected();
  } });
  let reported;
  f.w.addEventListener('michi-sync-error', event => { reported = event.detail; });
  await f.w.todoClient.restore();
  await f.w.todoClient.disconnect();
  assert.equal(reported, '保存した接続を解除できませんでした');
  assert.equal(f.state.connected, false);
  f.w.dispatchEvent(new f.w.Event('focus')); await tick();
  assert.deepEqual(f.authCalls, ['restore', 'disconnect']);
});

test('Desktop Drive requests carry the verified local account for main-process binding', async t => {
  const f=setup(t);let request;
  f.w.Response=Response;f.w.AbortSignal=AbortSignal;
  f.w.todo.driveRequest=async input=>{request=input;return {ok:true,data:{status:200,text:'{"files":[]}'}};};
  f.w.eval(fs.readFileSync(path.join(__dirname,'../src/drive-sync.js'),'utf8'));
  const drive=new f.w.MichiDrive(()=>{throw Error('Renderer must not obtain token');},()=> 'account-a');
  await drive.list();assert.equal(request.account,'account-a');
  request=null;const unbound=new f.w.MichiDrive(()=> 'unused');
  await assert.rejects(unbound.list(),/Googleアカウントを確認/);
  assert.equal(request,null);
});

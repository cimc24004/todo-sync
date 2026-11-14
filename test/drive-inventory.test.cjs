'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const op = { id: 'operation-1', taskId: 'task-1', device: 'desktop-1', clock: 1, patch: { title: '同期するタスク' } };
const file = { id: 'drive-file-1', name: 'michi-op-operation-1.json' };
function fixture(respond, getSignal = () => null) {
  const requests = [];
  const w = {
    URLSearchParams, Response, AbortSignal, AbortController, crypto: webcrypto, setTimeout, clearTimeout,
    async fetch(url, options) {
      const request = { url: new URL(url), options }; requests.push(request);
      return new Response(JSON.stringify(await respond(request, requests.length)), { headers: { 'Content-Type': 'application/json' } });
    }
  };
  w.window = w;
  const context = vm.createContext(w);
  for (const name of ['sync-core.js', 'drive-sync.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', name), 'utf8'), context);
  return { drive: new w.MichiDrive(() => 'test-token', () => 'account-1', getSignal), requests };
}

test('complete Drive inventory follows empty intermediate pages and requests incompleteSearch', async () => {
  const f = fixture((request, count) => count === 1
    ? { files: [], nextPageToken: 'next-page', incompleteSearch: false }
    : { files: [file], incompleteSearch: false });
  const result = await f.drive.list();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [file]);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].url.searchParams.get('pageToken'), 'next-page');
  assert.equal(f.requests[0].url.searchParams.get('fields'), 'nextPageToken,incompleteSearch,files(id,name)');
  assert.equal(f.requests[0].url.searchParams.get('spaces'), 'appDataFolder');
  assert.equal(f.requests[0].url.searchParams.get('q'), "trashed = false and appProperties has { key='michiFormat' and value='op-v1' }");
});

test('an explicit empty complete inventory is valid', async () => {
  const f = fixture(() => ({ files: [], incompleteSearch: false }));
  assert.equal((await f.drive.list()).length, 0);
});

test('incomplete Drive searches fail without returning a partial inventory', async () => {
  const f = fixture((request, count) => count === 1
    ? { files: [file], nextPageToken: 'next' }
    : { files: [], incompleteSearch: true });
  await assert.rejects(f.drive.list(), /一覧が不完全/);
  assert.equal(f.requests.length, 2);
});

test('malformed inventory cannot become an empty successful search', async () => {
  for (const response of [null, [], {}, { files: null }, { files: {} }, { files: 'not-files' },
    { files: [], incompleteSearch: 'false' }, { files: [], nextPageToken: 1 }, { files: [], nextPageToken: '' },
    { files: [], nextPageToken: null }, { files: [null] }, { files: ['not-a-file'] },
    { files: [{ ...file, id: '' }] }, { files: [{ ...file, id: 'bad/id' }] }, { files: [{ ...file, id: 1 }] },
    { files: [{ ...file, name: '' }] }, { files: [{ ...file, name: 1 }] }, { files: [{ ...file, name: 'unrelated.json' }] },
    { files: [{ ...file, name: 'michi-op-.json' }] }]) {
    const f = fixture(() => response);
    await assert.rejects(f.drive.list(), /一覧を確認|同期ファイル情報/);
  }
});

test('pagination stops on a repeated continuation token', async () => {
  const f = fixture(() => ({ files: [], nextPageToken: 'repeated' }));
  await assert.rejects(f.drive.list(), /最後まで確認/);
  assert.equal(f.requests.length, 2);
});

test('identical files repeated across live pages are deduplicated', async () => {
  const f = fixture((request, count) => ({ files: [file], ...(count === 1 ? { nextPageToken: 'next' } : {}) }));
  assert.equal((await f.drive.list()).length, 1);
});

test('the same Drive ID with different names across pages rejects an ambiguous inventory', async () => {
  const f = fixture((request, count) => count === 1
    ? { files: [file], nextPageToken: 'next' }
    : { files: [{ ...file, name: 'michi-op-different.json' }] });
  await assert.rejects(f.drive.list(), /一覧が途中で変わり/);
});

test('distinct Drive files with the same operation filename remain available for body validation', async () => {
  const f = fixture(() => ({ files: [file, { ...file, id: 'duplicate-file' }] }));
  assert.equal((await f.drive.list()).length, 2);
});

test('pull supplies receipts for validated file bodies including duplicate uploads', async () => {
  const f = fixture(() => op), receipts = [], progress = [];
  const result = await f.drive.pull([file, { ...file, id: 'duplicate-file' }],
    (done, total) => progress.push([done, total]),
    (remoteFile, remoteOp) => receipts.push({ fileId: remoteFile.id, opId: remoteOp.id }));
  assert.equal(result.length, 1);
  assert.deepEqual(receipts, [{ fileId: file.id, opId: op.id }, { fileId: 'duplicate-file', opId: op.id }]);
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
});

test('a mismatched filename does not create a receipt or progress acknowledgement', async () => {
  const f = fixture(() => ({ ...op, id: 'unexpected-operation' }));
  let callbacks = 0;
  await assert.rejects(f.drive.pull([file], () => callbacks++, () => callbacks++), /ファイル名と同期データが一致/);
  assert.equal(callbacks, 0);
});

test('conflicting bodies under the same operation ID reject the whole pull', async () => {
  const f = fixture((request, count) => count === 1 ? op : { ...op, patch: { title: 'different' } });
  await assert.rejects(f.drive.pull([file, { ...file, id: 'conflicting-file' }]), /同じ操作IDに異なる内容/);
});

test('pull retains its initial signal even when the owner clears it during a callback', async () => {
  const controller = new AbortController(); let currentSignal = controller.signal;
  const f = fixture(() => op, () => currentSignal);
  await assert.rejects(f.drive.pull([file, { ...file, id: 'later-file' }], () => {}, () => {
    controller.abort(); currentSignal = null;
  }), { code: 'NETWORK_CANCELLED' });
  assert.equal(f.requests.length, 1);
});

test('cancellation in the final progress callback cannot report a completed pull', async () => {
  const controller = new AbortController();
  const f = fixture(() => op, () => controller.signal);
  await assert.rejects(f.drive.pull([file], () => controller.abort()), { code: 'NETWORK_CANCELLED' });
});

test('list observes cancellation after a page body before starting another page', async () => {
  const controller = new AbortController(); let currentSignal = controller.signal, calls = 0;
  const f = fixture(() => {}, () => currentSignal);
  f.drive.fetch = async () => { calls++; return { json() {
    controller.abort(); currentSignal = null;
    return { files: [], nextPageToken: 'must-not-be-read' };
  } }; };
  await assert.rejects(f.drive.list(), { code: 'NETWORK_CANCELLED' });
  assert.equal(calls, 1);
});

test('upload responses require a valid Drive file ID before acknowledging delivery', async () => {
  for (const response of [null, {}, [], { id: '' }, { id: ' ' }, { id: 1 }, { id: 'invalid/id' }]) {
    const f = fixture(() => response);
    await assert.rejects(f.drive.push(op), /保存結果を確認/);
  }
  const f = fixture(() => ({ id: 'uploaded-file' }));
  assert.equal((await f.drive.push(op)).id, 'uploaded-file');
});

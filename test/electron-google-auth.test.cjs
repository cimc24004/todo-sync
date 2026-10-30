'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { createGoogleAuth, DRIVE_SCOPE } = require('../src/electron-google-auth.cjs');
function fixture(overrides = {}) {
  let handler, opened, closed = 0, clock = 100000;
  const requests = [];
  const server = new EventEmitter();
  server.listen = (port, host, callback) => { assert.equal(port, 0); assert.equal(host, '127.0.0.1'); queueMicrotask(callback); };
  server.address = () => ({ port: 34123 });
  server.close = () => { closed++; };
  const auth = createGoogleAuth({ clientId: 'unit-test.apps.googleusercontent.com',
    createServer: h => { handler = h; return server; }, now: () => clock,
    openExternal: async url => { opened = new URL(url); },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => url.includes('/userinfo')
        ? { sub: 'account-1', email: 'person@example.test', email_verified: true }
        : { access_token: 'memory-only-token', token_type: 'Bearer', scope: `${DRIVE_SCOPE} openid email`, expires_in: 3600, refresh_token: 'discard-me' } };
    }, ...overrides });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  async function callback({ state, path = '/oauth2/callback', host = '127.0.0.1:34123', method = 'GET', query = {} } = {}) {
    const params = new URLSearchParams({ code: 'test-code', state: state ?? opened.searchParams.get('state'), ...query });
    const res = { status: null, body: '', writableEnded: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { this.body = body; this.writableEnded = true; } };
    await handler({ method, headers: { host }, url: `${path}?${params}` }, res);
    return res;
  }
  return { auth, requests, tick, callback, server, get opened() { return opened; },
    get closed() { return closed; }, setClock: value => { clock = value; } };
}
test('PKCE system browser flow uses random localhost port; status never exposes tokens', async () => {
  const f = fixture(); const p = f.auth.connect(); await f.tick();
  assert.equal(f.opened.origin, 'https://accounts.google.com');
  assert.equal(f.opened.searchParams.get('redirect_uri'), 'http://127.0.0.1:34123/oauth2/callback');
  assert.equal(f.opened.searchParams.get('code_challenge_method'), 'S256');
  const response = await f.callback(); assert.equal(response.status, 200);
  const result = await p; assert.equal(result.connected, true);
  assert.deepEqual(result.identity, { sub: 'account-1', email: 'person@example.test' });
  assert.equal(JSON.stringify(result).includes('memory-only-token'), false);
  assert.equal(JSON.stringify(result).includes('discard-me'), false);
  const body = new URLSearchParams(f.requests[0].options.body);
  assert.equal(crypto.createHash('sha256').update(body.get('code_verifier')).digest('base64url'), f.opened.searchParams.get('code_challenge'));
  assert.equal(f.auth.getAccessToken(), 'memory-only-token');
  f.setClock(result.expiresAt - 10000);
  assert.throws(() => f.auth.getAccessToken(), { code: 'AUTH_REQUIRED' });
});
test('malicious callback state, path, host and method do not finish or exchange', async () => {
  const f = fixture(); const p = f.auth.connect(); await f.tick();
  assert.equal((await f.callback({ state: 'attacker' })).status, 400);
  assert.equal((await f.callback({ path: '/wrong' })).status, 404);
  assert.equal((await f.callback({ host: 'evil.example' })).status, 400);
  assert.equal((await f.callback({ method: 'POST' })).status, 400);
  assert.equal(f.requests.length, 0);
  await f.callback(); await p;
});
test('concurrent connect is single flow and cancellation rejects it', async () => {
  const f = fixture(); const p = f.auth.connect(); assert.equal(f.auth.connect(), p);
  const rejected = assert.rejects(p, { code: 'AUTH_CANCELLED' });
  f.auth.cancel(); await rejected; await f.tick();
  assert.equal(f.opened, undefined); assert.equal(f.auth.status().connected, false);
});
test('user denied authorization closes server and preserves no credentials', async () => {
  const f = fixture(); const p = f.auth.connect(); const rejected = assert.rejects(p, { code: 'AUTH_DENIED' }); await f.tick();
  await f.callback({ query: { error: 'access_denied' } }); await rejected;
  assert.equal(f.requests.length, 0); assert.ok(f.closed > 0);
});
test('timeout rejects without leaving active session', async () => {
  const f = fixture({ timeoutMs: 5 }); const p = f.auth.connect();
  const rejected = assert.rejects(p, { code: 'AUTH_TIMEOUT' });
  await new Promise(resolve => setTimeout(resolve, 15)); await rejected;
  assert.equal(f.auth.status().connected, false); assert.ok(f.closed > 0);
});
test('network failure is sanitized and missing client ID fails closed', async () => {
  const f = fixture({ fetchImpl: async () => { throw new Error('secret-response'); } });
  const p = f.auth.connect(); const rejected = assert.rejects(p, { code: 'AUTH_NETWORK' }); await f.tick();
  const res = await f.callback(); await rejected; assert.equal(res.body.includes('secret-response'), false);
  await assert.rejects(createGoogleAuth({}).connect(), { code: 'AUTH_NOT_CONFIGURED' });
});
test('disconnect while token request is pending cannot reconnect late', async () => {
  let release;
  const f = fixture({ fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const p = f.auth.connect(); const rejected = assert.rejects(p, { code: 'AUTH_CANCELLED' }); await f.tick();
  const incoming = f.callback(); await f.tick(); f.auth.disconnect();
  release({ ok: true, json: async () => ({ access_token: 'late', token_type: 'Bearer', scope: DRIVE_SCOPE, expires_in: 3600 }) });
  await incoming; await rejected; assert.equal(f.auth.status().connected, false);
});
test('missing Drive scope fails closed without fetching identity', async () => {
  const f = fixture({ fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 'x', token_type: 'Bearer', scope: 'openid email', expires_in: 3600 }) }) });
  const p = f.auth.connect(); const rejected = assert.rejects(p, { code: 'AUTH_INVALID_RESPONSE' }); await f.tick();
  await f.callback(); await rejected; assert.equal(f.auth.status().connected, false);
});
test('unverified account identity fails closed', async () => {
  const f = fixture({ fetchImpl: async url => ({ ok: true, json: async () => url.includes('/userinfo')
    ? { sub: 's', email: 'person@example.test', email_verified: false }
    : { access_token: 'x', token_type: 'Bearer', scope: DRIVE_SCOPE, expires_in: 3600 } }) });
  const p = f.auth.connect(); const rejected = assert.rejects(p, { code: 'AUTH_IDENTITY_FAILED' }); await f.tick();
  await f.callback(); await rejected; assert.equal(f.auth.status().connected, false);
});
test('standard browser launch error closes temporary server', async () => {
  const f = fixture({ openExternal: async () => { throw new Error('unable'); } });
  await assert.rejects(f.auth.connect(), { code: 'AUTH_BROWSER_FAILED' }); assert.ok(f.closed > 0);
});

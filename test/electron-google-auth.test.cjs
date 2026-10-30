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
  assert.equal(body.has('client_secret'), false);
  assert.equal(crypto.createHash('sha256').update(body.get('code_verifier')).digest('base64url'), f.opened.searchParams.get('code_challenge'));
  assert.equal(await f.auth.getAccessToken(), 'memory-only-token');
  f.setClock(result.expiresAt - 10000);
  await assert.rejects(f.auth.getAccessToken(), { code: 'AUTH_REQUIRED' });
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

test('Desktop client secret is sent only to the token endpoint', async () => {
  const secret = 'test-desktop-secret';
  const f = fixture({ clientSecret: secret });
  const p = f.auth.connect(); await f.tick();
  assert.equal(f.opened.searchParams.has('client_secret'), false);
  assert.equal(f.opened.href.includes(secret), false);
  const response = await f.callback(); const result = await p;
  assert.equal(new URLSearchParams(f.requests[0].options.body).get('client_secret'), secret);
  assert.equal(f.requests[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(JSON.stringify(f.requests[1]).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(f.auth.status()).includes(secret), false);
  assert.equal(response.body.includes(secret), false);
});

test('missing Desktop client secret explains the failure in both callback and promise', async () => {
  const f = fixture({ fetchImpl: async () => ({ ok: false, status: 400,
    json: async () => ({ error: 'invalid_request', error_description: 'client_secret is missing.' }) }) });
  const p = f.auth.connect(); let message;
  const rejected = assert.rejects(p, error => {
    assert.equal(error.code, 'AUTH_CLIENT_SECRET_REQUIRED');
    assert.match(error.message, /シークレットが未設定/); message = error.message; return true;
  });
  await f.tick(); const res = await f.callback(); await rejected;
  assert.equal(res.status, 502); assert.ok(res.body.includes(message));
  assert.equal(f.auth.status().connected, false); assert.ok(f.closed > 0);
});

test('known token errors use fixed messages without returning provider details', async t => {
  for (const [providerCode, expectedCode] of [
    ['invalid_client', 'AUTH_INVALID_CLIENT'], ['invalid_grant', 'AUTH_INVALID_GRANT'],
    ['unauthorized_client', 'AUTH_UNAUTHORIZED_CLIENT'], ['redirect_uri_mismatch', 'AUTH_REDIRECT_MISMATCH']
  ]) await t.test(providerCode, async () => {
    const f = fixture({ fetchImpl: async () => ({ ok: false, status: 400,
      json: async () => ({ error: providerCode, error_description: 'secret-provider-details', access_token: 'secret-token' }) }) });
    const p = f.auth.connect(); let message;
    const rejected = assert.rejects(p, error => {
      assert.equal(error.code, expectedCode); assert.doesNotMatch(error.message, /secret-/);
      message = error.message; return true;
    });
    await f.tick(); const res = await f.callback(); await rejected;
    assert.ok(res.body.includes(message)); assert.doesNotMatch(res.body, /secret-/);
    assert.equal(f.auth.status().connected, false); assert.ok(f.closed > 0);
  });
});

test('unknown and malformed token errors expose only a validated HTTP status', async t => {
  for (const [name, status, json, expectedStatus] of [
    ['unknown error', 400, async () => ({ error: 'secret-provider-code', error_description: 'secret-provider-details' }), 'HTTP 400'],
    ['prototype key', 401, async () => ({ error: '__proto__', error_description: 'secret-provider-details' }), 'HTTP 401'],
    ['non-JSON body', 502, async () => { throw Error('secret-html-body'); }, 'HTTP 502'],
    ['invalid status', 'secret-status', async () => null, null]
  ]) await t.test(name, async () => {
    const f = fixture({ fetchImpl: async () => ({ ok: false, status, json }) });
    const p = f.auth.connect(); let message;
    const rejected = assert.rejects(p, error => {
      assert.equal(error.code, 'AUTH_EXCHANGE_FAILED'); assert.doesNotMatch(error.message, /secret-/);
      if (expectedStatus) assert.ok(error.message.includes(expectedStatus));
      else assert.equal(error.message.includes('HTTP'), false);
      message = error.message; return true;
    });
    await f.tick(); const res = await f.callback(); await rejected;
    assert.ok(res.body.includes(message)); assert.doesNotMatch(res.body, /secret-/);
    assert.equal(f.auth.status().connected, false);
  });
});

test('external errors cannot spoof trusted AUTH codes to reveal their message', async () => {
  const f = fixture({ fetchImpl: async () => {
    throw Object.assign(Error('secret-network-details'), { code: 'AUTH_CLIENT_SECRET_REQUIRED' });
  } });
  const p = f.auth.connect(); const rejected = assert.rejects(p, error => {
    assert.equal(error.code, 'AUTH_NETWORK'); assert.doesNotMatch(error.message, /secret-/); return true;
  });
  await f.tick(); const res = await f.callback(); await rejected;
  assert.doesNotMatch(res.body, /secret-/); assert.equal(f.auth.status().connected, false);
});

function savedLogin(overrides = {}) {
  return { clientId: 'unit-test.apps.googleusercontent.com', refreshToken: 'saved-refresh-token',
    identity: { sub: 'account-1', email: 'person@example.test' }, scope: `${DRIVE_SCOPE} openid email`, ...overrides };
}
function memoryStore(initial = null) {
  let record = structuredClone(initial), clears = 0;
  return {
    async load() { return structuredClone(record); },
    async save(next) { record = structuredClone(next); },
    async clear() { clears++; record = null; },
    get record() { return structuredClone(record); }, get clears() { return clears; }
  };
}

test('offline consent persists refresh login and a new instance restores without a browser', async () => {
  const store = memoryStore();
  const first = fixture({ tokenStore: store });
  const connected = first.auth.connect(); await first.tick();
  assert.equal(first.opened.searchParams.get('access_type'), 'offline');
  assert.match(first.opened.searchParams.get('prompt'), /consent/);
  await first.callback(); const result = await connected;
  assert.equal(store.record.refreshToken, 'discard-me');
  assert.equal(store.record.clientId, 'unit-test.apps.googleusercontent.com');
  assert.doesNotMatch(JSON.stringify(result), /discard-me|memory-only-token/);
  first.auth.dispose();
  assert.equal(store.record.refreshToken, 'discard-me');
  const next = fixture({ tokenStore: store, clientSecret: 'test-client-secret' });
  const restored = await next.auth.restore();
  assert.equal(restored.connected, true);
  assert.equal(next.opened, undefined);
  const body = new URLSearchParams(next.requests[0].options.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'discard-me');
  assert.equal(body.get('client_secret'), 'test-client-secret');
  assert.doesNotMatch(JSON.stringify(restored), /discard-me|memory-only-token|test-client-secret/);
});

test('startup without a stored login stays offline without opening a browser', async () => {
  const f = fixture({ tokenStore: memoryStore() });
  assert.equal((await f.auth.restore()).connected, false);
  assert.equal(f.opened, undefined); assert.equal(f.requests.length, 0);
  await assert.rejects(f.auth.getAccessToken(), { code: 'AUTH_REQUIRED' });
});

test('near-expiry requests share one refresh after a clock jump or sleep', async () => {
  const f = fixture({ tokenStore: memoryStore(savedLogin()) });
  const first = await f.auth.restore();
  assert.equal(f.requests.length, 2);
  f.setClock(first.expiresAt + 600000);
  const values = await Promise.all([f.auth.getAccessToken(), f.auth.getAccessToken(), f.auth.restore()]);
  assert.equal(values[0], 'memory-only-token'); assert.equal(values[1], 'memory-only-token');
  assert.equal(values[2].connected, true);
  assert.equal(f.requests.filter(r => r.url.includes('/token')).length, 2);
  assert.equal(f.opened, undefined);
});

test('refresh responses may retain the existing refresh token and granted scopes', async () => {
  const store = memoryStore(savedLogin());
  const f = fixture({ tokenStore: store, fetchImpl: async url => ({ ok: true, json: async () => url.includes('/userinfo')
    ? { sub: 'account-1', email: 'person@example.test', email_verified: true }
    : { access_token: 'new-memory-token', token_type: 'Bearer', expires_in: 3600 } }) });
  assert.equal((await f.auth.restore()).connected, true);
  assert.equal(store.record.refreshToken, 'saved-refresh-token');
  assert.equal(await f.auth.getAccessToken(), 'new-memory-token');
});

test('invalidated refresh grants clear saved credentials and require a new connection', async () => {
  const store = memoryStore(savedLogin()); let calls = 0;
  const f = fixture({ tokenStore: store, fetchImpl: async () => {
    calls++; return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'private-provider-details' }) };
  } });
  await assert.rejects(f.auth.restore(), error => {
    assert.equal(error.code, 'AUTH_REQUIRED'); assert.doesNotMatch(error.message, /private-provider-details/); return true;
  });
  assert.equal(store.record, null); assert.equal(store.clears, 1);
  assert.equal((await f.auth.restore()).connected, false); assert.equal(calls, 1);
});

test('temporary refresh network errors keep saved login for retry', async () => {
  const store = memoryStore(savedLogin()); let offline = true;
  const f = fixture({ tokenStore: store, fetchImpl: async url => {
    if (offline) throw Error('private-network-detail');
    return { ok: true, json: async () => url.includes('/userinfo')
      ? { sub: 'account-1', email: 'person@example.test', email_verified: true }
      : { access_token: 'new-memory-token', token_type: 'Bearer', scope: DRIVE_SCOPE, expires_in: 3600 } };
  } });
  await assert.rejects(f.auth.restore(), { code: 'AUTH_NETWORK' });
  assert.equal(store.record.refreshToken, 'saved-refresh-token'); assert.equal(store.clears, 0);
  offline = false;
  assert.equal((await f.auth.restore()).connected, true);
  assert.equal(f.opened, undefined);
});

test('saved credentials for another client are rejected before contacting Google', async () => {
  const f = fixture({ tokenStore: memoryStore(savedLogin({ clientId: 'different.apps.googleusercontent.com' })) });
  await assert.rejects(f.auth.restore(), { code: 'AUTH_SAVED_CREDENTIAL_INVALID' });
  assert.equal(f.requests.length, 0); assert.equal(f.auth.status().connected, false);
});

test('refresh cannot accept a different Google account or a reduced Drive grant', async t => {
  for (const differentAccount of [true, false]) await t.test(differentAccount ? 'identity mismatch' : 'missing Drive scope', async () => {
    let identities = 0;
    const f = fixture({ tokenStore: memoryStore(savedLogin()), fetchImpl: async url => {
      if (url.includes('/userinfo')) { identities++; return { ok: true, json: async () => ({ sub: 'another-account', email: 'other@example.test', email_verified: true }) }; }
      return { ok: true, json: async () => ({ access_token: 'new-token', token_type: 'Bearer', expires_in: 3600, scope: differentAccount ? DRIVE_SCOPE : 'openid email' }) };
    } });
    await assert.rejects(f.auth.restore(), { code: differentAccount ? 'AUTH_IDENTITY_FAILED' : 'AUTH_INVALID_RESPONSE' });
    assert.equal(f.auth.status().connected, false);
    assert.equal(identities, differentAccount ? 1 : 0);
  });
});

test('disconnect during an in-flight refresh cannot reconnect late', async () => {
  const store = memoryStore(savedLogin()); let release;
  const f = fixture({ tokenStore: store, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.auth.restore(); const rejected = assert.rejects(pending, { code: 'AUTH_CANCELLED' });
  await f.tick(); await f.auth.disconnect();
  release({ ok: true, json: async () => ({ access_token: 'late-token', token_type: 'Bearer', scope: DRIVE_SCOPE, expires_in: 3600 }) });
  await rejected;
  assert.equal(store.record, null); assert.equal(f.auth.status().connected, false);
});

test('disconnect during persistent login save clears that save before resolving', async () => {
  const base = memoryStore(); let releaseSave;
  const store = { load: () => base.load(), clear: () => base.clear(), save: value => new Promise(resolve => {
    releaseSave = async () => { await base.save(value); resolve(); };
  }) };
  const f = fixture({ tokenStore: store });
  const connected = f.auth.connect(); const rejected = assert.rejects(connected, { code: 'AUTH_CANCELLED' });
  await f.tick(); const incoming = f.callback(); await f.tick();
  const disconnected = f.auth.disconnect();
  await releaseSave(); await incoming; await rejected; await disconnected;
  assert.equal(base.record, null); assert.equal(f.auth.status().connected, false);
  assert.equal((await f.auth.restore()).connected, false);
});

test('dispose cancels an in-flight refresh but preserves the saved login', async () => {
  const store = memoryStore(savedLogin()); let release;
  const f = fixture({ tokenStore: store, fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.auth.restore(); const rejected = assert.rejects(pending, { code: 'AUTH_CANCELLED' });
  await f.tick(); f.auth.dispose();
  release({ ok: true, json: async () => ({ access_token: 'late-token', token_type: 'Bearer', scope: DRIVE_SCOPE, expires_in: 3600 }) });
  await rejected;
  assert.equal(store.record.refreshToken, 'saved-refresh-token'); assert.equal(store.clears, 0);
  assert.equal(f.auth.status().connected, false);
});

test('persistent login rejects missing refresh credentials and sanitized storage failures', async t => {
  await t.test('missing refresh token', async () => {
    const store = memoryStore();
    const f = fixture({ tokenStore: store, fetchImpl: async url => ({ ok: true, json: async () => url.includes('/userinfo')
      ? { sub: 'account-1', email: 'person@example.test', email_verified: true }
      : { access_token: 'memory-token', token_type: 'Bearer', scope: DRIVE_SCOPE, expires_in: 3600 } }) });
    const connected = f.auth.connect(); const rejected = assert.rejects(connected, { code: 'AUTH_REFRESH_REQUIRED' });
    await f.tick(); await f.callback(); await rejected;
    assert.equal(store.record, null); assert.equal(f.auth.status().connected, false);
  });
  await t.test('storage error', async () => {
    const store = { load: async () => { throw Error('secret-path-or-token'); }, save: async () => {}, clear: async () => {} };
    const f = fixture({ tokenStore: store });
    await assert.rejects(f.auth.restore(), error => {
      assert.equal(error.code, 'AUTH_STORAGE'); assert.doesNotMatch(error.message, /secret-path-or-token/); return true;
    });
  });
});

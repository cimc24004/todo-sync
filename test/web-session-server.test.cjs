'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { createGoogleWebHandler } = require('../server/google-session.cjs');

const ORIGIN = 'https://todo.example.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata openid email';
const CLIENT_SECRET = 'test-client-secret-do-not-expose';
const REFRESH = 'test-refresh-token-do-not-expose';
const ACCESS = 'test-access-token-do-not-expose';
const env = {
  APP_ORIGIN: ORIGIN,
  GOOGLE_WEB_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_WEB_CLIENT_SECRET: CLIENT_SECRET,
  GOOGLE_SESSION_SECRET: crypto.randomBytes(32).toString('base64'),
};
const user = { sub: '123456789', email: 'person@example.com', email_verified: true };
const sessionName = '__Host-michi-session';
const stateName = '__Host-michi-oauth';

function response(body, status = 200) { return { status, ok: status >= 200 && status < 300, text: async () => typeof body === 'string' ? body : JSON.stringify(body) }; }
function fakeGoogle(options = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      if (options.network) throw Error(`network error ${CLIENT_SECRET} ${REFRESH}`);
      if (options.tokenError) return response({ error: options.tokenError, error_description: `${CLIENT_SECRET} ${REFRESH}` }, options.tokenStatus || 400);
      const refreshing = new URLSearchParams(init.body).get('grant_type') === 'refresh_token';
      return response({ access_token: ACCESS, token_type: 'Bearer', expires_in: 3600,
        scope: SCOPE, ...(!refreshing ? { refresh_token: REFRESH } : {}), ...options.tokens });
    }
    if (String(url) === 'https://openidconnect.googleapis.com/v1/userinfo') return response({ ...user, ...options.user }, options.userStatus || 200);
    if (String(url).startsWith('https://www.googleapis.com/')) return response(options.driveText || '{"files":[]}', options.driveStatus || 200);
    throw Error(`Unexpected URL: ${url}`);
  };
  return { calls, fetchImpl };
}
async function request(handler, action, options = {}) {
  const raw = options.raw === undefined ? JSON.stringify(options.body === undefined ? {} : options.body) : options.raw;
  const req = Readable.from([raw]);
  req.url = `/api/google?action=${action}${options.query || ''}`;
  req.method = options.method || (['drive', 'disconnect'].includes(action) ? 'POST' : 'GET');
  req.headers = { ...(req.method === 'POST' ? { origin: ORIGIN, 'x-michi-request': '1', 'content-type': 'application/json' } : {}),
    ...(options.cookie ? { cookie: options.cookie } : {}), ...options.headers };
  if (options.parsedBody !== undefined) req.body = options.parsedBody;
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    getHeader(name) { return headers[name.toLowerCase()]; },
    end(body) { this.body = body || ''; },
  };
  await handler(req, res);
  return { status: res.statusCode, body: res.body, headers, data: res.body ? JSON.parse(res.body) : null };
}
function cookies(res) { return res.headers['set-cookie'] || []; }
function cookieFrom(res, name) {
  const found = cookies(res).find(value => value.startsWith(`${name}=`) && !value.startsWith(`${name}=;`));
  assert.ok(found, `${name} was set`);
  return found.split(';')[0];
}
function hasClearedCookie(res, name) { return cookies(res).some(value => value.startsWith(`${name}=;`) && value.includes('Max-Age=0')); }
function noSecrets(res) {
  const output = JSON.stringify(res);
  for (const secret of [CLIENT_SECRET, REFRESH, ACCESS]) assert.ok(!output.includes(secret), `response exposed ${secret}`);
}
async function login(handler) {
  const start = await request(handler, 'start');
  const state = new URL(start.headers.location).searchParams.get('state');
  const result = await request(handler, 'callback', { cookie: cookieFrom(start, stateName), query: `&code=authorization-code&state=${encodeURIComponent(state)}` });
  assert.equal(result.status, 303, result.body);
  return { cookie: cookieFrom(result, sessionName), start, result };
}
function listInput() {
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.search = new URLSearchParams({ spaces: 'appDataFolder', q: "trashed = false and appProperties has { key='michiFormat' and value='op-v1' }", fields: 'nextPageToken,files(id,name)', pageSize: '1000' }).toString();
  return { url: url.href, options: {}, account: user.sub };
}

test('start uses offline OAuth with PKCE and bounded encrypted secure cookies', async () => {
  const google = fakeGoogle();
  const handler = createGoogleWebHandler({ env, fetchImpl: google.fetchImpl });
  const start = await request(handler, 'start');
  assert.equal(start.status, 303);
  const location = new URL(start.headers.location);
  assert.equal(location.origin, 'https://accounts.google.com');
  assert.equal(location.searchParams.get('redirect_uri'), `${ORIGIN}/api/google?action=callback`);
  assert.equal(location.searchParams.get('access_type'), 'offline');
  assert.equal(location.searchParams.get('prompt'), 'consent select_account');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.match(location.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  const stateCookie = cookies(start)[0];
  assert.ok(stateCookie.length < 4096);
  assert.match(stateCookie, /; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  assert.ok(!stateCookie.includes(location.searchParams.get('state')));
  assert.equal(start.headers['cache-control'], 'no-store, private');
  assert.equal(google.calls.length, 0);
  noSecrets(start);
});

test('callback validates PKCE, verified identity and Drive scope, stores only encrypted credentials', async () => {
  const google = fakeGoogle();
  const handler = createGoogleWebHandler({ env, fetchImpl: google.fetchImpl });
  const result = await login(handler);
  assert.equal(result.result.headers.location, '/');
  assert.ok(hasClearedCookie(result.result, stateName));
  assert.ok(cookies(result.result).every(value => value.length < 4096));
  assert.ok(!result.cookie.includes(user.email));
  const params = new URLSearchParams(google.calls[0].init.body);
  assert.equal(params.get('client_secret'), CLIENT_SECRET);
  assert.equal(params.get('grant_type'), 'authorization_code');
  assert.equal(params.get('redirect_uri'), `${ORIGIN}/api/google?action=callback`);
  const challenge = crypto.createHash('sha256').update(params.get('code_verifier')).digest('base64url');
  assert.equal(challenge, new URL(result.start.headers.location).searchParams.get('code_challenge'));
  assert.equal(google.calls[0].init.redirect, 'error');
  noSecrets(result.result);
});

test('wrong, missing, expired, duplicate, tampered and Unicode states never exchange a code', async () => {
  for (const mode of ['wrong', 'missing', 'expired', 'duplicate', 'tampered', 'unicode']) {
    let time = 1700000000000;
    const google = fakeGoogle();
    const handler = createGoogleWebHandler({ env, fetchImpl: google.fetchImpl, now: () => time });
    const start = await request(handler, 'start');
    const state = new URL(start.headers.location).searchParams.get('state');
    let cookie = cookieFrom(start, stateName);
    if (mode === 'expired') time += 600001;
    if (mode === 'tampered') cookie = `${cookie.slice(0, -4)}aaaa`;
    if (mode === 'missing') cookie = '';
    const queryState = mode === 'wrong' ? 'bad-state' : mode === 'unicode' ? 'あ'.repeat(state.length) : state;
    const result = await request(handler, 'callback', { cookie, query: `&code=code&state=${encodeURIComponent(queryState)}${mode === 'duplicate' ? '&state=extra' : ''}` });
    assert.equal(result.status, 400, mode);
    assert.equal(result.data.code, 'INVALID_STATE', mode);
    assert.ok(hasClearedCookie(result, stateName));
    assert.equal(google.calls.length, 0, mode);
    noSecrets(result);
  }
});

test('session survives a new handler instance and refreshes without exposing tokens', async () => {
  const initial = fakeGoogle();
  const first = createGoogleWebHandler({ env, fetchImpl: initial.fetchImpl });
  const { cookie } = await login(first);
  const restarted = fakeGoogle();
  const second = createGoogleWebHandler({ env, fetchImpl: restarted.fetchImpl });
  const result = await request(second, 'session', { cookie });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.data.identity, { sub: user.sub, email: user.email });
  assert.equal(result.data.data.account, user.email);
  assert.equal(result.data.data.connected, true);
  assert.ok(result.data.data.expiresAt > Date.now());
  const params = new URLSearchParams(restarted.calls[0].init.body);
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(params.get('refresh_token'), REFRESH);
  noSecrets(result);
});

test('tampered, expired and client-bound sessions cannot authenticate', async () => {
  let time = 1700000000000;
  const google = fakeGoogle();
  const first = createGoogleWebHandler({ env, fetchImpl: google.fetchImpl, now: () => time });
  const { cookie } = await login(first);
  for (const mode of ['tampered', 'expired', 'client', 'origin', 'key']) {
    const nextGoogle = fakeGoogle();
    const modified = { ...env };
    if (mode === 'client') modified.GOOGLE_WEB_CLIENT_ID = 'different-client';
    if (mode === 'origin') modified.APP_ORIGIN = 'https://other.example.com';
    if (mode === 'key') modified.GOOGLE_SESSION_SECRET = crypto.randomBytes(32).toString('base64');
    const handler = createGoogleWebHandler({ env: modified, fetchImpl: nextGoogle.fetchImpl, now: () => mode === 'expired' ? time + 30 * 86400000 + 1 : time });
    const result = await request(handler, 'session', { cookie: mode === 'tampered' ? `${cookie.slice(0, -4)}xxxx` : cookie });
    assert.equal(result.data.data.connected, false, mode);
    assert.ok(hasClearedCookie(result, sessionName), mode);
    assert.equal(nextGoogle.calls.length, 0, mode);
  }
});

test('callback rejects missing refresh, wrong scope and unverified identity', async () => {
  for (const options of [{ tokens: { refresh_token: undefined } }, { tokens: { scope: 'openid email' } }, { user: { email_verified: false } }, { user: { sub: '' } }]) {
    const google = fakeGoogle(options);
    const handler = createGoogleWebHandler({ env, fetchImpl: google.fetchImpl });
    const start = await request(handler, 'start');
    const state = new URL(start.headers.location).searchParams.get('state');
    const result = await request(handler, 'callback', { cookie: cookieFrom(start, stateName), query: `&code=code&state=${state}` });
    assert.equal(result.status, 401);
    assert.equal(result.data.code, 'AUTH_REQUIRED');
    assert.ok(!cookies(result).some(value => value.startsWith(`${sessionName}=v1.`)));
    noSecrets(result);
  }
});

test('refresh rejects revoked grants, identity changes and scope loss; network failure preserves login', async () => {
  const initial = fakeGoogle();
  const { cookie } = await login(createGoogleWebHandler({ env, fetchImpl: initial.fetchImpl }));
  for (const options of [{ tokenError: 'invalid_grant' }, { user: { sub: 'other-user' } }, { user: { email_verified: false } }, { tokens: { scope: 'openid email' } }]) {
    const google = fakeGoogle(options);
    const result = await request(createGoogleWebHandler({ env, fetchImpl: google.fetchImpl }), 'session', { cookie });
    assert.equal(result.status, 401);
    assert.equal(result.data.code, 'AUTH_REQUIRED');
    assert.ok(hasClearedCookie(result, sessionName));
    noSecrets(result);
  }
  for (const options of [{ network: true }, { tokenError: 'server_error', tokenStatus: 503 }, { tokenError: 'invalid_client' }]) {
    const google = fakeGoogle(options);
    const result = await request(createGoogleWebHandler({ env, fetchImpl: google.fetchImpl }), 'session', { cookie });
    assert.equal(result.status, 503);
    assert.equal(result.data.code, 'TEMPORARY_UNAVAILABLE');
    assert.ok(!hasClearedCookie(result, sessionName));
    noSecrets(result);
  }
});

test('refresh rotation rewrites encrypted cookie while preserving absolute expiration', async () => {
  let time = 1700000000000;
  const first = fakeGoogle();
  const { cookie } = await login(createGoogleWebHandler({ env, fetchImpl: first.fetchImpl, now: () => time }));
  time += 100000;
  const next = fakeGoogle({ tokens: { refresh_token: 'rotated-refresh-token', scope: undefined } });
  const refreshed = await request(createGoogleWebHandler({ env, fetchImpl: next.fetchImpl, now: () => time }), 'session', { cookie });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.data.expiresAt, 1700000000000 + 30 * 86400000);
  const newCookie = cookieFrom(refreshed, sessionName);
  assert.ok(!newCookie.includes('rotated-refresh-token'));
  const again = fakeGoogle();
  await request(createGoogleWebHandler({ env, fetchImpl: again.fetchImpl, now: () => time }), 'session', { cookie: newCookie });
  assert.equal(new URLSearchParams(again.calls[0].init.body).get('refresh_token'), 'rotated-refresh-token');
});

test('POST actions reject missing/foreign Origin, missing custom header and wrong content type', async () => {
  for (const action of ['drive', 'disconnect']) {
    for (const headers of [{ origin: '' }, { origin: 'https://evil.example.com' }, { origin: `${ORIGIN}/` }, { 'x-michi-request': '' }, { 'content-type': 'text/plain' }]) {
      const google = fakeGoogle();
      const result = await request(createGoogleWebHandler({ env, fetchImpl: google.fetchImpl }), action, { headers, body: listInput() });
      assert.ok([400, 403].includes(result.status));
      assert.equal(google.calls.length, 0);
      assert.equal(cookies(result).length, 0);
    }
  }
});

test('Drive proxy permits appData requests only and keeps bearer tokens on the server', async () => {
  const google = fakeGoogle();
  const handler = createGoogleWebHandler({ env, fetchImpl: google.fetchImpl });
  const { cookie } = await login(handler);
  const result = await request(handler, 'drive', { cookie, body: listInput() });
  assert.deepEqual(result.data, { ok: true, data: { status: 200, text: '{"files":[]}' } });
  assert.equal(google.calls.at(-1).init.headers.Authorization, `Bearer ${ACCESS}`);
  assert.equal(google.calls.at(-1).init.redirect, 'error');
  noSecrets(result);
  for (const body of [{ url: 'https://evil.example.com/drive/v3/files' }, { url: 'https://www.googleapis.com/drive/v3/files' }, { url: 'https://www.googleapis.com/drive/v3/files/a?alt=media', options: { method: 'DELETE' } }]) {
    const count = google.calls.length;
    const rejected = await request(handler, 'drive', { cookie, body });
    assert.equal(rejected.status, 400);
    assert.equal(google.calls.length, count);
  }
});

test('Drive provider error bodies are sanitized and transient errors retain the session', async () => {
  const initial = fakeGoogle();
  const { cookie } = await login(createGoogleWebHandler({ env, fetchImpl: initial.fetchImpl }));
  for (const status of [401, 403, 429, 503]) {
    const google = fakeGoogle({ driveStatus: status, driveText: CLIENT_SECRET });
    const result = await request(createGoogleWebHandler({ env, fetchImpl: google.fetchImpl }), 'drive', { cookie, body: listInput() });
    noSecrets(result);
    if (status === 401) {
      assert.equal(result.status, 401);
      assert.ok(hasClearedCookie(result, sessionName));
    } else if (status === 403) {
      assert.equal(result.status, 200);
      assert.equal(result.data.data.status, 403);
    } else {
      assert.equal(result.status, 503);
      assert.ok(!hasClearedCookie(result, sessionName));
    }
  }
});

test('Drive rejects a missing or different bound account before any external request', async () => {
  const initial = fakeGoogle();
  const { cookie } = await login(createGoogleWebHandler({ env, fetchImpl: initial.fetchImpl }));
  for (const account of [undefined, '', 'another-account', { sub: user.sub }]) {
    const google = fakeGoogle();
    const body = { ...listInput(), account };
    const result = await request(createGoogleWebHandler({ env, fetchImpl: google.fetchImpl }), 'drive', { cookie, body });
    assert.equal(result.status, 401);
    assert.equal(result.data.code, 'AUTH_REQUIRED');
    assert.equal(google.calls.length, 0);
    assert.ok(hasClearedCookie(result, sessionName));
    noSecrets(result);
  }
});

test('disconnect only clears browser cookies and never revokes the Google project grant', async () => {
  const google = fakeGoogle();
  const result = await request(createGoogleWebHandler({ env, fetchImpl: google.fetchImpl }), 'disconnect');
  assert.equal(result.status, 200);
  assert.equal(result.data.data.connected, false);
  assert.ok(hasClearedCookie(result, sessionName));
  assert.ok(hasClearedCookie(result, stateName));
  assert.equal(google.calls.length, 0);
});

test('invalid or oversized request bodies, duplicate actions and incorrect methods fail safely', async () => {
  const google = fakeGoogle();
  const handler = createGoogleWebHandler({ env, fetchImpl: google.fetchImpl });
  for (const options of [{ raw: '{' }, { raw: '[]' }, { raw: 'x'.repeat(200000) }, { parsedBody: { value: 'x'.repeat(200000) } }, { headers: { 'content-length': '200000' } }]) {
    const result = await request(handler, 'disconnect', options);
    assert.equal(result.status, 400);
    assert.equal(cookies(result).length, 0);
  }
  assert.equal((await request(handler, 'session', { query: '&action=disconnect' })).status, 400);
  const method = await request(handler, 'disconnect', { method: 'GET' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, 'POST');
  assert.equal(google.calls.length, 0);
});

test('configuration errors are safe, HTTPS is required except loopback development', async () => {
  for (const modified of [{ APP_ORIGIN: 'http://todo.example.com' }, { APP_ORIGIN: `${ORIGIN}/path` }, { APP_ORIGIN: `${ORIGIN}/` }, { GOOGLE_SESSION_SECRET: 'bad-key' }, { GOOGLE_WEB_CLIENT_SECRET: '' }]) {
    const result = await request(createGoogleWebHandler({ env: { ...env, ...modified }, fetchImpl: fakeGoogle().fetchImpl }), 'session');
    assert.equal(result.status, 503);
    noSecrets(result);
  }
  const local = await request(createGoogleWebHandler({ env: { ...env, APP_ORIGIN: 'http://localhost:3000' }, fetchImpl: fakeGoogle().fetchImpl }), 'start');
  assert.equal(local.status, 303);
  assert.ok(cookies(local)[0].startsWith('michi-oauth='));
  assert.ok(!cookies(local)[0].includes('; Secure'));
});

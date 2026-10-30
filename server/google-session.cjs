'use strict';

const crypto = require('node:crypto');
const { validateRequest, driveRequest } = require('../src/desktop/drive-proxy.cjs');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const SCOPES = `${DRIVE_SCOPE} openid email`;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_MS = 10 * 60 * 1000;
const MAX_BODY = 192 * 1024;
const MAX_COOKIE = 3900;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const ERRORS = Object.freeze({
  AUTH_REQUIRED: 'Google に再接続してください。',
  INVALID_STATE: '認証を確認できませんでした。アプリから接続をやり直してください。',
  INVALID_REQUEST: 'リクエストが不正です。',
  FORBIDDEN: 'このリクエストは許可されていません。',
  NOT_FOUND: '接続先が見つかりません。',
  METHOD_NOT_ALLOWED: 'この操作は許可されていません。',
  TEMPORARY_UNAVAILABLE: 'Google 接続を利用できません。しばらくしてから再試行してください。',
});

class RequestError extends Error {
  constructor(code, status, clearSession = false) {
    super(ERRORS[code]);
    this.code = code;
    this.status = status;
    this.clearSession = clearSession;
  }
}
const authRequired = () => new RequestError('AUTH_REQUIRED', 401, true);
const unavailable = () => new RequestError('TEMPORARY_UNAVAILABLE', 503);
const invalidRequest = () => new RequestError('INVALID_REQUEST', 400);

function configuration(env) {
  const origin = String(env.APP_ORIGIN || '').trim();
  const url = new URL(origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw unavailable();
  const clientId = String(env.GOOGLE_WEB_CLIENT_ID || '').trim();
  const clientSecret = String(env.GOOGLE_WEB_CLIENT_SECRET || '').trim();
  const encodedKey = String(env.GOOGLE_SESSION_SECRET || '').trim();
  const key = Buffer.from(encodedKey, 'base64');
  if (!clientId || clientId.length > 256 || !clientSecret || clientSecret.length > 4096 || key.length !== 32 || key.toString('base64') !== encodedKey) throw unavailable();
  const secure = url.protocol === 'https:';
  const prefix = secure ? '__Host-' : '';
  return { origin, clientId, clientSecret, key, secure,
    sessionName: `${prefix}michi-session`, stateName: `${prefix}michi-oauth`,
    redirectUri: `${origin}/api/google?action=callback` };
}

function header(req, name) {
  const value = req.headers?.[name.toLowerCase()];
  return typeof value === 'string' ? value : '';
}
function readCookie(req, name) {
  const raw = header(req, 'cookie');
  if (raw.length > 16384) return null;
  const values = raw.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : null;
}
function boundedString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function hasDriveScope(scope) {
  return typeof scope === 'string' && scope.length <= 2048 && scope.split(/\s+/).includes(DRIVE_SCOPE);
}
function validIdentity(value) {
  return value && boundedString(value.sub, 255) && boundedString(value.email, 320) && /^[^\s@]+@[^\s@]+$/.test(value.email);
}
function constantEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function readBody(req) {
  const contentLength = header(req, 'content-length');
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY)) throw invalidRequest();
  let raw;
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) raw = req.body.toString('utf8');
    else if (typeof req.body === 'string') raw = req.body;
    else {
      try { raw = JSON.stringify(req.body); } catch { throw invalidRequest(); }
    }
  } else {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY) throw invalidRequest();
      chunks.push(buffer);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BODY) throw invalidRequest();
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidRequest();
    return body;
  } catch { throw invalidRequest(); }
}

/** Node/Vercel handler. Secrets and refresh tokens stay inside this process or encrypted cookies. */
function createGoogleWebHandler({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let config;
  try { config = configuration(env); } catch { /* Report only a fixed configuration error. */ }

  function seal(purpose, payload) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', config.key, iv);
    cipher.setAAD(Buffer.from(`michi:v1:${purpose}:${config.origin}:${config.clientId}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const value = `v1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
    if (value.length > MAX_COOKIE - 160) throw unavailable();
    return value;
  }
  function unseal(purpose, value, lifetime) {
    if (typeof value !== 'string' || value.length > MAX_COOKIE || !/^v1\.[A-Za-z0-9_-]+$/.test(value)) return null;
    try {
      const bytes = Buffer.from(value.slice(3), 'base64url');
      if (bytes.length < 29 || bytes.toString('base64url') !== value.slice(3)) return null;
      const decipher = crypto.createDecipheriv('aes-256-gcm', config.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      decipher.setAAD(Buffer.from(`michi:v1:${purpose}:${config.origin}:${config.clientId}`));
      const payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
      if (!Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now() || payload.expiresAt > now() + lifetime) return null;
      return payload;
    } catch { return null; }
  }
  function cookie(res, name, value, expiresAt) {
    const age = value ? Math.max(0, Math.ceil((expiresAt - now()) / 1000)) : 0;
    const line = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${config.secure ? '; Secure' : ''}`;
    if (Buffer.byteLength(line) >= 4096) throw unavailable();
    const previous = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...(Array.isArray(previous) ? previous : previous ? [previous] : []), line]);
  }
  function clearSession(res) { cookie(res, config.sessionName, '', 0); }
  function clearState(res) { cookie(res, config.stateName, '', 0); }
  function saveSession(res, session) { cookie(res, config.sessionName, seal('session', session), session.expiresAt); }
  function loadSession(req) {
    const session = unseal('session', readCookie(req, config.sessionName), SESSION_MS);
    if (!session || session.clientId !== config.clientId || !boundedString(session.refreshToken, 2048) || !hasDriveScope(session.scope) || !validIdentity(session.identity)) return null;
    return session;
  }
  function json(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }
  function redirect(res, location) {
    res.statusCode = 303;
    res.setHeader('Location', location);
    res.end();
  }
  async function googleJson(url, options) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
    } catch { throw unavailable(); }
    let value;
    try {
      const raw = await response.text();
      if (raw.length > 65536) throw unavailable();
      value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
    } catch { throw unavailable(); }
    if (!response.ok) {
      if (response.status === 401 || value.error === 'invalid_grant') throw authRequired();
      throw unavailable();
    }
    return value;
  }
  async function tokenRequest(params) {
    return googleJson(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: config.clientId, client_secret: config.clientSecret }).toString() });
  }
  async function credentials(tokens, previous) {
    if (!boundedString(tokens.access_token, 8192) || String(tokens.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw authRequired();
    const scope = tokens.scope === undefined ? previous?.scope : tokens.scope;
    const refreshToken = tokens.refresh_token === undefined ? previous?.refreshToken : tokens.refresh_token;
    if (!hasDriveScope(scope) || !boundedString(refreshToken, 2048)) throw authRequired();
    const user = await googleJson(USERINFO_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const identity = { sub: user.sub, email: user.email };
    if (user.email_verified !== true || !validIdentity(identity) || (previous && identity.sub !== previous.identity.sub)) throw authRequired();
    return { accessToken: tokens.access_token, refreshToken, identity, scope };
  }
  async function refresh(session, res) {
    const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refreshToken });
    const current = await credentials(tokens, session);
    const updated = { ...session, refreshToken: current.refreshToken, identity: current.identity, scope: current.scope };
    // Preserve the original absolute expiration instead of extending a stolen cookie indefinitely.
    if (current.refreshToken !== session.refreshToken || current.identity.email !== session.identity.email || current.scope !== session.scope) saveSession(res, updated);
    return { accessToken: current.accessToken, session: updated };
  }
  function requirePost(req) {
    if (header(req, 'origin') !== config.origin || header(req, 'x-michi-request') !== '1') throw new RequestError('FORBIDDEN', 403);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(header(req, 'content-type'))) throw invalidRequest();
  }

  return async function googleWebHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    try {
      if (!config || typeof fetchImpl !== 'function') throw unavailable();
      const url = new URL(req.url, config.origin);
      const actions = url.searchParams.getAll('action');
      if (actions.length !== 1) throw invalidRequest();
      const action = actions[0];
      if (!['start', 'callback', 'session', 'drive', 'disconnect'].includes(action)) throw new RequestError('NOT_FOUND', 404);
      const method = ['drive', 'disconnect'].includes(action) ? 'POST' : 'GET';
      if (req.method !== method) {
        res.setHeader('Allow', method);
        throw new RequestError('METHOD_NOT_ALLOWED', 405);
      }
      if (method === 'POST') requirePost(req);

      if (action === 'start') {
        const state = crypto.randomBytes(32).toString('base64url');
        const verifier = crypto.randomBytes(32).toString('base64url');
        const expiresAt = now() + STATE_MS;
        cookie(res, config.stateName, seal('state', { state, verifier, expiresAt }), expiresAt);
        const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        auth.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri,
          response_type: 'code', scope: SCOPES, access_type: 'offline', prompt: 'consent select_account', state,
          code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
        return redirect(res, auth.href);
      }
      if (action === 'callback') {
        clearState(res);
        const saved = unseal('state', readCookie(req, config.stateName), STATE_MS);
        const states = url.searchParams.getAll('state');
        const codes = url.searchParams.getAll('code');
        if (!saved || states.length !== 1 || !constantEqual(saved.state, states[0]) || !boundedString(saved.verifier, 128) || codes.length !== 1 || !boundedString(codes[0], 4096) || url.searchParams.has('error')) throw new RequestError('INVALID_STATE', 400);
        const tokens = await tokenRequest({ grant_type: 'authorization_code', code: codes[0], redirect_uri: config.redirectUri, code_verifier: saved.verifier });
        const current = await credentials(tokens);
        saveSession(res, { clientId: config.clientId, refreshToken: current.refreshToken, identity: current.identity, scope: current.scope, expiresAt: now() + SESSION_MS });
        return redirect(res, '/');
      }
      if (action === 'disconnect') {
        await readBody(req);
        clearSession(res);
        clearState(res);
        return json(res, 200, { ok: true, data: { connected: false } });
      }

      const session = loadSession(req);
      if (action === 'session') {
        if (!session) {
          if (readCookie(req, config.sessionName)) clearSession(res);
          return json(res, 200, { ok: true, data: { connected: false, identity: null, account: null, expiresAt: null } });
        }
        const current = await refresh(session, res);
        return json(res, 200, { ok: true, data: { connected: true, identity: current.session.identity, account: current.session.identity.email, expiresAt: current.session.expiresAt } });
      }
      const input = await readBody(req);
      try { validateRequest(input); } catch { throw invalidRequest(); }
      if (!session) throw authRequired();
      // Cookies are shared across tabs. A later OAuth callback must never switch
      // the destination of a cache that this tab already bound to another sub.
      if (input.account !== session.identity.sub) throw authRequired();
      const current = await refresh(session, res);
      let result;
      try { result = await driveRequest(input, async () => current.accessToken, fetchImpl); } catch { throw unavailable(); }
      if (result.status === 401) throw authRequired();
      if (result.status === 429 || result.status >= 500) throw unavailable();
      if (result.status < 200 || result.status >= 300) result.text = JSON.stringify({ error: { message: 'Google Drive の操作を完了できませんでした。' } });
      return json(res, 200, { ok: true, data: result });
    } catch (error) {
      const safe = error instanceof RequestError ? error : unavailable();
      if (config && safe.clearSession) clearSession(res);
      return json(res, safe.status, { ok: false, error: ERRORS[safe.code], code: safe.code });
    }
  };
}

module.exports = { createGoogleWebHandler };

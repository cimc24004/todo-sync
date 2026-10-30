'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_ERROR = Symbol('authError');
function authError(code, message) { return Object.assign(new Error(message), { code, [AUTH_ERROR]: true }); }
async function tokenExchangeError(response) {
  let data;
  try { data = await response.json(); } catch (_) { /* Error bodies need not be JSON. */ }
  if (data?.error === 'invalid_request' &&
      typeof data.error_description === 'string' && /^client_secret is missing\.?$/i.test(data.error_description.trim()))
    return authError('AUTH_CLIENT_SECRET_REQUIRED', 'Desktop OAuthクライアントのシークレットが未設定です。PC版の認証設定を確認してください。');
  const messages = {
    invalid_client: ['AUTH_INVALID_CLIENT', 'Desktop OAuthクライアントIDまたはクライアントシークレットが正しくありません。PC版の認証設定を確認してください。'],
    invalid_grant: ['AUTH_INVALID_GRANT', 'Googleの認証コードが無効または期限切れです。アプリから再接続してください。'],
    unauthorized_client: ['AUTH_UNAUTHORIZED_CLIENT', 'このOAuthクライアントではPC版の認証が許可されていません。デスクトップ アプリ用の設定を確認してください。'],
    redirect_uri_mismatch: ['AUTH_REDIRECT_MISMATCH', 'Googleの認証用リダイレクト先が一致しません。デスクトップ アプリ用のOAuthクライアントを確認してください。']
  };
  if (typeof data?.error === 'string' && Object.hasOwn(messages, data.error))
    return authError(...messages[data.error]);
  const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
    ? `（HTTP ${response.status}）` : '';
  return authError('AUTH_EXCHANGE_FAILED', `Google認証のトークン取得に失敗しました${status}。アプリから再接続してください。`);
}
function equalState(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
/** Access tokens stay in main memory; an optional encrypted store retains refresh credentials. */
function createGoogleAuth({ clientId, clientSecret = '', tokenStore = null, openExternal, fetchImpl = globalThis.fetch,
  timeoutMs = 180000, now = Date.now, randomBytes = crypto.randomBytes,
  createServer = http.createServer } = {}) {
  let token = null, active = null, credentials = null, credentialsLoaded = false;
  let generation = 0, refreshing = null, disposed = false, storageQueue = Promise.resolve();
  const status = () => ({ connected: Boolean(token && token.expiresAt > now() + 30000),
    expiresAt: token?.expiresAt ?? null, scope: token?.scope ?? '', identity: token?.identity ? { ...token.identity } : null });
  const cancelled = () => authError('AUTH_CANCELLED', 'Google接続をキャンセルしました。');
  function assertCurrent(epoch) { if (disposed || epoch !== generation) throw cancelled(); }
  function validateEnvironment() {
    if (disposed) throw cancelled();
    if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId || '') || typeof clientSecret !== 'string')
      throw authError('AUTH_NOT_CONFIGURED', 'Desktop OAuthクライアントの設定を確認してください。');
    if (typeof fetchImpl !== 'function' || (tokenStore && ['load', 'save', 'clear'].some(key => typeof tokenStore[key] !== 'function')))
      throw authError('AUTH_NOT_CONFIGURED', '認証の実行環境が未設定です。');
  }
  function storeOperation(method, value, epoch) {
    if (!tokenStore) return Promise.resolve(method === 'load' ? null : undefined);
    const work = storageQueue.then(async () => {
      if (epoch !== undefined) assertCurrent(epoch);
      try { return await tokenStore[method](value); }
      catch (_) { throw authError('AUTH_STORAGE', 'Google接続情報を安全に読み書きできません。アプリを再起動して接続してください。'); }
    });
    storageQueue = work.catch(() => {});
    return work;
  }
  function validIdentity(user) {
    return user && typeof user.sub === 'string' && user.sub.length > 0 && user.sub.length <= 255 &&
      typeof user.email === 'string' && user.email.length <= 320 && user.email.includes('@');
  }
  function validRefreshToken(value) { return typeof value === 'string' && value.length > 0 && value.length <= 8192; }
  function parseToken(data, fallbackScope = '') {
    const scope = typeof data?.scope === 'string' ? data.scope : fallbackScope;
    const scopes = scope.split(/\s+/);
    if (typeof data?.access_token !== 'string' || !data.access_token || data.access_token.length > 8192 ||
        !Number.isFinite(data.expires_in) || data.expires_in <= 30 ||
        String(data.token_type).toLowerCase() !== 'bearer' || !scopes.includes(DRIVE_SCOPE))
      throw authError('AUTH_INVALID_RESPONSE', '必要なGoogleドライブ権限を確認できませんでした。');
    return { accessToken: data.access_token, expiresAt: now() + data.expires_in * 1000, scope: scopes.join(' ') };
  }
  async function fetchIdentity(accessToken, signal) {
    const response = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
      signal, headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw authError('AUTH_IDENTITY_FAILED', '接続先のGoogleアカウントを確認できませんでした。');
    const user = await response.json();
    if (!validIdentity(user) || user.email_verified !== true)
      throw authError('AUTH_IDENTITY_FAILED', '接続先のGoogleアカウントを確認できませんでした。');
    return { sub: user.sub, email: user.email };
  }
  function cancel() {
    if (!active) return;
    generation++;
    refreshing?.abort.abort();
    active.finish(cancelled());
  }
  function invalidate() {
    generation++;
    active?.finish(cancelled());
    refreshing?.abort.abort();
    refreshing = null;
    token = null;
    credentials = null;
    credentialsLoaded = true;
  }
  async function disconnect() {
    invalidate();
    await storeOperation('clear');
    return status();
  }
  function dispose() { invalidate(); disposed = true; }
  function restore() {
    try { validateEnvironment(); } catch (error) { return Promise.reject(error); }
    if (status().connected) return Promise.resolve(status());
    if (active) return active.promise;
    if (refreshing) return refreshing.promise;
    const epoch = generation;
    const job = { abort: new AbortController(), promise: null };
    job.promise = Promise.resolve().then(async () => {
      try {
        if (!credentialsLoaded) {
          const saved = await storeOperation('load', undefined, epoch);
          assertCurrent(epoch);
          if (saved !== null && saved !== undefined &&
              (saved.clientId !== clientId || !validRefreshToken(saved.refreshToken) ||
               !validIdentity(saved.identity) || typeof saved.scope !== 'string' || !saved.scope.split(/\s+/).includes(DRIVE_SCOPE)))
            throw authError('AUTH_SAVED_CREDENTIAL_INVALID', '保存されたGoogle接続情報を確認できません。もう一度接続してください。');
          credentials = saved || null;
          credentialsLoaded = true;
        }
        if (!credentials) return status();
        const saved = credentials;
        const signal = AbortSignal.any([job.abort.signal, AbortSignal.timeout(30000)]);
        const response = await fetchImpl(TOKEN_URL, { method: 'POST', signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: clientId, refresh_token: saved.refreshToken,
            ...(clientSecret ? { client_secret: clientSecret } : {}), grant_type: 'refresh_token' }).toString() });
        assertCurrent(epoch);
        if (!response.ok) {
          const error = await tokenExchangeError(response); assertCurrent(epoch);
          if (error.code === 'AUTH_INVALID_GRANT') {
            credentials = null; token = null;
            await storeOperation('clear', undefined, epoch); assertCurrent(epoch);
            throw authError('AUTH_REQUIRED', 'Google接続の有効期限が切れました。もう一度接続してください。');
          }
          throw error;
        }
        const data = await response.json(); assertCurrent(epoch);
        const candidate = parseToken(data, saved.scope);
        const identity = await fetchIdentity(candidate.accessToken, signal); assertCurrent(epoch);
        if (identity.sub !== saved.identity.sub)
          throw authError('AUTH_IDENTITY_FAILED', '保存されたGoogleアカウントと接続先が一致しません。元のアカウントで接続してください。');
        if (data.refresh_token !== undefined && !validRefreshToken(data.refresh_token))
          throw authError('AUTH_INVALID_RESPONSE', 'Google接続の更新情報を確認できませんでした。');
        const next = { clientId, refreshToken: data.refresh_token || saved.refreshToken, identity, scope: candidate.scope };
        if (next.refreshToken !== saved.refreshToken || next.scope !== saved.scope || next.identity.email !== saved.identity.email) {
          await storeOperation('save', next, epoch); assertCurrent(epoch);
        }
        credentials = next;
        token = { ...candidate, identity };
        return status();
      } catch (error) {
        assertCurrent(epoch);
        throw error?.[AUTH_ERROR] === true ? error : authError('AUTH_NETWORK', 'Google接続で通信エラーが発生しました。通信が戻ると再試行します。');
      } finally { if (refreshing === job) refreshing = null; }
    });
    refreshing = job;
    return job.promise;
  }
  async function getAccessToken() {
    await restore();
    if (!status().connected) throw authError('AUTH_REQUIRED', 'Googleドライブに再接続してください。');
    return token.accessToken;
  }
  function connect() {
    if (active) return active.promise;
    try { validateEnvironment(); } catch (error) { return Promise.reject(error); }
    if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId || ''))
      return Promise.reject(authError('AUTH_NOT_CONFIGURED', 'Desktop OAuthクライアントIDを設定してください。'));
    if (typeof clientSecret !== 'string')
      return Promise.reject(authError('AUTH_NOT_CONFIGURED', 'Desktop OAuthクライアントシークレットの設定が不正です。'));
    if (typeof openExternal !== 'function' || typeof fetchImpl !== 'function')
      return Promise.reject(authError('AUTH_NOT_CONFIGURED', '認証の実行環境が未設定です。'));
    generation++;
    const epoch = generation;
    refreshing?.abort.abort();
    refreshing = null;
    token = null; // A new account selection must not keep an old usable session.
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const abort = new AbortController();
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const session = { promise, finished: false, exchanging: false, server: null, timer: null, finish: null };
    session.finish = (error, result) => {
      if (session.finished) return;
      session.finished = true;
      clearTimeout(session.timer);
      abort.abort();
      try { session.server?.close(); } catch (_) { /* Already closed. */ }
      if (active === session) active = null;
      if (error) reject(error); else resolve(result);
    };
    active = session;
    let redirectUri = '', expectedHost = '';
    const send = (res, code, body) => {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    };
    const handler = async (req, res) => {
      if (session.finished) return send(res, 410, '認証は終了しています。');
      if (req.method !== 'GET' || req.headers.host !== expectedHost)
        return send(res, 400, '無効なリクエストです。');
      let url;
      try { url = new URL(req.url, redirectUri); } catch (_) { return send(res, 400, '無効なURLです。'); }
      if (url.origin !== `http://${expectedHost}` || url.pathname !== '/oauth2/callback')
        return send(res, 404, 'Not found');
      if (url.searchParams.getAll('state').length !== 1 || !equalState(url.searchParams.get('state'), state))
        return send(res, 400, '認証状態が一致しません。元のブラウザで操作を続けてください。');
      if (session.exchanging) return send(res, 409, '認証を処理中です。');
      if (url.searchParams.has('error')) {
        send(res, 400, 'Google接続は許可されませんでした。アプリに戻ってください。');
        return session.finish(authError('AUTH_DENIED', 'Google接続が許可されませんでした。'));
      }
      const code = url.searchParams.get('code');
      if (url.searchParams.getAll('code').length !== 1 || !code || code.length > 4096)
        return send(res, 400, '認証コードがありません。');
      session.exchanging = true;
      try {
        const response = await fetchImpl(TOKEN_URL, { method: 'POST', signal: abort.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: clientId, code, code_verifier: verifier,
            ...(clientSecret ? { client_secret: clientSecret } : {}),
            grant_type: 'authorization_code', redirect_uri: redirectUri }).toString() });
        if (!response.ok) throw await tokenExchangeError(response);
        const data = await response.json();
        if (session.finished) return send(res, 410, '認証は終了しています。');
        assertCurrent(epoch);
        const candidate = parseToken(data);
        const identity = await fetchIdentity(candidate.accessToken, abort.signal);
        if (session.finished) return send(res, 410, '認証は終了しています。');
        assertCurrent(epoch);
        if (tokenStore) {
          if (!validRefreshToken(data.refresh_token))
            throw authError('AUTH_REFRESH_REQUIRED', 'Google接続を保持するための許可を取得できませんでした。もう一度接続してください。');
          const saved = { clientId, refreshToken: data.refresh_token, identity, scope: candidate.scope };
          await storeOperation('save', saved, epoch);
          if (session.finished) return send(res, 410, '認証は終了しています。');
          assertCurrent(epoch);
          credentials = saved;
          credentialsLoaded = true;
        }
        token = { ...candidate, identity };
        send(res, 200, 'Googleドライブに接続しました。このタブを閉じてアプリに戻ってください。');
        session.finish(null, status());
      } catch (error) {
        if (!session.finished) {
          const safeError = error?.[AUTH_ERROR] === true ? error
            : authError('AUTH_NETWORK', 'Google接続で通信エラーが発生しました。');
          send(res, 502, `${safeError.message}\nアプリに戻って、設定を確認してから再接続してください。`);
          session.finish(safeError);
        } else if (!res.writableEnded) send(res, 410, '認証は終了しています。');
      }
    };
    session.timer = setTimeout(() => session.finish(authError('AUTH_TIMEOUT', 'Google接続が時間切れになりました。')), timeoutMs);
    session.timer.unref?.();
    try {
      session.server = createServer(handler);
      session.server.on('error', () => session.finish(authError('AUTH_LISTEN_FAILED', '認証用のローカル接続を開始できませんでした。')));
      session.server.listen(0, '127.0.0.1', async () => {
        if (session.finished) { try { session.server.close(); } catch (_) {} return; }
        const port = session.server.address()?.port;
        if (!Number.isInteger(port) || port < 1 || port > 65535)
          return session.finish(authError('AUTH_LISTEN_FAILED', '認証用ポートが無効です。'));
        expectedHost = `127.0.0.1:${port}`;
        redirectUri = `http://${expectedHost}/oauth2/callback`;
        const url = new URL(AUTH_URL);
        url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri,
          response_type: 'code', scope: `${DRIVE_SCOPE} openid email`, state, code_challenge: challenge,
          code_challenge_method: 'S256', access_type: tokenStore ? 'offline' : 'online',
          prompt: tokenStore ? 'consent select_account' : 'select_account' }).toString();
        try { await openExternal(url.toString()); }
        catch (_) { session.finish(authError('AUTH_BROWSER_FAILED', '標準ブラウザを開けませんでした。')); }
      });
    } catch (_) { session.finish(authError('AUTH_LISTEN_FAILED', '認証を開始できませんでした。')); }
    return promise;
  }
  return { connect, restore, getAccessToken, disconnect, dispose, cancel, status };
}
module.exports = { createGoogleAuth, DRIVE_SCOPE, equalState };

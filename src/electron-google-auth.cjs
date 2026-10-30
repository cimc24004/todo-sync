'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
function authError(code, message) { return Object.assign(new Error(message), { code }); }
function equalState(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
/** Tokens live only in main-process memory. Never log tokens or return them from status/connect. */
function createGoogleAuth({ clientId, openExternal, fetchImpl = globalThis.fetch,
  timeoutMs = 180000, now = Date.now, randomBytes = crypto.randomBytes,
  createServer = http.createServer } = {}) {
  let token = null, active = null;
  const status = () => ({ connected: Boolean(token && token.expiresAt > now() + 30000),
    expiresAt: token?.expiresAt ?? null, scope: token?.scope ?? '', identity: token?.identity ? { ...token.identity } : null });
  function cancel() { active?.finish(authError('AUTH_CANCELLED', 'Google接続をキャンセルしました。')); }
  function disconnect() { cancel(); token = null; return status(); }
  function getAccessToken() {
    if (!status().connected) { token = null; throw authError('AUTH_REQUIRED', 'Googleドライブに再接続してください。'); }
    return token.accessToken;
  }
  function connect() {
    if (active) return active.promise;
    if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId || ''))
      return Promise.reject(authError('AUTH_NOT_CONFIGURED', 'Desktop OAuthクライアントIDを設定してください。'));
    if (typeof openExternal !== 'function' || typeof fetchImpl !== 'function')
      return Promise.reject(authError('AUTH_NOT_CONFIGURED', '認証の実行環境が未設定です。'));
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
            grant_type: 'authorization_code', redirect_uri: redirectUri }).toString() });
        if (!response.ok) throw authError('AUTH_EXCHANGE_FAILED', 'Google認証を完了できませんでした。再接続してください。');
        const data = await response.json();
        if (session.finished) return send(res, 410, '認証は終了しています。');
        const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/) : [];
        if (typeof data.access_token !== 'string' || !data.access_token ||
            !Number.isFinite(data.expires_in) || data.expires_in <= 30 ||
            String(data.token_type).toLowerCase() !== 'bearer' || !scopes.includes(DRIVE_SCOPE))
          throw authError('AUTH_INVALID_RESPONSE', '必要なGoogleドライブ権限を確認できませんでした。');
        const identityResponse = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
          signal: abort.signal, headers: { Authorization: `Bearer ${data.access_token}` } });
        if (!identityResponse.ok) throw authError('AUTH_IDENTITY_FAILED', '接続先のGoogleアカウントを確認できませんでした。');
        const user = await identityResponse.json();
        if (session.finished) return send(res, 410, '認証は終了しています。');
        if (typeof user.sub !== 'string' || !user.sub || user.sub.length > 255 ||
            typeof user.email !== 'string' || user.email.length > 320 || !user.email.includes('@') || user.email_verified !== true)
          throw authError('AUTH_IDENTITY_FAILED', '接続先のGoogleアカウントを確認できませんでした。');
        token = { accessToken: data.access_token, expiresAt: now() + data.expires_in * 1000,
          scope: scopes.join(' '), identity: { sub: user.sub, email: user.email } };
        // Deliberately ignore refresh_token: no credentials persist to disk.
        send(res, 200, 'Googleドライブに接続しました。このタブを閉じてアプリに戻ってください。');
        session.finish(null, status());
      } catch (error) {
        if (!session.finished) {
          send(res, 502, '認証を完了できませんでした。アプリで再接続してください。');
          session.finish(error.code?.startsWith('AUTH_') ? error : authError('AUTH_NETWORK', 'Google接続で通信エラーが発生しました。'));
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
          code_challenge_method: 'S256', access_type: 'online', prompt: 'select_account' }).toString();
        try { await openExternal(url.toString()); }
        catch (_) { session.finish(authError('AUTH_BROWSER_FAILED', '標準ブラウザを開けませんでした。')); }
      });
    } catch (_) { session.finish(authError('AUTH_LISTEN_FAILED', '認証を開始できませんでした。')); }
    return promise;
  }
  return { connect, getAccessToken, disconnect, cancel, status };
}
module.exports = { createGoogleAuth, DRIVE_SCOPE, equalState };

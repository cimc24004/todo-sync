'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Read only in Electron's main process, outside the source tree and Web bundle.
function loadDesktopClientSecret(userData, clientId) {
  const file = path.join(userData, 'google-desktop-client.json');
  let credentials;
  try {
    if (fs.statSync(file).size > 64 * 1024) throw new Error('oversized');
    credentials = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new Error('PC版の認証情報JSONを読み込めません。Google Cloudから取得したJSONを確認してください。');
  }
  const installed = credentials?.installed;
  if (!installed || installed.client_id !== clientId)
    throw new Error('PC版の認証情報JSONと設定済みのDesktopクライアントIDが一致しません。デスクトップ アプリ用のJSONを確認してください。');
  if (typeof installed.client_secret !== 'string' || !installed.client_secret.trim() || installed.client_secret.length > 4096)
    throw new Error('PC版の認証情報JSONにclient_secretがありません。Google CloudのDesktopクライアント設定を確認してください。');
  return installed.client_secret;
}

module.exports = { loadDesktopClientSecret };

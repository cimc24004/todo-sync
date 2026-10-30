# Web版のログイン保持

GitHub Pagesの静的版はGoogle Identity Servicesのアクセストークンをメモリだけに保持します。ブラウザを閉じてもログインを保持したい場合は、このリポジトリのWeb画面と `api/google.js` をVercelの同じoriginへ配置します。

## 配置

1. VercelへこのGitHubリポジトリをインポートする。Root Directoryはリポジトリ直下、FrameworkはOther、Node.jsは24.xを選ぶ。ビルドと出力先は `vercel.json` に定義済み。ビルド/APIはNode標準ライブラリのみを使い、Electronはサーバーへインストールしない。
2. 割り当てられた本番URLを確認する。Google CloudのWeb OAuthクライアントに、そのoriginを「承認済みのJavaScript生成元」、`https://実際のホスト/api/google?action=callback` を「承認済みのリダイレクトURI」として登録する。実際の本番URLと完全一致させる。
3. 下記の環境変数をVercelのProductionに設定する。secretの2項目にはSensitiveを使用し、コード・Actions変数・静的ファイルには入れない。
4. 再デプロイ後、公開URLでGoogle接続を行い、同期を確認する。その後にページを開き直し、認証画面なしで接続が復元されることを確認する。

| 環境変数 | 値 |
| --- | --- |
| `GOOGLE_WEB_AUTH_MODE` | `server` |
| `GOOGLE_WEB_CLIENT_ID` | Web OAuthクライアントの公開ID |
| `GOOGLE_WEB_CLIENT_SECRET` | 同じWeb OAuthクライアントのJSONにある `web.client_secret` |
| `GOOGLE_SESSION_SECRET` | 暗号学的乱数32バイトのBase64表現（例の固定値は使わない） |
| `APP_ORIGIN` | 実際の本番origin。HTTPS、末尾の `/` なし |

プレビュー環境へ本番secretをコピーする必要はありません。別環境で認証を使う場合は、その環境の固定originとGoogleの登録URIを明示します。ローカル開発ではlocalhostのHTTPを受け付けます。

## 動作

- OAuth authorization code + PKCEで接続する。クライアントsecretとトークン交換はサーバー内だけで行う。
- リフレッシュトークン・GoogleアカウントID・期限をAES-256-GCMで暗号化したHttpOnly/Secure/SameSite=Lax Cookieに保持する。JavaScriptへGoogleトークンを返さない。
- セッションは最大30日。Google Auth PlatformがExternal/Testingの場合、Driveスコープのリフレッシュトークンは通常7日で期限切れになる。取消・失効時には再接続する。
- Driveへの送信はアプリ専用領域の操作だけを許可し、Originと専用ヘッダー、キャッシュに紐づくアカウントIDを検査する。別アカウントへの切替によってタスクが混ざるのを防ぐ。
- 「切断」はこのブラウザのCookieを消す。Desktop側の接続を巻き込まないよう、Googleプロジェクト全体の権限取消は行わない。
- `GOOGLE_SESSION_SECRET` を変更すると既存セッションが無効になる。復号できない場合は再接続が必要。
- 認証APIには `no-store` を指定し、service workerでもキャッシュしない。

GitHub PagesとVercelは異なるoriginなので、端末内キャッシュは別々です。旧URLに未同期タスクがある場合は、旧URLでDrive同期を完了してから新URLへ移行してください。Desktopの保存先は変わりません。

参考: [Google OAuth code model](https://developers.google.com/identity/oauth2/web/guides/use-code-model)、[Google refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)、[Vercel Functions](https://vercel.com/docs/functions/runtimes/node-js)。

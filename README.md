# Michi ToDo

日本語のToDoアプリ。静的Web/PWAとElectron版で共通の画面を使い、Google Driveの**アプリ専用領域（appDataFolder）**へ操作JSONを同期する構成です。通常の「マイドライブ」にはJSONは表示されません。

## 現在の状態
- 実装済み：タスク追加・編集・完了、締切日、優先度、メモ、検索、並び替え、ごみ箱復元。
- Web版：レスポンシブ、オフライン保存、ホーム画面追加向けmanifest/service worker。公開先は https://cimc24004.github.io/todo-sync/ 。
- Electron版：トレイ、Ctrl+Shift+Spaceのクイック追加、最前面の今日のミニウィンドウ、任意の通知・任意の自動起動。
- Desktop版は実アカウントのGoogleログインとDriveへのタスク送信・読み戻しを確認済み。起動時の自動接続に対応。Webのログイン保持には下記のサーバー構成を使います。
- PC/Web共通の生成アイコン、操作音のオン・オフ、追加・完了時のアニメーションに対応。
- クライアントIDが空でもオフラインで使えます。同期済みと偽って表示しません。
- Windowsでの開発版起動と暗号化保存は確認済み。通知の実配信、Windows自動起動、スマホでのPWAインストールは未検証。

## 開発とビルド
Node.js 24.15以上を推奨します（テスト用jsdomの要件を含む）。

```sh
npm ci
npm test
npm start
npm run build:win
```

Webとして使う場合は `npm run build:web` で生成した `dist/web/` だけをHTTPSのホスティングへ配置します。HTMLをfile://で直接開く使い方は対象外です。
Windowsビルド設定はx64 portable、署名なしです。ビルド成果物が無い場合に完成済みexeと扱わないでください。
アプリの変更完了時は毎回 `npm run build:win` を実行し、`dist/Michi-ToDo-1.0.0-Windows-x64.exe` を更新します。開発版とexe版は同じ `%APPDATA%\michi-todo` のタスク・接続設定を使用します。

## Google Driveの設定（所有者が行う手順）
1. 使用するGoogleアカウントでGoogle Cloudプロジェクトを作る。同じプロジェクトでDrive APIを有効にする。
2. Google Auth Platformでアプリ名・連絡先・対象ユーザーを設定。個人テストならExternal/Testingとし、自分をテストユーザーへ追加する。アプリを一般公開する必要はありません。
3. 使用スコープは `https://www.googleapis.com/auth/drive.appdata` と、接続先確認用の `openid email`。既存Drive全体への権限は不要です。
4. Web application型OAuthクライアントを作り、実際に使う静的サイトのoriginをAuthorized JavaScript originsへ登録。localhost開発用も使う場合はそのoriginを明記する。ドメイン未決定のまま架空のoriginを登録しない。
5. 下記の `.env` に Web 型の公開クライアントIDを設定する。静的Web版では client secret は不要。サーバーでログインを保持する構成ではサーバーの環境変数にだけ設定し、**Webコードへ置かない**。
6. Desktop app型OAuthクライアントを同じプロジェクトに作り、`.env` の `GOOGLE_DESKTOP_CLIENT_ID` に設定する。Google側で `client_secret` が必要な場合は、そのDesktopクライアントの認証情報JSON（`installed.client_id` と `installed.client_secret` を含む）を、ElectronのuserDataフォルダーへ `google-desktop-client.json` として保存してアプリを再起動する。Windowsで `npm start` する場合の保存先は `%APPDATA%\michi-todo\google-desktop-client.json`。このJSONはリポジトリ・Web配信先へ置かず、Electronのmainプロセスだけで読み込む。システムブラウザとPKCE、127.0.0.1の一時的なloopback callbackを使う。
7. Web版とPC版で同じGoogleアカウントを選ぶ。初回は端末内のタスクを選んだアカウントに同期する確認が表示される。実際に保存され、別端末へ反映されるまで確認して初めて同期完了とする。

クライアントID自体は公開識別子で、アクセストークンではありません。Googleのパスワード、トークン、秘密鍵をリポジトリに追加しないでください。

## 保存と同期の動作
- Web：同一originのlocalStorageへ保存。複数タブの上書きを防ぐためWeb Locksで1タブに制限。最新の対応ブラウザが必要です。
- Electron：userData内 `operations.json`。一時ファイル→renameで保存、壊れたデータは上書きせずエラー表示。
- オフライン変更は未同期キューに残し、ログイン後の手動同期、変更時、フォーカス復帰、起動中1分間隔の同期で送信。
- GitHub Pagesなどの静的Web版：Googleアクセストークンはメモリのみ。ページを閉じた後・期限切れには再接続が必要。
- サーバー付きWeb版：Googleのリフレッシュトークンを暗号化したHttpOnly Cookieでログインを保持し、サーバーで更新する。JavaScriptやlocalStorageへトークンを渡さない。セッションは最長30日で、「切断」でCookieを削除する。Google側の期限・権限取消も適用される。[Vercel設定手順](docs/vercel.md)を参照。
- Electronは、初回接続時に取得したリフレッシュトークンをOSの暗号化機能でuserData内 `google-refresh-token.enc` に保存し、起動時とアクセストークン期限切れ時に自動更新する。アクセストークン自体はmainプロセスのメモリだけに保持し、限定したDriveリクエストだけを中継する。「切断」は保存した認証情報も削除する。既存の接続から移行する場合は、リフレッシュトークン取得のため一度だけ接続し直す。
- Google Auth PlatformがExternal/Testingの場合、Driveスコープを含むリフレッシュトークンは通常7日で期限切れになるため、その際は再接続が必要。アプリを閉じるたび・約1時間ごとの手動接続は不要になるが、権限取消やGoogle側の期限切れ時の再認証は必要。
- 別のGoogleアカウントへの切替は既存端末キャッシュに対して拒否し、誤ったアカウントへの送信を防ぎます。
- Google Driveへは不変の操作JSONを追加。複数端末で同じファイル全体を上書きせず、操作IDで重複排除してフィールド単位に決定的マージ。
- 同じ項目を同時に変更した場合、論理時計・端末ID・操作ID順の結果を表示。もう一方の操作は履歴JSONに残るものの、競合を選択する専用画面は未実装です。
- 削除は論理削除。古い端末の編集だけでは復活せず、明示的な復元で戻せます。
- 初期版はログを物理削除・圧縮しません。長期利用ではファイル数とAPI呼び出しが増えるため、現時点では個人の小規模利用向け。
- Webデータ消去・origin変更・PC保存先削除をすると、**未同期の変更は失われます**。同期を確認してから移行してください。

## PC専用機能
「PC機能」またはトレイメニューから操作します。ウィンドウを閉じるとトレイへ移動し、明示的な「終了」で終了します。
- Ctrl+Shift+Space：クイック追加（他アプリとの競合時は使用不可）
- 今日のミニウィンドウ：最前面・読み取り専用の今日/期限超過一覧
- 通知：初期OFF。期限日の前日09:00（PCのローカル時刻）に通知対象となる。起動が遅れたときは期限当日まで1回だけ追いつき通知。アプリ起動中のみ。通知の表示はOS設定にも依存。
- Windows自動起動：初期OFF、任意でON。OSによる実起動は未検証。

Web版にはバックグラウンド通知を実装していません。Googleカレンダーとの連携もありません。

## 操作音とアニメーション

タスク追加・編集などに短いクリック音、完了に確認音とメッセージを表示します。画面の「操作音オン／オフ」は端末ごとに保存されます。起動・自動同期では音を鳴らしません。OSの「視覚効果を減らす」設定ではアニメーションを抑えます。

効果音は [Kenney Interface Sounds](https://kenney.nl/assets/interface-sounds) のCC0素材です。[ライセンス](src/assets/sounds/LICENSE.txt)を同梱しています。アイコンは画像生成ツールで生成し、[生成記録](src/assets/README.md)にプロンプトと出力先を記載しています。

## 検証と制約
`npm test` は保存層、操作マージ、Desktop通知ロジック、OAuth状態/PKCE、暗号化保存、再接続・切断時の競合、サーバーセッションとDrive proxy制限、DOM上のUI操作を検証します。DOMテストは実ブラウザ画面の検証ではありません。
Google実アカウントでのDesktop接続・同期は確認済みです。ログイン保持機能の本番での長期利用、サーバー付きWeb版の公開先での認証は別途確認が必要です。

## セキュリティ
ElectronはcontextIsolation/sandbox有効、nodeIntegration無効。外部ナビゲーションを拒否。Googleログインだけをシステムブラウザで開きます。タスクはtextContent表示。CSPで接続先を限定。Service Workerはアプリの静的ファイルのみキャッシュし、Drive APIや認証データはキャッシュしません。

## 接続設定は .env で指定

リポジトリ直下で `.env.example` を `.env` にコピーし、発行した2つのIDだけを記入します（Windows PowerShell: `Copy-Item .env.example .env`）。

```dotenv
GOOGLE_WEB_CLIENT_ID=123-example-web.apps.googleusercontent.com
GOOGLE_DESKTOP_CLIENT_ID=123-example-desktop.apps.googleusercontent.com
```

- Web: `npm run build:web` → **dist/web だけ**を配信。`src` を直接配信しても .env は読まれません。静的サイトでは設定変更後に再ビルド・再配信します。
- Electron開発: `npm start` がプロジェクト直下の .env を読みます。
- Electron配布: `npm run build:win` が公開Desktop IDだけを生成設定へ保存します。**.env本体は同梱しません**。配布後は実行ファイルの隣の .env またはOS環境変数で上書きできます。
- 優先順: **OS環境変数 > .env > 配布時のDesktop ID > 空欄**。空欄を明示すると下位設定を使わず、未接続になります。Webには配布時Desktop IDのfallbackはありません。
- .env はGit対象外。`.env.example` のみ共有します。`src/config.js` / `src/google-config.json` を編集する旧手順は不要です。空欄ならオフラインで利用可能。形式不正は値をログに出さず設定エラーになります。
- 静的Web版にAPIキーやclient secretは不要。サーバー付きWeb版はサーバー環境変数、Desktop版はuserData内の認証JSONに必要なsecretを設定します。Web出力は公開Web IDと認証モードのみで、秘密の値・環境変数全体・Desktop IDは出力しません。
- Google側のOAuthクライアント作成、Drive API有効化、許可origin設定は .env では代替できません。

### GitHub Pages
`.github/workflows/pages.yml` を有効化済みです。PagesのソースをGitHub Actionsに設定し、Actions変数 `GOOGLE_WEB_CLIENT_ID` に現在のWebクライアントIDを登録します。originは `https://cimc24004.github.io`、配信パスは `/todo-sync/`。相対アセットURL・PWAの相対scopeを使用しています。GitHub Pagesにはサーバー機能がないため、ログイン保持を利用する場合は[Vercel設定手順](docs/vercel.md)で別の公開先を用意します。

# Michi ToDo

日本語のToDoアプリ。静的Web/PWAとElectron版で共通の画面を使い、Google Driveの**アプリ専用領域（appDataFolder）**へ操作JSONを同期する構成です。通常の「マイドライブ」にはJSONは表示されません。

## 現在の状態
- 実装済み：タスク追加・編集・完了、締切日、優先度、メモ、検索、並び替え、ごみ箱復元。
- Web版：レスポンシブ、オフライン保存、ホーム画面追加向けmanifest/service worker。
- Electron版：トレイ、Ctrl+Shift+Spaceのクイック追加、最前面の今日のミニウィンドウ、任意の通知・任意の自動起動。
- Drive同期コードとGoogleログインコードは実装。**OAuthクライアント設定・実アカウントログイン・実Drive同期・公開ホスティングは未完了／未検証**です。
- クライアントIDが空でもオフラインで使えます。同期済みと偽って表示しません。
- Windowsでの実起動、トレイ、通知、インストール、スマホでのPWAインストールは未検証。

## 開発とビルド
Node.js 22.13以上を使用します。

```sh
npm ci
npm test
npm start
npm run build:win
```

Webとして使う場合は `src/` の静的ファイルをHTTPSのホスティングへ配置します。HTMLをfile://で直接開く使い方は対象外です。公開はこのリポジトリを作るだけでは行われません。
Windowsビルド設定はx64 portable、署名なしです。ビルド成果物が無い場合に完成済みexeと扱わないでください。

## Google Driveの設定（所有者が行う手順）
1. 使用するGoogleアカウントでGoogle Cloudプロジェクトを作る。同じプロジェクトでDrive APIを有効にする。
2. Google Auth Platformでアプリ名・連絡先・対象ユーザーを設定。個人テストならExternal/Testingとし、自分をテストユーザーへ追加する。アプリを一般公開する必要はありません。
3. 使用スコープは `https://www.googleapis.com/auth/drive.appdata` と、接続先確認用の `openid email`。既存Drive全体への権限は不要です。
4. Web application型OAuthクライアントを作り、実際に使う静的サイトのoriginをAuthorized JavaScript originsへ登録。localhost開発用も使う場合はそのoriginを明記する。ドメイン未決定のまま架空のoriginを登録しない。
5. 下記の `.env` に Web 型の公開クライアントIDを設定する。**client secret は不要、Webコードへ置かない**。
6. Desktop app型OAuthクライアントを同じプロジェクトに作り、`.env` の `GOOGLE_DESKTOP_CLIENT_ID` に設定する。システムブラウザとPKCE、127.0.0.1の一時的なloopback callbackを使う。
7. Web版とPC版で同じGoogleアカウントを選ぶ。初回は端末内のタスクを選んだアカウントに同期する確認が表示される。実際に保存され、別端末へ反映されるまで確認して初めて同期完了とする。

クライアントID自体は公開識別子です。Googleのパスワード、トークン、秘密鍵をリポジトリに追加しないでください。配布前のGoogle設定は未実施です。

## 保存と同期の動作
- Web：同一originのlocalStorageへ保存。複数タブの上書きを防ぐためWeb Locksで1タブに制限。最新の対応ブラウザが必要です。
- Electron：userData内 `operations.json`。一時ファイル→renameで保存、壊れたデータは上書きせずエラー表示。
- オフライン変更は未同期キューに残し、ログイン後の手動同期、変更時、フォーカス復帰、起動中1分間隔の同期で送信。
- Googleアクセストークンはメモリのみ。アプリ終了後・期限切れには再接続が必要。Electronはトークンをmainプロセス内に保持し、限定したDriveリクエストだけを中継。
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

## 検証と制約
`npm test` は保存層、操作マージ、Desktop通知ロジック、OAuth状態/PKCE、Drive proxy制限、DOM上のUI操作を検証します。DOMテストは実ブラウザ画面の検証ではありません。
クラウドChromium起動はsandbox制限／環境起動エラーで失敗。Windowsネイティブ機能・Google本番接続の成功を主張しません。

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
- **APIキー・client secret・パスワード・アクセストークンは設定不要**。Web出力は GOOGLE_WEB_CLIENT_ID の1項目のみ。環境変数全体やDesktop IDは出力しません。OAuth ID自体は公開識別子で、Web閲覧者にも見えます。
- Google側のOAuthクライアント作成、Drive API有効化、許可origin設定は .env では代替できません。実アカウント接続は未検証です。

### GitHub Pages（未有効化の例）
`docs/github-pages.yml.example` は手動実行型の設定例です。公開承認後に `.github/workflows/pages.yml` にコピーし、PagesをGitHub Actionsに設定、Actions変数 `GOOGLE_WEB_CLIENT_ID` を登録します。例のoriginは `https://cimc24004.github.io`、配信パスは `/todo-sync/`。相対アセットURL・PWAの相対scopeを使用しています。現時点ではワークフローは有効化しておらず、サイトも公開していません。

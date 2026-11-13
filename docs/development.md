# 開発ガイド

keito を手元で動かす・直す・ビルドするための情報です。使い方は [使い方ガイド](guide.md) を見てください。

## コマンド

```bash
npm install
npm run dev      # http://localhost:5183
npm run build    # dist/ に静的ファイル（base は相対パス）
npm test         # テスト（コメントのピン留め・ラベル配置・表・YAML・削除したボードの復元など）
npm run app      # デスクトップアプリ（Tauri）を開発モードで起動（Rust が必要）
npm run app:build  # デスクトップアプリをビルド（src-tauri/target/release/bundle/ に .app と .dmg）
npm run app:release  # 署名・公証済みの .dmg を作る（人に配るとき。下の「配布用のビルド」）
npm run app:release:windows  # Windows 版のインストーラーを Mac でクロスビルドする（下の「Windows 版」）
npm run collab -- serve  # 共同編集サーバーを起動（下の「共有案件（試験中）」）
npx playwright test      # 2 つのブラウザで共有案件を確かめる E2E（初回は npx playwright install chromium）
```

## 構成

```
src/model/     データモデル・配線ルーティング・自動レイアウト・YAML・リスト生成・状態管理（UI 非依存）
src/canvas/    SVG 描画（画面とエクスポートで共通）とキャンバス操作
src/export/    PNG / SVG / PDF / Excel
src/ui/        ツールバー・インスペクタ・各パネル
src/platform/  保存先とファイル入出力の境界（ブラウザ版とデスクトップアプリで差し替える）
src/collab/    共有案件の Yjs のデータの形、保存確認のやり取り、共同編集サーバーへの接続、端末内の写し、共有中のボードの保存先
server/        ボードのフォルダの読み書き（store.ts: 開発サーバーと CLI で共通）と、開発サーバーの保存 API・変更通知
server/collab/ 共同編集サーバー（Hocuspocus）と、その SQLite の保存先・管理コマンド（npm run collab）
cli/           コマンドライン（npm run keito）
e2e/           ブラウザでの E2E（Playwright）
.claude/       Claude Code 向けの使い方（skills/keito）
```

## 共有案件（試験中）

共有案件は、共同編集サーバーを通して、複数のブラウザで同じボードを編集する機能です。試験中のため、`VITE_KEITO_COLLAB=1` を付けて起動・ビルドしたアプリだけが参加リンクを開きます。共有できる操作は、図形・付箋・エリア枠・機材・分岐点・凡例を置く、動かす、大きさや色などを変える、消す、複製する・貼り付ける、の 5 つと、線とポートを足す・消す、線をつなぎ替える、線の種別・長さ・ケーブル ID などを変える操作です。元に戻す（⌘Z）は、その画面で行った編集だけを、ドラッグ・複製・整列などの 1 回の操作ずつ戻し、ほかの人の編集は残します。ボードを切り替えたあとは、そのボードで行った編集を戻します。名前やメモなどの文字の入力（線の文と備考、ポートの名前を含む）、テキストを置くこと、重なり順とポートの並び順、ボードの設定は、共有中のボードではまだ受け付けません。

手元のボードからコピーした機材を共有中のボードに貼り付けると、ほかのボードとの共有と動作ホストを外して貼ります。画像やシーケンス図を含むときは貼り付けません。

共有案件のボードは、タブの「＋」で足し、ボード一覧で名前を変え、上の帯の「ボードを削除」で削除します。案件名もボード一覧で変えます。どれも参加している全員の画面に届き、元に戻す（⌘Z）では戻りません。削除したボードは、ボード一覧の「削除したボード」から戻します。シーケンス図のボードは、まだ足せません。

- 表示中のボードをほかの人が削除すると、隣のタブのボードに移ります。最後のボードを削除した案件は、ボードのない案件として開き、ボードを足すか戻すと、そのボードを開きます。
- どのボードを表示するかは画面ごとに決まり、ほかの人には届きません。案件を開き直すと、その端末で最後に表示したボードを開きます。ボードを切り替えて戻ると、表示位置もそのボードで最後に見ていた所に戻ります。
- 開いている案件をサーバーで削除すると、写しから開いたときも、手元のボードに戻り、「この共有案件は削除されています」と出ます。サーバーが保存していなかった変更は送らず、その件数を出します。

```sh
npm run collab -- init 会場A        # 共有案件を作る（ボード 1 枚と図形 1 つ）。案件の id（project）が出る
                                    # --kind system|software で、システム図・ソフトウェア図のボードにする（既定は free）
npm run collab -- grant <案件 id> --server ws://localhost:1235 --app http://localhost:5183/
                                    # 編集できる権限を作り、参加リンクを出す
npm run collab -- serve             # 共同編集サーバーを起動（既定のポートは 1235）
VITE_KEITO_COLLAB=1 npm run dev     # アプリを起動し、参加リンクをブラウザで開く
npm run collab -- delete <案件 id>  # 共有案件を削除する（restore <案件 id> で元に戻す）
```

- 共同編集サーバーは、Vite の開発サーバーとは別のプロセスです。`--host`・`--port`（または `KEITO_COLLAB_HOST`・`KEITO_COLLAB_PORT`）で待ち受け先を変えられます。
- データは `--data` のフォルダ（既定は `$KEITO_COLLAB_DATA`、なければ `./collab-data`）の `keito-collab.sqlite` に置きます。WAL を使うので、同じフォルダの `keito-collab.sqlite-wal`・`-shm` もデータの一部です。バックアップは、サーバーを止めてからフォルダごと取ります。
- 1 つのデータのフォルダは、1 台のサーバーだけで使います。複数のサーバーで同じ案件を扱う構成には対応していません。
- サーバーは暗号化しない WebSocket（`ws://`）で待ち受けます。手元のネットワークの外から使うときは、手前の reverse proxy で TLS を終端し、`grant` の `--server` に `wss://` の URL を渡します。
- 参加リンクには権限の token が入っています。アプリは token をブラウザに保存してアドレスから外し、次からは `#/s/<案件 id>` だけで開きます。サーバーには token の hash だけを保存します。
- 案件は `init` で作ったものだけを開けます。アプリが空の案件を見つけて作ったり、手元のボードの JSON を案件に入れたりはしません。
- `delete` で削除した案件は、データを残したまま開けなくなります。参加リンクを開くと「この共有案件は削除されています」と出ます。サーバーを動かしたまま削除したときは、1 秒ほどで接続中の画面との接続を切り、そのあとに届いた変更は保存しません。`restore` で、削除したときの状態に戻ります。
- 共同編集サーバーにつながらないときは、参加リンクを開いても手元のボードのままで、「共同編集先に接続できません」と出ます。ただし、一度開いた案件は下の端末内の写しから開きます。
- 変更は、アプリが保存を頼み、サーバーが SQLite に書き込んでから「共同編集先に保存済み」になります。サーバーは、こうして頼まれた変更だけを案件に入れ、Yjs の同期で届いた変更は受け付けません。ほかの画面に変更が届くのも、SQLite に書き込んだあとです。書き込めなかった変更はブラウザが持ち続け、「共同編集先に保存できていません」と出して、間をあけて送り直します。同じ変更を何度送っても、サーバーは 1 回だけ保存します。
- アプリは開いた共有案件の写しをブラウザの IndexedDB（データベース `keito-collab`）に置きます。写しには、サーバーがまだ保存していない変更も入ります。写しのある案件は再読み込みのあとやオフラインのときも写しから開き、サーバーにつながると、保存されていない変更を送り直します。サーバーに断られた案件の写しは、そのまま残します。写しからは開かず、写しの中の未送信の変更も送りません。
- 写しは、案件と共同編集サーバーの組ごとに置きます。同じ案件でも、参加リンクのサーバー（`server=`）が違えば別の写しになり、もう一方の写しからは開かず、その未送信の変更も送りません。
- オフラインで未送信の変更があるときは、上の帯に「オフライン・未送信 N 件」と「本端末に保存済み」が 2 行で出ます。写しに書き込めないとき（空き容量が足りないなど）は「本端末に保存できていません」と「閉じると未送信の N 件が失われます」を出し、ページを閉じる前にブラウザが確かめます。
- 写しを置く場所は `DeviceStore`（`src/collab/kept.ts`）で差し替えます。ブラウザの分は `src/platform/indexeddb.ts` です。ほかの置き場所を使うときは、`DeviceStore` を作って `createEditSession({ device })` に渡します。
- 共有中のボードは、ボードのフォルダにも手元のボードを置くブラウザの localStorage にも書き込みません。CLI（`npm run keito`）からも読み書きできません。
- 画面のボードの保存先（手元か共有案件か）は、ボードを開くときに決まります（`src/model/target.ts` の `Target`）。保存先は、編集（`edits`）、保存（`saving`）、タブに並ぶボード（`boards`）、手元のボードだけが持つもの（`local`。版の履歴、案件のほかのボードとの共有、画像）に分かれます。
- 手元のボードの編集と元に戻す（⌘Z）は `src/model/edits.ts`、保存は `src/model/saving.ts` が受け持ちます。共有中のボードの分は `src/collab/target.ts` が受け持ちます。共有案件のどのボードを表示するかと、ボードの追加・名前変更・削除・復元は `src/collab/tabs.ts` が受け持ちます。
- 線の端の機材やポートを誰かが消すと、その線は画面にも表にも書き出しにも出ません（`src/collab/valid.ts`）。線は案件に残るので、消した人が元に戻す（⌘Z）と線も戻ります。
- アプリと案件でデータの形（`src/collab/model.ts` の `SCHEMA`）が違うときは、案件を開けず、「この版の keito では開けない共有案件です」と出ます。
- 共有中のボードが受け付ける要素の種類・属性・操作は、`src/collab/scope.ts` にまとめてあります。共有できる操作は、ここに足します。画面は `useTakes` でここを読み、受け付けない操作のボタンを隠すか無効にします。

## 配布用のビルド

macOS 版は、ほかの Mac でも警告なしに開けるように、Developer ID で署名し、Apple の公証を通した `.dmg` を作ります。Windows 版は同じ Mac でクロスビルドします（下の「Windows 版」）。リリースに上げるファイルは、どちらも `src-tauri/target/release-files/v<バージョン>/` に集まります。

1. 最初に一度だけ、公証用の認証情報をキーチェーンに保存します。App 用パスワードは account.apple.com で作ります。

   ```sh
   xcrun notarytool store-credentials keito --apple-id <Apple ID> --team-id <チーム ID>
   ```

2. 同じく最初に一度だけ、アプリ内アップデート用の署名鍵を作ります。パスワードを聞かれるので決めて入力します。

   ```sh
   npx tauri signer generate -w ~/.tauri/keito.key
   ```

   できた公開鍵 `~/.tauri/keito.key.pub` の中身（1 行）を、`src-tauri/tauri.conf.json` の `plugins.updater.pubkey` に入れます。秘密鍵 `~/.tauri/keito.key` とパスワードは、パスワードマネージャーなどに控えておきます。アプリは、この鍵で署名したアップデートしか受け付けません。鍵かパスワードをなくすと、それまでの版からはアプリ内でアップデートできなくなり、使っている人に一度 dmg から入れ替えてもらうことになります。

3. `npm run app:release` を実行します。最初にアップデート用の署名鍵のパスワードを聞かれます。署名、公証、staple（公証の記録を .dmg と .app に添付）まで行い、続けてアプリ内アップデート用のファイルを作ります。公証の待ち時間は数分です。`src-tauri/target/release-files/v<バージョン>/` に次のものができます。

   - `keito_<バージョン>_aarch64.dmg`: 手でダウンロードして入れる人向け
   - `keito_<バージョン>_aarch64.app.tar.gz`: アプリが自分でダウンロードする本体（staple 済みの .app を固めて、署名鍵で署名したもの）
   - `latest.json`: 最新版のバージョンと、OS ごとのアップデートの URL と署名

4. 続けて `npm run app:release:windows` で Windows 版を作ります（下の「Windows 版」）。同じフォルダに `keito_<バージョン>_x64-setup.exe` が加わり、`latest.json` に Windows の分が足されます。どちらを先に作ってもかまいません。

5. フォルダの中身をすべて GitHub のリリース（タグ `v<バージョン>`）に上げます。終わりに `gh release create` の例が出ます。アプリは `https://github.com/genkitoyama/keito/releases/latest/download/latest.json` を見て新しい版を探すので、リリースは下書きやプレリリースにせず、最新（Latest）として公開します。片方の OS だけ先に出したときは、もう片方を作ってから `gh release upload v<バージョン> <フォルダ>/* --clobber` で `latest.json` ごと上げ直します。

- 署名には、キーチェーンにある「Developer ID Application」証明書を使います。複数あるときはどれを使うか決めないと止まるので、`KEITO_SIGNING_TEAM=<チーム ID> npm run app:release` で選びます（証明書の名前ごと `APPLE_SIGNING_IDENTITY` で指定してもかまいません）。公証の認証情報も、同じチームのものを保存します。
- 公証に使うプロファイル名は `KEITO_NOTARY_PROFILE` で変えられます（既定は `keito`）。
- 署名だけで公証しないときは `KEITO_SKIP_NOTARIZE=1 npm run app:release` です。この Mac で使うだけなら、これで足ります。このときは、アップデート用の署名鍵がなければアップデート用のファイルを作らずに終わります。
- アップデート用の署名鍵の場所は `TAURI_SIGNING_PRIVATE_KEY_PATH`（既定は `~/.tauri/keito.key`）、パスワードは `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` で渡せます。`tauri.conf.json` の公開鍵がこの鍵のものでなければ、ビルドの前に止まります。
- アプリは起動したときと、開いている間は 6 時間ごとに新しい版を探します（ネットワークにつながっていなければ何も言いません）。開発モード（`npm run app`）では探しません。
- `latest.json` には、同じバージョンの OS の分だけが並びます。別のバージョンのフォルダの `latest.json` は混ざりません。
- アイコンの元データは `design/icon.svg` です。変えたら `npx tauri icon <1024px の PNG> -o src-tauri/icons` で各サイズを作り直します（android/ と ios/ は使わないので消します）。

### Windows 版

Windows 版（x64）は、この Mac で [cargo-xwin](https://github.com/rust-cross/cargo-xwin) を使ってクロスビルドし、NSIS でインストーラーにします。Tauri ではまだ試験的な方法です。動くかどうかは Windows の実機で確かめてください。

1. 最初に一度だけ、ビルドに要るものを入れます。cargo-xwin は、最初のビルドのときに Microsoft の Windows SDK と CRT をダウンロードします（そのライセンスに同意したことになります）。

   ```sh
   rustup target add x86_64-pc-windows-msvc
   cargo install --locked cargo-xwin
   brew install nsis llvm
   ```

2. `npm run app:release:windows` を実行します。macOS 版と同じく、最初にアップデート用の署名鍵のパスワードを聞かれます。`src-tauri/target/release-files/v<バージョン>/` に `keito_<バージョン>_x64-setup.exe` ができ、`latest.json` に Windows の分が足されます。インストーラーが、そのままアプリ内アップデートの本体にもなります。

- インストーラーにはコード署名（Authenticode）をしていません。初めて開くとき、SmartScreen が「Windows によって PC が保護されました」と出します（「詳細情報」→「実行」で進めます）。証明書を用意したら、`tauri.conf.json` の `bundle > windows > signCommand` で署名のコマンドを指定します。アップデート用の署名は、コード署名した後のファイルに対して行う必要があります（スクリプトはビルドの後に署名するので、この順になります）。
- インストール先は使う人ごとのフォルダ（`%LOCALAPPDATA%`）なので、インストールにもアップデートにも管理者の権限は要りません。インストーラーの言葉は、Windows が日本語なら日本語、それ以外は英語です。
- WebView2 がない Windows では、インストーラーがダウンロードして入れます（Windows 11 と最近の Windows 10 には最初からあります）。
- Windows では、WebView2 に入力したキーがメニューに届きません。メニューのショートカット（Ctrl+R、Ctrl+Q、Ctrl+,）はページの側でも受けています（`src/platform/tauri.ts`）。WebView2 自身のショートカット（F5 や Ctrl+R での再読み込み、Ctrl+P の印刷など）は止めています（`src-tauri/src/lib.rs`）。
- PDF は WebView2 の PrintToPdf で書き出します（`src-tauri/src/pdf.rs`）。

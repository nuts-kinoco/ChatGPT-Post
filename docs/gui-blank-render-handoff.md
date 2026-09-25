# 引き継ぎ: GUIウィンドウが依然として空白のまま(3回目の修正でも直っていない)

## 絶対厳守のルール

**実際にアプリを起動し、タスクトレイのアイコンをクリックしてバーを表示させた状態の
スクリーンショットを取得し、ステータス表示(ドット・IDLE等の文字・経過時間)が
実際に描画されていることを目で確認できるまで、「修正完了」「動作確認済み」等の
報告を一切禁止する。**ビルド成功・テストパス・プロセス生存確認は「完了」の根拠にならない。
このルールを破ったことがこれまで3回連続で信頼を損なう結果になっている。

## これまでの経緯(すべて「直った」と誤って報告し、ユーザーのスクリーンショットで否定された)

1. 1回目: 白い空白ボックスのみ表示。原因: Viteのビルドが絶対パス(`/assets/...`)で
   JS/CSSを参照しており、`file://`経由の読み込みで解決できていなかった。
   → `vite.config.ts`に`base: "./"`を追加(commit A-182)。
2. 2回目: 背景が黒くなっただけで、依然コンテンツ非表示。原因: `<script type="module">`が
   `file://`経由だとChromiumのCORS制限でロードをブロックされる既知の問題。
   → カスタムprotocol(`bridge-gui://`)経由でレンダラーを配信する方式に変更
   (`protocol.registerSchemesAsPrivileged` + `protocol.handle` + `net.fetch`、
   `gui/src/main/renderer-protocol.ts`、未コミット)。
3. 3回目(直近): 上記修正を適用してビルド・再パッケージ・再起動したにもかかわらず、
   ユーザーのスクリーンショットでは依然としてタスクトレイにアプリのアイコンが見当たらず、
   バーウィンドウも完全に空のまま。**この修正でも直っていない可能性が高い。**

いずれの修正判断も、実際にElectronウィンドウをスクリーンショットで確認せず、
ビルド成功・ユニットテスト・プロセスの生存確認だけで「直った」と判断したことが
根本的な誤りだった。

## 今すぐやるべきこと(推測での再修正は厳禁)

1. **実際にDevToolsを開いて本物のエラーを見る。** `gui/src/main/main.ts`の`showBar()`に
   一時的に`barWindow.webContents.openDevTools({ mode: "detached" })`を追加するか、
   `barWindow.webContents.on("console-message", ...)` と
   `barWindow.webContents.on("did-fail-load", ...)` をログファイルに書き出すようにして、
   実際に何が起きているか(JSエラー、リソース読み込み失敗、protocol handlerが呼ばれて
   いない等)を実データで確認する。今まで3回とも「こう直るはずだ」という推測だけで
   進めてしまっていた。
2. パッケージ版だけでなく、開発モード(`npm run dev`、または`electron .`単体起動)でも
   同じ症状が再現するか確認する。再現する場合は`bridge-gui://`スキームがそもそも登録・
   使用されているか(`rendererUrl()`の戻り値、`registerRendererProtocol()`が実際に
   呼ばれているか)を確認する。
3. タスクトレイのアイコン自体が見えていない(ユーザーの最新スクリーンショットにも
   見当たらない)問題も未解決の可能性がある。M6で`tray-icon.png`に差し替えたはずだが、
   これも実際に見えているか別途確認が必要。

## 環境情報

- リポジトリ: `S:\Projects\chatgpt-web-bridge`(Windows 11、Electron 39.8.10）
- ビルド: `cd gui && npm run build && npm run package`
- 起動: `$env:CHATGPT_BRIDGE_ROOT='S:\Projects\chatgpt-web-bridge'; .\gui\release\'ChatGPT Bridge Control 0.1.0.exe'`
- 関連ファイル: `gui/src/main/main.ts`、`gui/src/main/renderer-protocol.ts`、
  `gui/vite.config.ts`、`gui/src/renderer/main.tsx`、`gui/assets/tray-icon.png`

## 完了報告の条件

実際に描画されたウィンドウのスクリーンショット(ステータスドット・テキスト・経過時間が
見える状態)を提示できて初めて「修正完了」と報告してよい。それ以外は「未検証」として
正直に報告すること。

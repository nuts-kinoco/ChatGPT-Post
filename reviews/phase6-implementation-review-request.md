# Phase 6 実装レビュー依頼（Codex, Medium）

対象: `git log 9052446..HEAD`（生成画像の取得、file-queue worker、同一会話追記、SKILL.md）。決定 A-091〜A-096、Live 結果 `docs/live-results/20260915-phase6.md`。読み取り専用。

## 特に見てほしい点
1. **`page.ts captureImages / saveImageViaFetch`**: ページ内 `fetch(img.src)` の範囲が A-069（「ページ自身が表示に使う同一 URL のみ」）に収まっているか。`src` の検証（origin 固定）で十分か、任意 URL を取りに行く経路が無いか。base64 の組み立てで大きな画像（数 MB）が落ちないか。
2. **`saveImageViaViewer`（opt-in）**: ビューアには独自の入力欄と送信ボタンがある。誤送信の経路（Enter / クリック位置）が無いか。Escape / 閉じるボタンの後始末。
3. **`cli/worker.ts`**: `rename` の失敗（他プロセスが開いている、別ドライブ）時の状態、`running` に取り残される条件、requestId の検証（ディレクトリ名がそのまま使われる: `..` や絶対パスは？）、`--drain` と busy（exit 4）の無限ループ可能性、SIGINT の扱い。
4. **`openConversation`**: URL 検証（origin / パス）、リダイレクト検出、既存ターン数 0 の扱い、`snapshotBaseline` との整合（ベースラインが送信直前に取られるか）。
5. **契約 1.2**: `newChat: false` と `conversationUrl` の schema `allOf`、result の `images[]` が `checkResultInvariants` で検査されるべきか。
6. **`extractLatest` の画像のみ経路**: `markdown: ""` を `completed` にする判断が「失敗を成功として扱う」禁止事項に触れないか（画像の保存に失敗した場合の扱い）。

## 出力形式
Markdown。`[Critical|High|Medium|Low] <ファイル:行> — 内容 — 根拠 — 提案`。Critical/High は再現条件付き。最後に「設計との乖離一覧」と「良い点」。

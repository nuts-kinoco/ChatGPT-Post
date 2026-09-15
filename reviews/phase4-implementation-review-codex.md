## レビュー結果

[High] `src/state/controller.ts:276, 340, 384` — `result.json` に URL クエリ／例外由来の機密情報がそのまま出力される — `docs/15-SECURITY-AND-PRIVACY.md` §4 および `docs/13-ERROR-MODEL.md` §6 は URL の query/fragment を成果物・cause に残さないことを要求しますが、`conversationUrl`、`warnings`、`error.cause` に `redact()` が適用されていません — `conversationUrl` は `/c/<id>` へ正規化し、`cause` と warnings は `redact()` 後に長さ制限してから結果へ格納してください。  
再現条件: `dispatchSubmit()` または `currentUrl()` が `https://chatgpt.com/c/id?token=SECRET` を返すと、`result.json.conversationUrl` に `token=SECRET` が残ります。`WRONG_PAGE` に query 付き URL を与えても `error.cause` に残ります。

[High] `src/browser/trace-sanitizer.ts:142-145` — `resources/*` の拡張子だけを根拠に未知リソースを保存する — `docs/15-SECURITY-AND-PRIVACY.md` §3 は `.network` の MIME 判定で許可された CSS/font/image と、`trace.trace` から参照された screencast のみを残す許可リスト方式です。現実装は `.network` に対応しない `resources/unknown.css`、`resources/unknown.svg`、`resources/unknown.png` を保存します — 拡張子による許可を廃止し、ネットワークで許可された SHA-1 または `trace.trace` から実際に参照される screencast SHA-1 のみに限定してください。  
再現条件: `.network` に対応レコードのない `resources/unknown.css` に `Authorization: Bearer secret` 相当の内容を置くと、`sanitizeEntries()` の出力 zip に残ります。

[Medium] `tests/unit/security.test.ts:77-124` — 上記の成果物境界を検証するテストがない — `docs/16-TEST-STRATEGY.md` の trace sanitizer と redaction の検証方針に対し、未知拡張子リソースの拒否、`conversationUrl`、`error.cause`、best-effort warning の query/secret 除去が未検証です — 上記再現条件を回帰テスト化し、出力された `BridgeResult` 全体に query/fragment と secret パターンが存在しないことを検査してください。

## 設計との乖離一覧

- 結果成果物の URL／例外文字列 sanitization が未実装。
- trace の resource allow-list が MIME／参照関係ではなく拡張子にも依存している。

## 良い点

- `VERIFY_LOCK → WRITE_SUBMIT_MARKER → DISPATCH_SUBMIT` の順序、marker 書込失敗時の送信停止、click 直前の preset 再確認は実装・単体テストともに確認できました。
- `current` の未観測時、および Phase 4 対象外 preset 時はいずれも `MODEL_NOT_VERIFIABLE` で fail closed です。
- 禁止されたネットワーク傍受、Cookie 読取、UA 偽装、headless 起動は製品コード上で確認されませんでした。clipboard shim も `run` 時のみで、設計上許容された捕捉用途に収まっています。
- `tsc --noEmit` は成功しました。`npm test` は読み取り専用環境により Vite の一時設定ファイルを書けず起動できなかったため、テスト実行結果としては未確認です。
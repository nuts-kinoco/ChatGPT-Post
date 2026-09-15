# Phase 4 実装レビュー依頼（Codex, Medium）

対象: `S:\Projects\chatgpt-web-bridge` の Phase 4 実装（`src/**`, `tests/unit/**`, `schemas/**`）。設計文書は `docs/10..17`、決定は `docs/DECISION-LOG.md`（A-001〜A-063）。Live 結果は `docs/live-results/20260915-LS-01.md`。

## レビューの立場

独立レビュアとして、**設計文書（10〜17）に対する実装の忠実性**と、**PO の絶対条件（`docs/02-REQUIREMENTS.md` CON-001〜、SEC-*）の違反**を探してください。読み取り専用です。ファイルを変更しないでください。

## 特に見てほしい点

1. **送信境界の安全性**: `src/state/controller.ts` と `src/chatgpt/page.ts`。marker の write-ahead（`VERIFY_LOCK → WRITE_MARKER → DISPATCH`）が実装で守られているか。marker 書き込み失敗時に送信していないか。`dispatchSubmit` の直前の preset 再確認が抜けていないか。
2. **fail closed**: `preset` が `current` 以外のときに送信前に止まるか。`current` の逆引きが曖昧なときに `MODEL_NOT_VERIFIABLE` になるか。`--allow-unverified` が `run` に紛れ込んだときの挙動。
3. **禁止事項**: ネットワーク傍受・Cookie/Token 抽出・ステルス・UA 偽装・内部 API 呼び出しが**無い**こと。`src/browser/launch.ts` の起動引数、`src/extraction/copy-capture.ts` の shim（`navigator.clipboard` の上書きが「検知回避」に当たらないか、意見が欲しい）。
4. **秘密情報**: `src/diagnostics/redact.ts` のパターン漏れ、`trace-sanitizer.ts` の許可リスト、`result.json` / ログにプロンプト本文や URL クエリが載らないか。
5. **ロック / marker**: `src/state/lock.ts` の stale 判定（PID + 生成時刻）、`marker.ts` の atomic 性、`ALREADY_PROCESSED` / `SUBMIT_STATE_UNKNOWN` の判定順序（`docs/10-ARCHITECTURE.md` §5）。
6. **完了判定**: `src/chatgpt/completion.ts` の `judge` が `docs/10-ARCHITECTURE.md` §6 の優先順位通りか。stabilization の起点 `max(streamingOffAt, lastHashChangedAt)`。
7. **抽出**: `src/extraction/verify.ts` の被覆率方式が「別メッセージの取り違え」を見逃す条件（例: 短い回答、同じ語の繰り返し）。
8. **Unit テストの穴**: テストが存在しない分岐のうちリスクが高いもの。

## 出力形式

Markdown。各指摘は `[Critical|High|Medium|Low] <ファイル:行> — 内容 — 根拠（設計文書の節 or CON/SEC 番号） — 提案`。Critical/High は再現条件を書いてください。最後に「設計との乖離一覧」と「良い点」を短く。

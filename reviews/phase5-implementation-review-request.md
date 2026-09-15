# Phase 5 実装レビュー依頼（Codex, Medium）

対象: Phase 5 で追加・変更した実装。`git log 8d5a353..HEAD`（preset / model 選択、添付、bundle、usage、--json）。設計は `docs/12`, `14`, `21`、決定は `docs/DECISION-LOG.md` A-067〜A-086、Live 結果は `docs/live-results/20260915-phase5.md`。

読み取り専用。ファイルを変更しないでください。

## 特に見てほしい点

1. **送信境界の安全性（変わらず最優先）**: `src/chatgpt/page.ts resolvePreset / selectEffort / selectModel`。メニュー操作中に誤って送信され得る経路（Enter キー、フォーカスがスライダーから入力欄に移った状態での ArrowRight/Home 等）が無いか。`closePicker` の「(5,5) をクリック」が何か別の UI を押す可能性。
2. **fail closed の網羅**: `MODEL_NOT_VERIFIABLE` に落ちるべきなのに `observed` を返すケース。`parseTriggerLabel` の誤マッチ（例: 「高」と「極高」、「6 Pro」の接頭部）。`observeModel` の `checked.length !== 1`。
3. **restoreEffort**（`controller.ts CLOSE_BROWSER`）: 15 s の race と `clock.sleep` の相互作用、失敗時に `browser.close()` が必ず呼ばれるか、`crashCause` 時にスキップする判断。
4. **添付の秘密情報ガード**（`contracts/attachments.ts`）: 抜け道（大文字拡張子、`.ENV`、パス正規化、`..`、シンボリックリンク、2 MB 超のテキスト、バイナリ偽装）。エラーメッセージに内容が漏れないか。
5. **bundle**（`bundle/bundle.ts`）: `fs.promises.glob` の `exclude` の意味論（ディレクトリ除外が効くか）、`git diff` 引数のインジェクション（`--diff` に `--output=...` のようなオプションを渡された場合）、`containsSecret` の対象漏れ（fence 内のヘッダ等）。
6. **usage**（`diagnostics/usage.ts`）: 窓の境界（`t > now` の扱い）、`limits.json` が壊れているときの挙動、`submitted: unknown` を数えない判断の妥当性。
7. **契約 1.1 の後方互換**: 1.0 request の受理、result 1.1 の必須フィールド、`invariants.ts` が新フィールドを検査していない点。
8. **`--json` の stdout**: ログや `console` の混入で JSON 1 行が壊れないか（`createLogger` の出力先）。

## 出力形式

Markdown。各指摘は `[Critical|High|Medium|Low] <ファイル:行> — 内容 — 根拠 — 提案`。Critical/High は再現条件付き。最後に「設計との乖離一覧」と「良い点」。

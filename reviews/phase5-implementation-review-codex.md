## Phase 5 実装レビュー

静的レビュー結果です。Critical はありません。

- [High] `src/contracts/attachments.ts:105` 拡張子だけで秘密情報の内容スキャン対象を決めており、偽装拡張子・シンボリックリンク経由で秘密情報を添付できます。再現: `Bearer <token>` を含む 2 MB 以下の平文を `report.pdf` として指定、または `report.pdf` を `.env` 等へ向けたリンクにすると、deny-list・`TEXT_EXT` のどちらにも掛からず `setInputFiles()` に到達します（`stat()` はリンク先を追跡）。添付は端末外へ送られるため、A-080 の送信前ガードに反します。提案: `lstat()` で reparse point/symlink を拒否し、拡張子ではなく UTF-8 と内容に基づいて小さいファイルを検査するか、許可するバイナリ形式を明示的に allow-list 化してください。

- [High] `src/bundle/bundle.ts:170` `diffRef` は `git diff` の `--` より前にそのまま渡されるため、Git のオプション注入で bundle 実行が任意パスを書き換え得ます。再現: `bundle ... --diff=--output=C:\tmp\victim.diff` を指定すると、`git diff --output=... -- ...` となり、Git が差分出力先を指定されたファイルへ変更します。shell injection ではないものの、読み取り用途の bundle コマンドが外部ファイルを書き得ます。提案: `diffRef` が `-` で始まる場合は即時拒否し、`git rev-parse --verify --end-of-options <ref>^{commit}` で解決済みの commit ID だけを `git diff` に渡してください。

- [Medium] `src/chatgpt/selectors.ts:642` `parseTriggerLabel()` は末尾が effort 名なら任意の接頭辞を model hint として受理します。再現: trigger 表示が `Unknown Pro` または UI 変更後の `Foo High` でも `pro` / `high` と解釈され、`resolvePreset()` は `MODEL_NOT_VERIFIABLE` にせず `observed` を返します。これは要求された fail-closed 判定と、A-075 の既知のモデル表示という前提に依存したままです。提案: 接頭辞なし、または observed model と厳密対応する既知の hint だけを許可し、それ以外・不一致は `not_verifiable` にしてください。

- [Low] `src/diagnostics/usage.ts:192` `limits.json` は `windows` が object であることしか検証せず、壊れた window 定義をそのまま集計に渡します。`windowHours`、`slug`、`limit` の型不正で `NaN` や空正規表現による誤集計になっても、黙って default 相当のように見える出力になります。提案: limits 用 schema を設け、読み込み失敗時は「limits が不正、default を使用」の警告を明示し、各 window を型・範囲検証してください。

## 設計との乖離一覧

- `docs/20-COMMAND-REFERENCE.md:156` は `result.status` に `already_processed` を含めていますが、契約・実装では `ALREADY_PROCESSED` は `result.json` を作らない exit 4 です。
- `docs/20-COMMAND-REFERENCE.md:161` は `extractionQuality` を `full / partial` としていますが、契約・実装は `full / degraded` です。

## 良い点

- `run --json` は進捗を stdout に出さず、logger も stderr を使うため、JSON 1 行の stdout を保てています。
- request 1.0 の受理、result 1.1 の必須フィールド、および `checkResultInvariants()` による schema/invariant 検査は整合しています。
- submit marker を送信前に書き、送信状態不明を `submitted: "unknown"` とする設計は堅実です。
- `git diff` の pathspec は `--` で区切られており、exclude 側の Git pathspec 注入は抑えられています。
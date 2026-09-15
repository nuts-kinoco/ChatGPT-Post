# Architecture Review Adjudication（Phase 3）

| 項目 | 値 |
|---|---|
| 日付 | 2026-09-15 |
| レビュアー | Codex CLI 0.153.4、`gpt-5.6-terra`、`model_reasoning_effort=high`、`--ephemeral -s read-only` |
| 依頼 | `reviews/architecture-review-request.md` |
| 原文 | `reviews/architecture-review-codex.md`（stdout ログ: `architecture-review-codex.stdout.log`） |
| 実行後の `git status` | 変更なし（Codex はファイルを変更していない） |
| 裁定者 | Claude（Opus） |

## 裁定一覧

| ID | Severity | 裁定 | 根拠 | 反映先 |
|---|---|---|---|---|
| F-01 | High | **Accept** | パス正規化では NTFS junction / symlink を解決せず、専用パスに見せかけて通常 `User Data` を自動化できる。CON-004 / SEC-001 の絶対条件に直結 | 15 §5: `fs.realpath` による canonical 比較 + プロファイルパスの最終要素と全祖先の reparse point を fail closed で拒否（初回作成時も同じ検証）。AC-012 に junction / symlink のテスト。16 §2 `browser/profile-guard` |
| F-02 | High | **Accept with modification** | 「effect がイベントを生じたら残りを実行しない」規約を診断 effect に適用すると、screenshot / trace 失敗で `result.json` が書かれない。`result.json` は最優先 | 11 §1 / §4: `CAPTURE` / `STOP_TRACE` / `INSPECT_UI_REPORT` / `UPDATE_MARKER` を **best-effort effect** と定義し、失敗してもイベントを生じず次へ進む。失敗は `result.json.warnings[]` に記録（新フィールド、schema 追加）。AC-025 に失敗注入テスト。修正点: 結果表現は `warnings` 配列とし、`error` を汚さない |
| F-03 | High | **Accept** | `observedPreset: "current"` が契約上有効になり、観測せずに `completed` を返す余地。CON-007 | 12 §3.3 / schema: `observedPreset` の enum から `current` を除く（`$defs.observedPreset`）。Auto 系（OQ-009）の観測専用値は PO 判断後にのみ追加。AC-015 / AC-007 に否定ケース |
| F-04 | Medium | **Accept** | schema が `status` × `code` の組を完全には制約していない。「schema が正」と宣言している以上、機械検証で閉じるべき | schema `allOf` に `status: failed ⇒ code ∉ MI 群 ∪ { ALREADY_PROCESSED, ALREADY_RUNNING }`、`status: manual_intervention_required ⇒ code ∈ MI 群` を追加。`invariants.ts` は `phase` / `submitted` の組を担当。16 §2 に否定ケース |
| F-05 | Medium | **Accept** | `runtime/` 一般削除の案内が送信済み台帳（marker）を消し、別ディレクトリからの同一 requestId 再送を可能にする。運用手順が R-003 の防御を無効化 | 15 §7 / 17 §8: `runtime/state/` を一般削除対象から除外し「送信監査台帳」と位置づける。`doctor` が `runtime/state/` 不在・削除痕跡を警告。GC は MVP 外（明示承認付きで将来） |
| F-06 | Medium | **Accept** | `result.json` 無しで古い `response.md` が残る requestDir は、認証失敗等の後に stale response が残り、`status` を読まない呼び出し元を誤認させる | 10 §4 [2] / 11 §4 / 13: `requestDir/response.md` が存在し `result.json` が無い場合は `INVALID_REQUEST(cause: stale_response)` で安全停止（削除しない）。AC-006 に追加。呼び出し元規約「requestDir は新規・空」を 12 §1 に明記 |
| F-07 | Medium | **Accept with modification** | baseline 観測から click までの間に preset 表示が変わる race。Codex 案は「marker は残しつつ送信なしの終端」 | `DISPATCH_SUBMIT` の内部で click 直前に `observePreset`（読み取り専用 `probe`）を再実行し、不一致なら click せず `SUBMIT_ABORTED(preset_changed)` → `FAILED(MODEL_NOT_VERIFIABLE)`、`submitted: "no"`。修正点: click していないことが確定しているので marker を best-effort で削除する（削除前にクラッシュしても再実行は `SUBMIT_STATE_UNKNOWN` になるだけで安全側）。11 §3 / §4 / §6.3 に例外を明記、13 §2 / §4 |

## Missing acceptance tests（すべて採用）

| Codex の指摘 | 反映先 |
|---|---|
| junction / symlink / reparse point を `--profile-dir` に渡して `INVALID_CONFIG` | AC-012、16 §2 `browser/profile-guard` |
| `CAPTURE` / trace sanitizer / artifact ディレクトリの各失敗でも `result.json` が残り `submitted` が正しい | AC-025、16 §2 `state/controller`（失敗注入） |
| `completed + observedPreset: current`、code-status 不整合が schema / invariant で拒否 | AC-007、AC-015、16 §2 `contracts/validate` |
| `result.json` 無しで `response.md` がある requestDir を拒否し送信しない | AC-006、16 §2 |
| `SNAPSHOT_BASELINE` 後・click 直前に preset 表示が変化する fixture で click が呼ばれない | AC-015、16 §3 `preset-changed-before-click` |
| `runtime/state/` の marker 削除の危険性を doctor / 運用手順が警告 | AC-002、17 §8 |

## Architecture alternatives（裁定）

| 提案 | 裁定 | 根拠 |
|---|---|---|
| Phase 4 で `preset: current` を使わず named preset のみ | **Reject** | マスタープロンプトの Phase 4 定義は「現在プリセットのまま送信」。F-03 の修正により `current` でも観測値は named preset に一意に逆引きされ、逆引きできなければ fail closed（FR-020）。Phase 4 の `observedPreset` 非 null 条件（AC-003）で担保 |
| requestId ごとのグローバル終端台帳 | **Reject（既存設計で充足）** | `runtime/state/<requestId>/submit.marker` は成功時も残る恒久記録であり、別ディレクトリからの同一 requestId 再実行は `SUBMIT_STATE_UNKNOWN` で拒否される（ADR-005 決定 3・4）。F-05 の反映で削除対象からも除外 |
| profile directory を bridge 管理 root 配下の新規ディレクトリに限定 | **Deferred（Phase 5 で再評価）** | F-01 の realpath + reparse point 拒否で絶対条件は担保できる。任意パス指定は複数ドライブ構成（PO 環境は `S:` に配置）で必要。Phase 5 の Live で `--profile-dir` の実運用を見てから限定するか決める |

## 未解決 Critical / High

なし（F-01〜F-03 はすべて設計・受入条件・テスト戦略に反映済み）。

## Freeze

設計文書（10〜17、ADR 001〜005、schemas）に `FROZEN FOR MVP v1.0（2026-09-15）` を付す。以降の変更は ADR または DECISION-LOG への記録を要する。OQ-001（規約の PO 手動確認）は未回答だが、対象は `03-RISK-REGISTER.md` R-001 の記述であり設計の Freeze 対象外。回答があれば R-001 を更新する。

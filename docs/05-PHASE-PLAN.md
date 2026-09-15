# 05 — Phase Plan

| 項目 | 値 |
|---|---|
| 文書版 | 1.0 (Phase 1) |
| 作成日 | 2026-09-14 |
| 状態 | Phase 1 完了時点の計画。各フェーズ終了時に更新 |

## 0. 運用ルール

- 各フェーズは **入口条件 → 作業 → 出口条件（ゲート） → PO 報告 → 停止** の順で進む。
- PO の `続行: Phase <N>` 指示が無い限り、次フェーズのファイル変更を始めない（OPS-001）。
- Claude Code が主担当（PO 窓口、要件、設計、実装統合、テスト、Codex 指摘の採否、最終品質責任）、Codex Pro は独立レビュー担当（敵対的レビュー、race condition / 二重送信 / 失敗復旧のレビュー、独立した原因仮説）。Codex を同じ作業ツリーの共同実装者にしない（OPS-004〜006）。
- モデル / effort は下表を既定とし、`max` / `xhigh` / `ultracode` は昇格条件を満たした場合のみ。

| Phase | Claude | Effort | Codex | Effort |
|---|---|---|---|---|
| 1 要件・リスク | 最上位 Opus | High | 使用しない | - |
| 2 基本設計 | 最上位 Opus | High | 使用しない | - |
| 3 設計レビュー | Opus で裁定 | High | 利用可能な最上位コーディングモデル（現環境既定 `gpt-5.6-terra`） | High |
| 4 縦切り実装 | 最新 Sonnet 推奨、なければ Opus | High | 実装後レビュー | Medium |
| 5 堅牢化 | 最新 Sonnet 推奨 | High | 節目レビュー | Medium/High |
| 6 連携 | Sonnet | Medium/High | 原則不要 | - |
| 7 リリース判定 | Opus | High | 最終レビュー | High |
| 難バグ | Opus | High | 独立解析 | High |

昇格条件（いずれか）: 高品質な 2 つ以上の原因仮説を検証しても解決しない / アーキテクチャの根本変更が必要 / Claude と Codex の独立分析が大きく対立し証拠で裁定できない / 再現性の低い重大なデータ損失・二重送信問題。

## Phase 1 — 調査・要件定義・リスク固定 【完了: 2026-09-14】

- **成果物**: `docs/00`〜`05`、`PROJECT_STATUS.md`、`DECISION-LOG.md`、`README.md`、`.gitignore`
- **出口条件**: 7 文書の存在 / 要件 ID / MoSCoW / 検証可能な AC / 重大リスクと緩和策 / 未決事項 / Phase 2 作業定義 / 実装未着手 / 無関係な変更なし
- **PO 操作**: 続行指示のみ

## Phase 2 — 基本設計と契約の固定 【完了: 2026-09-14。Phase 3 で Freeze】

- **入口条件**: PO の `続行: Phase 2`（2026-09-14 「進めて」で受領）
- **成果物**:
  ```text
  docs/10-ARCHITECTURE.md        コンポーネント図、データフロー、ブラウザライフサイクル、レイヤ分離
  docs/11-STATE-MACHINE.md       状態遷移図・遷移表、再試行可能遷移の限定、送信後不明状態の扱い
  docs/12-IO-CONTRACT.md         request/result の正式仕様、パス規約、アトミック書き出し、冪等性
  docs/13-ERROR-MODEL.md         エラーコード一覧、status との対応、retryable、終了コード表
  docs/14-SELECTOR-STRATEGY.md   selector 集約モジュールの構造、優先順位、多言語、verify 条件、preset 対応表の置き場
  docs/15-SECURITY-AND-PRIVACY.md 秘密情報の境界、redaction、trace/screenshot の扱い、禁止 API 一覧
  docs/16-TEST-STRATEGY.md       Unit / Fixture / Live の構成、fixture の sanitize 手順、Live フラグ
  docs/17-OPERATIONS.md          セットアップ、login、doctor、UI 変更時の手順、トラブルシューティングの骨子
  docs/adr/001-playwright-ui-automation.md
  docs/adr/002-dedicated-persistent-profile.md
  docs/adr/003-file-contract.md
  docs/adr/004-response-extraction.md
  docs/adr/005-single-flight.md
  schemas/request.schema.json
  schemas/result.schema.json
  ```
- **必ず扱う設計事項**: コンポーネント図 / データフロー / 状態遷移表 / エラー分類 / 終了コード / atomic write / lock・idempotency / ブラウザライフサイクル / プロファイル競合 / 再ログイン / preset の選択と検証 / 生成完了判定 / 回答抽出の多段フォールバック / trace・screenshot 保存 / ログ redaction / テスト可能性 / UI 変更時の fail closed
- **未決事項の解消**: OQ-004 → Chrome チャネル既定（A-020）、OQ-005 → Biome（A-021）、OQ-006 → 呼び出し元生成の時系列 ID（A-022）、OQ-007 → ページ内捕捉でクリップボード衝突を解消、PO 判断不要（A-023）
- **暫定値の確定**: エラーコード表・終了コード（13）、`result.json` の出力先（12）、artifacts ファイル名（10 §8）、環境変数名（10 §9）、selector エントリのフィールド名（14 §1）、trace サニタイズ（15 §3）。`02` §7 と `04` を更新済み
- **出口条件**: 実装者が追加判断なしで Phase 4 の縦切りを作れる / request・result schema が機械検証可能 / 状態とエラーの対応が一意 / selector が一か所へ集約される設計 / 送信後不明状態で自動再送しないことが明記 / セキュリティ境界が明確
- **PO 操作**: 続行指示のみ（OQ-007 は設計で解消）

## Phase 3 — Codex 独立レビューと設計 Freeze 【完了: 2026-09-15（OQ-001 の PO 回答待ちを除く）】

- **入口条件**: PO の `続行: Phase 3`（2026-09-15 受領）
- **手順**:
  1. `reviews/architecture-review-request.md` を作成（本文書末尾「付録 A: Codex 設計レビュー依頼テンプレート」を使用）
  2. `codex --version` / `codex exec --help` でフラグを再確認
  3. 非対話 `codex exec`（`--ephemeral -C <repo> -s read-only -m <model> -c model_reasoning_effort=high -o reviews/architecture-review-codex.md`）で敵対的レビュー
  4. 原文を `reviews/architecture-review-codex.md` に保存（失敗時は失敗証拠を保存し自己レビューで代替）
  5. 指摘を Accept / Accept with modification / Reject / Deferred に分類し `reviews/architecture-review-adjudication.md` に記録
  6. 採用分のみ設計文書へ反映
  7. 設計に `FROZEN FOR MVP` の版と日付を記録
- **出口条件**: Codex 原文または失敗証拠 / 全指摘の採否 / MVP 設計 Freeze / **Codex レビュー指摘のうち** Critical・High が未解決でない（リスク登録簿の R-001 等 Accept 扱いのリスクは対象外）/ OQ-001（規約手動確認）の PO 回答
- **PO 操作**: OQ-001 の確認、続行指示

> **2026-09-15 追記**: Phase 5 / 6 の内容は PO の追加要望を受けて `docs/21-CAPABILITY-EXPLORATION.md` §7 の再構成案に差し替える予定（PO 承認後に本文書を更新）。

## Phase 4 — 最小の End-to-End 縦切り 【完了: 2026-09-15】

- **入口条件**: PO の `続行: Phase 4`（2026-09-15 「OK,進めて」で受領）、Freeze 済み設計
- **通す一本**: `prompt.md → 専用可視ブラウザ起動 → ログイン確認 → 新規チャット → 現在 preset のまま送信 → 回答完了待ち → 最新回答抽出 → response.md + result.json`
- **必須実装**: TypeScript プロジェクト / `login` / `doctor` / 最小 `run` / dedicated persistent profile / 単一ロック / **write-ahead `submit.marker` と `SUBMIT_STATE_UNKNOWN` 判定（ADR-005）** / prompt 投入 / **preset の観測（`current`）と観測不能時の `MODEL_NOT_VERIFIABLE` による fail closed（FR-020, A-013）** / 回答完了検出の最小版 / 回答抽出 / atomic result write / trace・screenshot / Unit test / 1 本の Live smoke test（AC-003）
- **入れないもの**: preset の切替（観測は行う）、queue 常駐、添付、会話継続
- **未決事項の解消**: OQ-002（preset 表示名の実画面確認）、OQ-003（コピー操作が Markdown を返すか・`clipboard.writeText` を呼ぶか）、OQ-009（Auto 系既定選択の扱い）、Windows Chrome の `lockfile` 排他オープンによる占有判定の成立確認（10 §5）、生成完了後の `composer` / 送信ボタン / コピー操作の実際の状態（`composerReady` の定義の妥当性、10 §6）
- **Codex 提案の再評価（Deferred）**: プロファイルパスを bridge 管理 root 配下に限定するか（Phase 5 で判断）
- **出口条件**: 実ブラウザで一往復成功 / `observedPreset` が非 null / response.md を Claude Code が読める / 失敗時 trace が開ける / 二重送信なし / Unit test 通過 / Live 実行ログ保存 / AC-032（OPS-010 スコープ確認を含む）/ Codex Medium レビューで Critical・High を解消または明示保留
- **PO 操作**: 初回 `login` の手動ログイン（1 回）

## Phase 5 — MVP 堅牢化 【完了: 2026-09-15。実施内容は `21 §7` の再構成案。`docs/live-results/20260915-phase5.md`】

- **入口条件**: PO の `続行: Phase 5`
- **追加**: preset / effort 選択と検証 / 多言語 selector / 完了判定の複数信号化 / Markdown 抽出の多段方式 / 全エラーコード / タイムアウトと safe stop / browser crash 検出 / profile in use 検出 / request・result JSON Schema 適用 / CLI 終了コード / diagnostics（`inspect-ui`）/ ログ redaction / fixture tests / Live シナリオ拡充（AC-034 の LS-01〜LS-11）
- **並列化しない**
- **出口条件**: AC-001〜AC-031 のうち Live 以外がすべて通過、AC-032（OPS-010 スコープ確認を含む）、AC-034（LS-01〜LS-11）の結果記録、Codex 節目レビュー（AC-033）
- **PO 操作**: Live シナリオ中の手動介入（ログアウト状態テスト等）

## Phase 6 — Claude Code 連携 【完了: 2026-09-15。画像・キュー・追記・SKILL.md。`docs/live-results/20260915-phase6.md`】

- **入口条件**: PO の `続行: Phase 6`
- **成果物候補**: PowerShell wrapper（`scripts/ask-chatgpt.ps1`）/ Claude 向け利用手順 / 入力テンプレート / 結果待機と timeout 処理 / 失敗時の再開手順 / サンプルワークフロー
- **要件**: wrapper はブリッジの終了コードと result.json を正しく伝播し、`completed` 以外では response.md を返さない（R-011）
- **未決事項の解消**: OQ-008（PowerShell 7 の扱い — PO 判断。NFR-001a の優先度を確定）
- **出口条件**: Claude Code から人間のコピー＆ペーストなしに一往復できる証拠

## Phase 7 — リリース判定と引き渡し 【完了: 2026-09-15。Codex 最終レビュー（High）で Critical/High なし】

- **入口条件**: PO の `続行: Phase 7`
- **内容**: 全受入条件の再確認 / セットアップ再現（新規環境相当の手順検証）/ Codex 最終レビュー / 残存リスク一覧（R-001 を含む）/ 運用手順 / UI 変更時の修正ガイド / リリースノート / バージョン付与
- **出口条件**: 本文書末尾の「全体 Definition of Done」をすべて満たす
- **禁止**: 規約・アカウントリスクが解消したと表現すること

## 全体 Definition of Done（再掲）

新規 Windows 環境向けセットアップ手順 / 初回手動ログイン成功 / doctor が環境とログイン状態を診断 / 単一 request.json から送信 / 指定 preset の選択・確認 / 回答完了を誤検出せず待機 / response.md 保存 / result.json が常に最終状態 / 終了コード定義 / 二重送信防止 / 認証・CAPTCHA・利用上限で安全停止 / DOM 変更時に DOM_CHANGED で停止 / 失敗時 trace・screenshot / 認証情報がログ・Git に入らない / Unit・fixture テスト通過 / Live 受入テスト記録 / Codex 独立レビューと採否記録 / README・運用手順・トラブルシューティング完成

## 付録 A: Codex 設計レビュー依頼テンプレート（Phase 3 で `reviews/architecture-review-request.md` に転記）

```markdown
# Independent Architecture Review Request

あなたは独立した敵対的アーキテクチャレビュー担当です。
コードや文書を変更してはいけません。レビューだけを行ってください。

対象は、ChatGPT Webの通常UIをPlaywrightで操作し、プロンプト送信から回答回収まで行うローカルブリッジです。
OpenAI API、非公開backend API、HAR/Cookie抽出、CAPTCHA回避、bot回避は使用しません。

以下を重点的に探してください。

1. 二重送信につながるrace condition
2. 送信済みか不明な状態での危険なretry
3. 古いDOM参照、SPA再描画、stale locator
4. 生成完了の早期誤検出・永久待機
5. モデル／effortの誤選択と暗黙フォールバック
6. 認証切れ、CAPTCHA、利用上限、ブラウザクラッシュ
7. プロファイル競合とロック不備
8. Markdown抽出の欠落・破損
9. trace/logによる認証情報漏洩
10. Windows固有のパス、プロセス、ファイルロック問題
11. テスト不能な密結合
12. MVPの過剰設計または不足

出力形式:

- Executive summary
- Findings table: ID / Severity / Evidence / Impact / Recommendation
- Missing acceptance tests
- Architecture alternatives worth reconsidering
- Ship / Do not ship verdict for proceeding to vertical slice

根拠のない一般論ではなく、対象文書のファイル名と節を引用して指摘してください。
```

実行コマンドの概念例（フラグは実行前に `codex exec --help` で再確認）:

```powershell
Get-Content .\reviews\architecture-review-request.md -Raw |
  codex exec --ephemeral -C <repo-root> -s read-only -m <available-model> -c model_reasoning_effort=high -o .\reviews\architecture-review-codex.md -
```

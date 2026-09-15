# Phase 2 自己検証記録

日付: 2026-09-14
方式: Claude（Opus）の独立サブエージェント 3 体による読み取り専用レビュー。Codex は Phase 3。
視点: (1) 要件 → 設計トレーサビリティ、(2) 内部整合性・実装可能性、(3) 敵対的安全性（二重送信・失敗の成功誤報・秘密漏洩・絶対条件の軟化・fail closed の穴・Windows 固有）。
原文: `phase2-self-review-round1.json`（各指摘に file / location / issue / fix）、可読版 `phase2-self-review-round1.txt`。

## ラウンド 1（59 件: Critical 1・High 10・Medium 22・Low 26）— すべて反映

### 設計を変えた主要な指摘

| # | 指摘 | 決定 / 反映先 |
|---|---|---|
| adv-1 (Critical) | marker 判定がロック取得より前にあり、同一 requestId の二重起動で敗者が `SUBMIT_STATE_UNKNOWN` を書いて呼び出し元の再送を誘発 | 処理順序を「result.json → 検証 → **ロック** → marker → 占有 → 起動」に変更。marker 判定はロック保持下のみ（A-031、11 §4/§6、FR-010） |
| adv-2 (High) | 冪等判定が requestDir に閉じ、別ディレクトリの同一 requestId が再送される | marker を `runtime/state/<requestId>/` にグローバル配置（A-031、ADR-005、12 §5、10 §8） |
| adv-3 (High) | stale lock 回収の TOCTOU で 2 プロセスがロックを取れる | rename による原子的回収、PID 起動時刻照合、自 PID 書き戻し確認（ADR-005、FR-037） |
| adv-4 (High) | `zero-or-one` の候補評価で第 1 候補 0 件のとき以降のフォールバックが死ぬ | `unique` / `presence` / `count` モードを導入、presence は全候補 OR（A-033、14 §1、FR-041） |
| adv-5 (High) | 「Continue generating」打ち切りが `completed` になる | `continueButton` → `CHAT_ERROR(output_truncated)`（A-034、10 §6） |
| adv-6 (High) | `copyButton` がコードブロックの Copy に一致し複数一致で `DOM_CHANGED`；代替経路の `copyAvailable` が生成途中で true | `copyTurnButton`（testid 第 1 候補、否定先読み）、送信後は `DOM_CHANGED` を出さず降格、捕捉変数リセット、代替経路に `composerReady` を追加（A-033、14 §3/§5） |
| adv-7 (Medium) | 安定化ウィンドウの起点が曖昧で停止ボタン消失直後に完了し得る | 起点を「streaming が false に転じた時刻」に固定、`composerReady` 必須（A-029、10 §6） |
| adv-8 (Medium) | A/B 二重回答・Canvas 本文が `completed` になる | `multiple_responses` → `CHAT_ERROR`、`sidePanel` → `EXTRACTION_FAILED(canvas)`（A-034） |
| adv-9 (Medium) | trace サニタイザが text/html 内の JWT を残し、単語一致で診断情報を消す | `resources/` 許可リスト方式、redact と同一正規表現、`.network` を先に読む（15 §3） |
| adv-10 (Medium) | PS 5.1 の `-Encoding utf8` が BOM 付きで request.json が読めない | request.json も BOM 除去、17 §3 の例を `UTF8Encoding($false)` に（FR-009、12 §2） |
| adv-11 (Medium) | ロック解放とブラウザ終了の順序が 10 と 11 で逆、`close()` ハング未対応 | close（上限 15 s、kill）→ 解放に統一（A-036） |
| adv-12 (Medium) | Windows で `lockfile` の存在は占有指標にならず、起動例外は `BROWSER_CRASHED` に分類される | 起動前プリチェック（排他オープン、Phase 4 で確認）、`BROWSER_LAUNCH_FAILED` 新設（A-032、FR-019） |
| con-1 (High) | 判定規則の順序で `timeoutMs` が効かず、固定 120 s の `CHAT_ERROR` に要件根拠が無い | `timeoutMs` を最優先、固定初回上限を廃止、`VERDICT_WAITING` 導入（A-029） |
| con-3 (High) | `STABILIZING ⟲` 行が無く正常系が `INTERNAL_ERROR` になる | 行追加、`OBSERVATION` を状態機械イベントから除外（11 §1/§4） |
| con-4 (Medium) | `WRITE_RESULT` の後に trace を書くため `artifacts` のパスが存在しない | effects 順序を `CAPTURE → STOP_TRACE → WRITE_RESULT → CLOSE → RELEASE`（A-036） |
| tra-1 (High) | 空回答が `EXTRACTION_FAILED` に到達できない | 完了判定は空でも完了、抽出層が `empty` 判定（A-034、FR-034） |
| tra-2 (High) | `BROWSER_CRASHED` で trace が保存されない | best-effort の `STOP_TRACE` を effects に追加、FR-039 / AC-014 / AC-025 を best-effort に |
| tra-6 (Medium) | プロファイルパス拒否のコード・状態が未定義 | `INVALID_CONFIG`（A-032） |
| tra-5 / con-16 | `timeoutMs` の必須／任意が食い違う | 任意に統一（A-030） |
| adv-14 (Medium) | `current` の逆引きが非一意でも通る、Auto 既定の扱い未定義 | 一意性必須、ラベル集合が互いに素を Unit で検査、OQ-009 |
| adv-18 (Low) | copy シムが `login` 画面の人間のコピーを妨げる | `run` のみ登録（A-035） |

### その他（すべて反映）

`submitted` の boolean 表記、AC-018 の不変条件文言、`ALREADY_PROCESSED` / `PROFILE_IN_USE` の終了コード 4 群の説明、12 §6 の終了コード 3 の説明、marker フィールドの統一（10 §8 ↔ 12 §5）、FR-016(f) の停止ボタン確認と fixture、`new-chat-no-picker` の期待コード（`DOM_CHANGED`）と `MODEL_NOT_*` の判定規則（13 §4）、AC-017 の長文シナリオ LS-11、doctor モジュールとテスト、trace-on-success テスト、禁止トークン一覧の拡充と `tests/fixtures/**` への適用、`--dump-dom` の出力先と fixture サニタイズ、`error.cause` の FR-011 追加と schema 上限 200、`phase` の enum 化、`invariants.ts`、CLI オプションの 10 §9 併記、`login` / `inspect-ui` の終了コード 4、末尾改行の正規化、`challenge` の種別化と送信後の `AUTH_REQUIRED`、`REQUEST_READ` の requestId null、`（判定へ）` の状態名、Fixture 層のブラウザ入手手順、`observeAuth` の URL 注入、copy fixture のスクリプト注入、再試行上限超過コードの表、preset の送信直前再観測、marker の fsync、redact のフラグメント、ADR-005 の WMI 矛盾。

## 機械照合（反映後）

- ID 参照: 未定義 0（CON 14 / FR 49 / NFR 12 / SEC 10 / OPS 10 / OQ 9 / AC 34 / LS 11 / R 15 / A 37 / D 8）
- Must → AC 欠落 0、02 の AC 列 ⊆ 04 対応表、AC 見出しと 02 行の一致
- エラーコード: 02 §7 / 13 §2 / `result.schema.json` の 23 件が一致、終了コードも一致
- 状態名: 11 §2 と schema `$defs.stateName` が一致
- 遷移表: §3 の全イベントが §4 で消費され、未定義イベントの使用なし
- schema: 成功 / 手動介入 / 失敗例と否定例の assertion がすべて通過

## ラウンド 2（44 件: High 2・Medium 12・Low 30）— すべて反映

ラウンド 1 の 59 件は 57 件が解決確認、2 件（FR-006 の文言、R-003 (4)）は波及先の未更新。ラウンド 2 で設計を変えた主要な指摘:

| # | 指摘 | 決定 / 反映先 |
|---|---|---|
| adv-1 (High) | rename 回収の直後に別プロセスが新 lock を rename できる二次 TOCTOU | 所有トークン導入、取得直後・marker 直前（`VERIFY_LOCK`）・解放時に再検証、内容照合付き rename、`LOCK_LOST → ALREADY_RUNNING`（A-038、ADR-005、FR-037、11 §4 / §6） |
| adv-2 (High) | `composerReady` = 送信ボタン有効は空入力欄で成立せず、正常系が全件 `GENERATION_TIMEOUT` | 「停止ボタン不在かつ入力欄が編集可能」に再定義、送信後の観測は `probe` / `exists` / `countMatches` のみ（A-039、10 §6、14 §1 / §5） |
| con-1 / adv-3 / tra-1 | `PROMPT_SUBMITTING` の `DOM_CHANGED` が `submitted` 不変条件と矛盾 | `sendButton` を境界前に解決、`DOM_UNEXPECTED` の範囲を `PROMPT_ENTERED` まで、消失は `SUBMIT_FAILED`（A-040） |
| con-3 / adv-4 | `GENERATING` / `STABILIZING` で `VERDICT_WAITING` が `INTERNAL_ERROR` | 3 状態 × 9 verdict を全定義、`STOP_OBSERVATION_LOOP`（A-041） |
| con-4 / adv-5 | 停止ボタン消失後の後描画で永久待機 | 起点 = max(消失時刻, ハッシュ最終変化時刻)（A-041） |
| con-7 / tra-3 / adv-11 | 成功経路の `WRITE_RESULT` が表に無い、`SNAPSHOT_BASELINE` と marker が同一 effects 列 | effects 明示、2 段遷移、controller の中断規約（A-042） |
| con-2 / con-8 / tra-2 | `modelPickerOption` の unique と `MODEL_NOT_AVAILABLE` の矛盾、部分一致照合 | count モード、前後アンカー付き完全一致（A-043） |
| con-5 / con-10 / adv-14 | `openNewChat` の判定タイミング、`observeAuth` の判定不能、`enterPrompt` の再入力 | `composer` 出現時点で最終判定、`NOT_READY`、内部 2 回（A-043） |
| adv-6 | `dom` 方式で空本文が非空 Markdown になり `completed` | 入口で空判定、`verify()` は空 innerText を不合格（A-045） |
| adv-7 / adv-8 | AC-025 の単語一致要求と 15 §3 の矛盾、`.network` 削除で CSS 未適用・JWT 1 か所で trace 全消失 | `.network` 縮約、行単位 `redact()` 置換、スクリーンキャスト許可（A-044） |
| adv-10 | `requestId` 末尾 `.` の Windows 正規化衝突、予約デバイス名 | パターン末尾英数字、予約名拒否（A-045） |
| adv-16 | コピー操作が `execCommand` ならシムで捕捉も抑止もできない | OQ-003 に確認項目追加、該当なら `copy` 廃止（ADR-004 §5） |
| その他 | FR-006 / A-008 / A-027 の文言、R-003 (4)、LS-11 の Phase 5 反映、`UPDATE_MARKER` best-effort、`INSPECT_UI_REPORT` の定義、`presence` = 可視、AC-010 (a) のログイン系ドメイン、ADR-005 決定 5 の文言、15 §5 の `lockfile` 例外、会話 ID の秘密分類、16 §2 / §7 の対応、14 §8 の state 一覧 | 各該当箇所 |

## 機械照合（ラウンド 2 反映後）

- ID 参照: 未定義 0（A は 46 件）
- エラーコード 23 件: 02 §7 / 13 §2 / schema で一致、終了コードも一致
- 状態名: 11 §2 と schema が一致。遷移表: §3 の全イベントが §4 で消費、未定義イベント無し
- schema: `requestId` の新パターン（末尾英数字）を含む assertion 通過

## 収束判断

Critical 1 → 0、High 10 → 2 → （反映済み）。ラウンド 2 の残指摘は実画面確認（Phase 4: OQ-002 / OQ-003 / OQ-009、`lockfile` 排他、`composerReady` の実状態）に依存するものが中心のため、ラウンド 3 は行わず Phase 3 の Codex 独立レビューに委ねる（A-046）。

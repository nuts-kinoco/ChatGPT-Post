# 16 — Test Strategy

| 項目 | 値 |
|---|---|
| 文書版 | 1.3 (Phase 3、Codex レビュー反映。FROZEN FOR MVP v1.0、2026-09-15) |
| 作成日 | 2026-09-14 |
| 上位文書 | `04-ACCEPTANCE-CRITERIA.md`（AC → テストの対応を本書で定義）、`02-REQUIREMENTS.md` NFR-007, NFR-008 |

## 1. 3 層構成

| 層 | ランナー | ブラウザ | ネットワーク | 実行タイミング | コマンド |
|---|---|---|---|---|---|
| Unit | vitest | なし | なし | 常時（`npm test`） | `vitest run tests/unit` |
| Fixture | vitest + Playwright（**同梱 Chromium を headless**。`npx playwright install chromium` が前提。`page.setContent` / `file://`） | あり（静的 HTML のみ） | なし（`context.setOffline(true)`。`route` は使わず、外部参照を除去した fixture で担保） | 常時（`npm test`） | `vitest run tests/fixture` |
| Live | vitest（`BRIDGE_LIVE=1` でのみ収集） | 専用プロファイル、headed | chatgpt.com | 人間が明示実行 | `npm run test:live -- --scenario LS-01` |

`npm test` = Unit + Fixture。Unit 層はブラウザを起動しない。Fixture 層は同梱 Chromium を headless で起動するが chatgpt.com には接続しない。Live は CI 相当では走らない（NFR-008）。URL 依存の判定（`observeAuth` のドメイン判定、`/c/` 判定）は URL を引数注入するため Unit で、DOM 依存の判定は fixture で検証する。

## 2. Unit テスト（AC-005〜007, 009, 011, 016, 018, 024, 028, 029）

| 対象 | テスト | AC |
|---|---|---|
| `contracts/validate` / `contracts/read` | `schemas/*.json` に対する正常／異常ケース（欠落、enum 外、`newChat:false`、`schemaVersion` 不一致、未知フィールド、`timeoutMs` 範囲外・省略時の既定補完、`promptFile` 不在、prompt 空・空白のみ、`requestId` 欠落・パターン不一致・Windows 予約名 → `requestId: null` で `result.json`、UTF-8 BOM 付き `request.json` / `prompt.md` の受理、`request.json` 不在・JSON 構文エラー・UTF-16 → `result.json` 無し）。`result.json` が無く `response.md` がある requestDir → `INVALID_REQUEST(stale_response)`、送信なし。`result.json` の不変条件（12-IO-CONTRACT §3.4、`invariants.ts`）を全 `status` × `code` × `phase` の組で検証。schema の否定ケース: `completed + observedPreset: "current"`、`failed + AUTH_REQUIRED`、`manual_intervention_required + CHAT_ERROR`、`failed + ALREADY_RUNNING`、`warnings` 欠落 | AC-006, AC-007 |
| `contracts/atomic-write` | rename をフックし、最終パスに部分内容が現れないこと。rename 失敗時に tmp が残らないこと。Windows `EPERM` 再試行 1 回 | AC-009 |
| `state/machine` | 遷移表（11-STATE-MACHINE §4）を **表駆動**で全件検証。送信境界の不変条件（§6）: `DISPATCH_SUBMIT` は `transition(PROMPT_ENTERED, MARKER_WRITTEN)` の戻り値にのみ現れ `next == PROMPT_SUBMITTING`、境界後から境界前への遷移が存在しない（全状態 × 全イベントを総当たり）。送信後 3 状態 × `VERDICT_*` 9 種がすべて定義済み。`submitted` の導出（§6.3）。`attempts` の数え方（受領時 +1、max=3 で計 3 試行）と上限超過コード（§5）。成功経路の effects が `WRITE_RESPONSE_MD, STOP_TRACE(if enabled), WRITE_RESULT` の順 | AC-018, AC-007 |
| `state/controller` | フェイクポートで `run` 全経路を駆動し、`result.json` の内容・終了コード・effects 順序（`CAPTURE → STOP_TRACE → WRITE_RESULT → CLOSE_BROWSER → RELEASE_LOCK`）を検証。effects は列挙順に実行し、イベントを生じた時点で残りを実行しない規約（`SNAPSHOT_BASELINE` が `PRESET_CHANGED` を返したら marker を書かない）。`VERIFY_LOCK` 失敗で marker を書かず `ALREADY_RUNNING`。`UPDATE_MARKER` 失敗は警告のみで継続。`STOP_OBSERVATION_LOOP` 後に `VERDICT_*` を配送しない。**失敗注入**: `CAPTURE` / `STOP_TRACE` / `INSPECT_UI_REPORT` / artifacts ディレクトリ作成が失敗しても `result.json` が書かれ、`submitted` が正しく、`warnings[]` に記録される。`SUBMIT_ABORTED(preset_changed)` で click が呼ばれず `submitted: no`、marker が削除される。`ALREADY_PROCESSED` / `ALREADY_RUNNING` で `result.json` を書かないこと。同一 requestId の二重起動で敗者が `result.json` を一度も書かないこと。`CHATGPT_BRIDGE_TRACE_ON_SUCCESS` 未設定で成功時に trace を保存しない／`1` で保存し artifacts に載ること。送信前フェーズ上限で `TIMEOUT` が発火し §5 のコードになること | AC-005, AC-011, AC-024, AC-025 |
| `state/lock` | `O_EXCL` 取得と所有トークン再読取、PID 生存判定（`process.kill(pid, 0)` と WMI 照会をモック）、PID 再利用の検出、内容照合付き rename 回収、**2 プロセス同時 stale 回収で 1 つしか取れない**こと、**B が回収・再作成を完了した直後に C が rename するインターリーブ**で C が元に戻して `ALREADY_RUNNING` になること、`VERIFY_LOCK` が他者トークンで失敗すること、`RELEASE_LOCK` が他者の lock を消さないこと、0 バイト lock の扱い | AC-024 |
| `state/marker` | tmp → fsync → rename の順序、`MARKER_WRITTEN` が rename 後にのみ発火、0 バイト / JSON 不正 marker を「存在」と判定、送信後の追記 | AC-018, AC-011 |
| `diagnostics/doctor` | 各診断項目（Node / Playwright / ブラウザ / プロファイルパス（reparse point 含む）/ ブリッジロックと stale 案内 / プロファイル占有 / ログイン / 書込権限 / `runtime/state/` の存在）をモック入力で OK/NG | AC-002 |
| `chatgpt/completion` | `Observation` 列 → verdict（仮想時計）。正常系、途中再開（起点が streaming off 時刻にリセット）、停止ボタンが 1 観測だけ消えて戻る、**停止ボタン消失後に本文が 1 回変化してから安定 → 完了**（起点 = max(streamingOffAt, lastHashChangedAt)）、assistant 数が 1 観測だけ 0 に戻る（`VERDICT_WAITING`）、生成中 UI 無し（代替経路: 5 s + composerReady + copyAvailable）、エラーバナー、ターン内エラー文言、`truncated`、`multiple_responses`、空回答でも `VERDICT_COMPLETE`、`timeoutMs` が streaming 中でも優先、新 assistant 未出現で `VERDICT_WAITING` → timeout、`composerReady`（stopButton 不在かつ composer 編集可能）未復帰では完了しない | AC-019, AC-020 |
| `extraction/markdown` | golden file: HTML fixture → 期待 Markdown（コードブロック言語、ネスト fence、表、見出し、リスト、リンク、引用、KaTeX、日本語・絵文字） | AC-023 |
| `extraction/verify` | 捕捉内容が無関係 → 不合格、正常 → 合格、長さ比の境界、**innerText 空・candidate 非空 → 不合格**、入口で innerText 空なら即 `EXTRACTION_EMPTY(empty)`。末尾改行の正規化（LF 1 つ、BOM 無し） | AC-022, AC-008 |
| `diagnostics/redact` | 各パターンの入出力固定、200 文字丸め | AC-029 |
| `browser/profile-guard` | 通常 `User Data` パスの拒否（大小文字・区切り違い含む）、`realpath` 解決後の一致・包含、最終要素・祖先が symlink / junction の場合の拒否（テストで一時 junction を作成）、初回作成時の親ディレクトリ検査 | AC-012 |
| `browser/trace-sanitizer` | 手製 zip（`.network`、`trace.trace`、text/html・JSON・CSS・フォント・スクリーンキャスト jpeg の resources を含む）→ `.network` が URL（クエリ・フラグメント無し）/ method / status / mimeType / sha1 に縮約されヘッダーが無い、許可リスト外 resources 削除、CSS・フォント・スクリーンキャストは残る、`trace.trace` が残り JWT 風文字列と `?…` / `#…` が置換される、"We use cookies" 文言のスナップショットは残る、`npx playwright show-trace` で開ける（Live） | AC-025 |
| `chatgpt/selectors` | すべての `Candidate` に `verifiedOn` があること（実装後）。`ElementKey` の網羅。`presetLabels` の全 preset のラベル集合が互いに素、かつ前後アンカー付き照合で他ラベルの部分文字列に一致しない（`high` vs `Extra high`）。`probe` / `exists` / `countMatches` が 0 件・複数件で例外を投げない | AC-016, AC-015 |
| `cli/args` | 引数 → コマンド。不正引数で終了コード 2 | AC-005 |
| 禁止 API / 秘密情報 grep | `src/**` と `tests/fixtures/**` に `forbidden-tokens.ts` の禁止トークン（readText、profile 内ファイル名、extraHTTPHeaders を含む）と秘密情報パターン（メール、JWT、`__Secure-`）が無いこと（会話 ID は秘密情報ではない） | AC-029, AC-022 |

## 3. Fixture テスト（AC-010, 013, 015, 016, 019, 021, 022, 023, 026）

fixture は 14-SELECTOR-STRATEGY §8 の手順で作る **sanitized HTML**。Phase 4 で最初の 2 本（`new-chat-ja`, `completed-ja`）、Phase 5 で残りを追加する。

| fixture | 検証 | AC |
|---|---|---|
| `new-chat-{ja,en}` | `composer` / `sendButton` / `modelPicker` / `newChatButton` が exactly-one。`observeAuth(url=https://chatgpt.com/)` = `AUTH_OK`。`observePreset` が非 null | AC-016, AC-015 |
| `new-chat-no-picker` | `modelPicker` を除去 → `DOM_CHANGED`（送信なし） | AC-026 |
| `new-chat-unknown-label` | `modelPickerCurrentLabel` を未知文字列に置換 → `current` で `MODEL_NOT_VERIFIABLE` | AC-015 |
| `new-chat-ambiguous-label` | 2 つの preset に一致するラベル → `MODEL_NOT_VERIFIABLE` | AC-015 |
| `new-chat-missing-option` | メニューに `pro` の選択肢が無い → `pro` で `MODEL_NOT_AVAILABLE` | AC-015 |
| `new-chat-dup-composer` | `composer` を複製 → `DOM_CHANGED`、送信操作が呼ばれない、`inspect-ui.json` 生成 | AC-010, AC-026 |
| `new-chat-generating` | `composer` は出現するが `stopButton` あり → 最終判定で `NEW_CHAT_FAILED(generating)` → `PROMPT_SUBMIT_FAILED`、送信なし | AC-010 |
| `new-chat-loading` | `composer` も `loginCta` も無いロード途中 → `observeAuth` = `NOT_READY` → `RETRYABLE_STEP_FAILED`、上限超過で `INVALID_STATE` | AC-010 |
| `composer-mismatch` | `enterPrompt` 後に `composer` の内容を書き換える（テストスクリプト）→ `PROMPT_INPUT_FAILED`、送信なし | AC-017 |
| `preset-changed-before-click` | `snapshotBaseline` 後・click 直前に `modelPickerCurrentLabel` を書き換える（テストスクリプト）→ `SUBMIT_ABORTED` → `MODEL_NOT_VERIFIABLE`、click が一度も呼ばれない、`submitted: no` | AC-015 |
| （Unit）`wrong-domain` | `observeAuth(url=https://example.com/)` → `WRONG_PAGE` → `INVALID_STATE`；`url=https://auth.openai.com/...` → `AUTH_REQUIRED` | AC-010 |
| （Unit）`existing-conversation` | `openNewChat` 後、`composer` 出現時点の `url=https://chatgpt.com/c/...` → `NEW_CHAT_FAILED(existing_conversation)` → `PROMPT_SUBMIT_FAILED`（遷移途中の `/c/` は誤発火しない） | AC-010 |
| `generating` | `stopButton` あり → `streaming: true`。`sendButton` 不在で `composerReady: false`、`observe()` が例外を投げない | AC-019 |
| `completed-{ja,en}` | 複数 assistant のうち最新のみ抽出。テストが `page.evaluate` で `copyTurnButton` クリック時に本文 Markdown を `navigator.clipboard.writeText` に渡すスクリプトを注入して `copy` 経路。注入無しで `dom` 経路。本文除去で `EXTRACTION_FAILED(empty)` | AC-022 |
| `completed-rich` | コードブロック（2 個以上、各 Copy code ボタン付き）／表／数式／ネストリスト → golden Markdown。`copyTurnButton` がコードブロックの Copy に一致しない | AC-023, AC-022 |
| `completed-clipboard-mismatch` | 注入スクリプトが無関係文字列を書く → `dom` にフォールバック | AC-022 |
| `completed-truncated` | `continueButton` あり → `CHAT_ERROR(output_truncated)`、`completed` にならない | AC-019 |
| `two-responses` | 送信後に assistant ターンが 2 つ → `CHAT_ERROR(multiple_responses)` | AC-019 |
| `completed-canvas` | `sidePanel` あり → `EXTRACTION_FAILED(canvas)` | AC-022 |
| `error-banner` | `role=alert` → `CHAT_ERROR(banner)` | AC-021 |
| `error-in-message` | `role=alert` 無し、最新ターン内に「問題が発生しました」→ `CHAT_ERROR(banner)`、`completed` にならない | AC-021 |
| `rate-limited` | 上限文言 → `RATE_LIMITED` / `manual_intervention_required` | AC-021, AC-013 |
| `login` | `loginCta` あり、`composer` 無し → `AUTH_REQUIRED` | AC-013 |
| `challenge` | Turnstile 風 iframe → `CAPTCHA_OR_CHALLENGE` | AC-013 |
| `consent-dialog` | `role=dialog` が入力を遮る → `MANUAL_INTERVENTION_REQUIRED` | AC-013 |
| `login-during-generation` | 生成中 fixture で `loginCta` 出現 → `VERDICT_CHALLENGE(login)` → `AUTH_REQUIRED` | AC-013 |

動的挙動（生成→安定化）は fixture 内の小さなスクリプトで `stopButton` の出現／消失と本文の逐次追記を再生する（`page.setContent` 後に `page.evaluate` でタイムライン実行）。ページ内スクリプトは fixture 専用で、製品コードには含めない。

## 4. Live テスト（AC-001〜004, 008, 014, 017, 019, 020, 025, 027, 034）

- 前提: `BRIDGE_LIVE=1`、`chatgpt-bridge login` 済み、Windows、headed。
- 各シナリオは一意の requestId を生成し、プロンプトにそれを埋め込む（`Bridge Smoke Test / request id: <id>`）。回答に requestId が含まれることで対応付けを検証する。
- 実行ごとに `docs/live-results/<yyyymmdd>-<LS-xx>.md` を生成: 日付、bridgeVersion、Chrome 版、preset、所要時間、終了コード、`result.json` 全文（パスは相対化）、response.md の先頭 20 行、判定。**プロンプト全文と回答全文はコミットしない**（`runtime/` に残す）。
- LS-01〜11 の定義は `04-ACCEPTANCE-CRITERIA.md` AC-034。Phase 4 は LS-01 のみ、Phase 5 で全件。
- 人間の介入が必要なシナリオ（LS-07 ログアウト、LS-10 強制終了）は手順を `17-OPERATIONS.md` に記載し、テストは「観測された result.json が期待通りか」だけを自動判定する。

## 5. テストダブルの方針

- `ChatGptPort` / `BrowserPort` / `LockPort` / `ContractsPort` の 4 インターフェースを `src/state/ports.ts` に定義し、controller はそれだけに依存する。Unit テストは全ポートをインメモリ実装に差し替える。
- 時間は `Clock` インターフェース経由（`now()`, `sleep()`）。完了判定・タイムアウトのテストは仮想時計で決定的に行う。
- ランダム（tmp ファイル名）は注入可能にする。

## 6. カバレッジ目標（Phase 5 出口）

- `state/`, `contracts/`, `extraction/`, `diagnostics/`, `chatgpt/completion.ts`: 行 90 % 以上、遷移表は 100 %
- `chatgpt/page.ts`, `browser/`: fixture + Live で機能単位に網羅（数値目標なし）

## 7. AC → テスト対応表

| AC | Unit | Fixture | Live | Inspection |
|---|---|---|---|---|
| AC-001 | | | LS-07 前提手順 | |
| AC-002 | diagnostics/doctor | | doctor 実行 | |
| AC-003 | | | LS-01 | |
| AC-004 | | new-chat | inspect-ui 実行 | |
| AC-005 | cli/args, controller | | | README 突合 |
| AC-006 | validate | | | |
| AC-007 | validate, controller | | | |
| AC-008 | verify（末尾 LF / BOM 無し） | completed | LS-01 | |
| AC-009 | atomic-write | | | |
| AC-010 | wrong-domain, existing-conversation | dup-composer, new-chat-generating, login, unknown-label | | |
| AC-011 | controller, lock, marker | | | |
| AC-012 | profile-guard（junction / symlink 含む） | | | grep |
| AC-013 | | login, challenge, consent-dialog, rate-limited, login-during-generation | LS-07 | |
| AC-014 | | | LS-10, PROFILE_IN_USE 手順 | |
| AC-015 | selectors（ラベル集合が互いに素）, validate（observedPreset に current 不可） | new-chat, unknown-label, ambiguous-label, missing-option, preset-changed-before-click | LS-08 | |
| AC-016 | selectors | new-chat-{ja,en} | | grep |
| AC-017 | | composer-mismatch | LS-11 | |
| AC-018 | machine（総当たり）, marker, controller（VERIFY_LOCK） | | | |
| AC-019 | completion | generating→completed タイムライン, completed-truncated, two-responses | LS-06 | 固定 sleep grep |
| AC-020 | completion（timeoutMs 優先） | | LS-09 | |
| AC-021 | | error-banner, error-in-message, rate-limited | | |
| AC-022 | verify, 禁止 grep（readText） | completed, completed-rich, clipboard-mismatch, completed-canvas | | |
| AC-023 | markdown golden | completed-rich | LS-02〜05 | |
| AC-024 | lock（同時回収）, marker, controller（敗者が書かない） | | 二重起動手順 | |
| AC-025 | trace-sanitizer, controller（成功時 trace の有無、診断失敗注入） | | 失敗シナリオの artifacts | |
| AC-026 | | dup-composer, no-picker | | |
| AC-027 | | | PS 5.1 手順 | tsconfig / lockfile |
| AC-028 | | | | Unit がブラウザ無し、Fixture が同梱 Chromium headless で通る |
| AC-029 | redact, 禁止 API grep | | | 依存一覧 |
| AC-030〜033 | | | | 文書 |
| AC-034 | | | LS-01〜11 | |

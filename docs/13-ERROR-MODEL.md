# 13 — Error Model

## REL-3 inline route recovery

`CONVERSATION_MISMATCH` remains fail-closed. The sole exception before its terminal verdict is a
bounded, read-only check when the first mismatch occurs in `WAITING_FOR_RESPONSE`: the bridge
returns to its already locked URL at most twice and accepts a reply only with the same
baseline-plus-one and preceding-user-turn ownership proof as `collect`. It never re-enters,
clears, or sends a prompt. A recovered reply completes normally; no reply or any ambiguous proof
still writes `CONVERSATION_MISMATCH`. `route-events.jsonl` preserves navigation-origin evidence;
it can distinguish a bridge navigation command from a frame/History event observed while the
observer had issued no navigation, but cannot prove which external actor caused the latter.

## REL-2 recovery update

REL-2b strengthens this proof: `collect` requires the user turn immediately before the candidate
reply to match the submitted prompt, uses only a real `/c/<id>` URL (never a temporary `WEB:`
route), and leaves any existing composer draft untouched while recording a warning. Direct `run`
markers are recoverable without a jobs.db row. `--since` is recovery metadata, not a DOM timestamp
filter; explicit recovery therefore also supplies `--prompt-file`. Generated images use the normal
bounded capture path.

For terminal `GENERATION_TIMEOUT`, `GENERATION_TIMEOUT_ACTIVE`, `SUBMIT_STATE_UNKNOWN`, and `CONVERSATION_MISMATCH`, the first recovery step is `chatgpt-bridge collect <requestId>`, not resubmission. It reopens only a confirmed real recorded conversation and fails closed unless the assistant baseline proves exactly one new non-streaming reply whose immediately preceding user turn matches the submitted prompt. A saved composer draft is preserved and reported as a warning. It writes a separately marked recovered result and preserves the original failure record.

`wait` deadline is not terminal: it returns exit code 6 with `status: "waiting_timeout"`, `retryable: true`, and the nested job. Call `wait` again or use `collect` when a reply may already be visible.

| 項目 | 値 |
|---|---|
| 文書版 | 1.3 (Phase 3、Codex レビュー反映。FROZEN FOR MVP v1.0、2026-09-15) |
| 作成日 | 2026-09-14 |
| 上位文書 | `02-REQUIREMENTS.md` §7（本書と同一内容。差異があれば本書が正）、`11-STATE-MACHINE.md` |
| 機械可読版 | `schemas/result.schema.json` の `$defs.errorCode` / `$defs.stateName` |

## 1. 型

```ts
type BridgeError = {
  code: ErrorCode;
  message: string;        // 人間向け・日本語・秘密情報とプロンプト本文を含まない
  retryable: boolean;     // MVP では常に false
  phase: StateName;       // 失敗時の状態（11-STATE-MACHINE.md §2 の enum）
  cause: string | null;   // 種別タグ（例 'output_truncated'）または例外メッセージの先頭 200 文字（redaction 済み、URL を含めない）
};
```

`artifacts` は `BridgeError` ではなく `result.json` のトップレベルに置く（12-IO-CONTRACT）。

## 2. エラーコード一覧（確定）

| code | status | 終了コード | ブラウザ | result.json | submitted | 発生状態 | 意味 / 人間への案内 |
|---|---|---|---|---|---|---|---|
| `INVALID_REQUEST` | failed | 2 | 前 | 書く（request.json が読めない場合は書かない） | no | REQUEST_RECEIVED, PRIOR_RESULT_CHECKED | request.json / prompt.md を修正。`cause: stale_response`（`result.json` 無しで `response.md` が残存）の場合は古い `response.md` を退避し新 requestId で |
| `INVALID_CONFIG` | failed | 2 | 前 | 書く | no | PRIOR_RESULT_CHECKED | プロファイルパスが通常の User Data を指す（realpath 比較）、または symlink / junction を含む。`CHATGPT_BRIDGE_PROFILE_DIR` / `--profile-dir` を修正 |
| `ALREADY_PROCESSED` | — | 4 | 前 | **書かない**（既存を保持） | — | REQUEST_RECEIVED | 既存 result.json を読む |
| `ALREADY_RUNNING` | — | 4 | 前 / 後（`lock_lost`） | **書かない** | — | VALIDATED, PROMPT_ENTERED（`cause: lock_lost`。marker 未書込・送信なし） | 実行中のブリッジ終了後に再実行。stale なら `doctor` の案内に従う |
| `SUBMIT_STATE_UNKNOWN` | failed | 1 | 前 | 書く | unknown | LOCK_ACQUIRED | `collect <requestId>` を先に実行する。marker の URL/baseline で 1 件だけを証明できた場合のみ回収する。再送しない |
| `PROFILE_IN_USE` | failed | 4 | 前 | 書く | no | MARKER_CHECKED | 専用プロファイルを開いている Chrome を閉じる |
| `BROWSER_LAUNCH_FAILED` | failed | 4 | 前（起動失敗） | 書く（trace 無し） | no | PROFILE_CHECKED | Chrome / Chromium の起動失敗。`doctor` でブラウザ実行ファイルを確認 |
| `INVALID_STATE` | failed | 1 | 後 | 書く | no | BROWSER_STARTED | chatgpt.com 以外のページ／ページロード失敗の上限超過。専用プロファイルの状態を `login` で確認 |
| `AUTH_REQUIRED` | manual_intervention_required | 3 | 後 | 書く | no / **yes*** | BROWSER_STARTED, 生成中 | `chatgpt-bridge login` を実行 |
| `CAPTCHA_OR_CHALLENGE` | manual_intervention_required | 3 | 後 | 書く | no / **yes*** | BROWSER_STARTED, 生成中 | `login` で開いたブラウザでチャレンジを人間が完了。自動突破しない |
| `MANUAL_INTERVENTION_REQUIRED` | manual_intervention_required | 3 | 後 | 書く | no / **yes*** | BROWSER_STARTED, 生成中 | 同意画面等。`login` で開いて人間が対応 |
| `RATE_LIMITED` | manual_intervention_required | 3 | 後 | 書く | no / **yes*** | BROWSER_STARTED, 生成中 | 利用上限。自動待機しない。時間を置くか上位プランは PO 判断 |
| `MODEL_NOT_AVAILABLE` | failed | 1 | 後 | 書く | no | NEW_CHAT_READY | メニューは開くが要求 preset の選択肢が無い。`inspect-ui` で選択肢を確認 |
| `MODEL_NOT_VERIFIABLE` | failed | 1 | 後 | 書く | no | NEW_CHAT_READY, PROMPT_ENTERED, PROMPT_SUBMITTING（`cause: preset_changed`、click 前に中止） | 表示ラベルを preset に一意に逆引きできない／選択後の表示が不一致／送信直前・click 直前に表示が変わった。`inspect-ui` |
| `PROMPT_INPUT_FAILED` | failed | 1 | 後 | 書く | no | PRESET_VERIFIED | 入力欄内容が prompt と不一致（長さ上限等） |
| `PROMPT_SUBMIT_FAILED` | failed | 1 | 後 | 書く | no / **unknown** | AUTH_CHECKED（新規チャット失敗・生成中・既存会話）, PROMPT_SUBMITTING（クリック失敗・解決済み送信ボタンの消失・無効化） | 送信状態不明の場合は会話一覧を人間が確認 |
| `GENERATION_TIMEOUT` | failed | 1 | 後 | 書く | yes | WAITING/GENERATING/STABILIZING | `collect <requestId>` を先に実行する。元の失敗結果を残したまま、baseline+1 の唯一の返信だけ回収する。再送しない |
| `GENERATION_TIMEOUT_ACTIVE` | failed | 1 | 後 | 書く | yes | WAITING/GENERATING/STABILIZING | 生成継続の可能性が高い。`collect <requestId>` は stop が消えた後だけ回収する。screenshot / `doctor` を確認し、即時再送しない |
| `CONVERSATION_MISMATCH` | failed | 1 | 後 | 書く | yes | WAITING/GENERATING/STABILIZING | `collect <requestId>` は元の locked URL を再オープンして baseline+1 を検証する。証明不能なら fail closed。再送しない |
| `CHAT_ERROR` | failed | 1 | 後 | 書く | yes | WAITING/GENERATING/STABILIZING | `cause`: `banner`（エラーバナー）/ `network` / `output_truncated`（「続きを生成」表示）/ `multiple_responses`（A/B 等）。`conversationUrl` を確認 |
| `DOM_CHANGED` | failed | 1 | 後 | 書く | no | BROWSER_STARTED 〜 PROMPT_ENTERED | UI 変更。`artifacts` の `inspect-ui.json` を基に selectors を更新。**`PROMPT_SUBMITTING` 以降は発生させない**（送信ボタンは境界前に解決済み、抽出は降格で扱う） |
| `EXTRACTION_FAILED` | failed | 1 | 後 | 書く | yes | EXTRACTING | `cause`: `empty` / `canvas`。回答は生成された可能性。`conversationUrl` から手動取得 |
| `BROWSER_CRASHED` | failed | 1 | 後 | 書く（trace は best-effort） | no / unknown / yes* | BROWSER_STARTED 〜 WRITING_RESULT | ブラウザ終了・切断。`submitted` を確認 |
| `WRITE_FAILED` | failed | 1 | 後 | 書く（marker / response.md の失敗）／**書けない**（result.json 自身） | no / yes* | PROMPT_ENTERED（marker）, WRITING_RESULT | ディスク・権限・ファイルロックを確認 |
| `INTERNAL_ERROR` | failed | 1 | 任意 | 可能なら書く | 状態による | 任意 | ブリッジのバグ。`cause` と trace を添えて報告 |

`*` = 送信境界の前後どちらでも起こり得る。`submitted` は終端時の直前状態で決まる（`11-STATE-MACHINE.md` §2, §6）。

## 3. 終了コード（確定）

| 終了コード | 群 | 含まれるコード | result.json |
|---|---|---|---|
| 0 | 成功 | — | あり |
| 1 | ブラウザ起動後の失敗、または送信状態不明 | `SUBMIT_STATE_UNKNOWN`, `INVALID_STATE`, `MODEL_*`, `PROMPT_*`, `GENERATION_TIMEOUT`, `GENERATION_TIMEOUT_ACTIVE`, `CONVERSATION_MISMATCH`, `CHAT_ERROR`, `DOM_CHANGED`, `EXTRACTION_FAILED`, `BROWSER_CRASHED`, `WRITE_FAILED`, `INTERNAL_ERROR` | あり（`WRITE_FAILED(result)` を除く） |
| 2 | 不正な入力・設定（送信されていない） | `INVALID_REQUEST`, `INVALID_CONFIG` | あり（request.json 不読を除く） |
| 3 | 手動介入必要 | `AUTH_REQUIRED`, `CAPTCHA_OR_CHALLENGE`, `MANUAL_INTERVENTION_REQUIRED`, `RATE_LIMITED` | あり |
| 4 | 起動前停止。**何も送信されていない** | `ALREADY_PROCESSED`, `ALREADY_RUNNING`（result.json を書かない）、`PROFILE_IN_USE`, `BROWSER_LAUNCH_FAILED`（result.json を書く） | 混在。呼び出し元は「あれば読む、無ければ stderr」 |

プロセスが Node 側の未捕捉例外や外部からの kill で終了した場合の終了コードはブリッジの管理外。呼び出し元は「`result.json` が無い非ゼロ終了」を「状態不明」として扱い、次回 `run` の `SUBMIT_STATE_UNKNOWN` 判定に委ねる。

## 4. 分類ルール（実装が従う判定）

| 観測 | コード / イベント |
|---|---|
| URL が `https://chatgpt.com/` 配下でなく、ログイン系ドメイン（`auth.openai.com` 等） | `AUTH_REQUIRED`（FR-016 (a) の例外として (b) に分類） |
| URL が `https://chatgpt.com/` 配下でなく、上記以外 | `INVALID_STATE` |
| `loginCta` が可視、かつ `composer` が無い | `AUTH_REQUIRED`（送信後なら `VERDICT_CHALLENGE(login)`） |
| chatgpt.com 配下で `composer` も `loginCta` もチャレンジも無い（ロード途中） | `RETRYABLE_STEP_FAILED(auth)`（上限超過で `INVALID_STATE`） |
| `challengeFrame` が存在（iframe またはインライン文言。全候補を OR 評価） | `CAPTCHA_OR_CHALLENGE` |
| `blockingDialog` が入力を遮る | `MANUAL_INTERVENTION_REQUIRED` |
| `phrases.rateLimited` に一致する文言（role=alert、モーダル、ターン内のいずれか） | `RATE_LIMITED`（送信前の `observeAuth` でも検査する） |
| `errorBanner`（role=alert）または最新ターン内に `phrases.chatError` / `phrases.networkError` | `CHAT_ERROR(banner \| network)` |
| `continueButton` が可視 | `CHAT_ERROR(output_truncated)` |
| 送信後の assistant ターン増分が 2 以上 | `CHAT_ERROR(multiple_responses)` |
| `sidePanel` が可視で本文抽出を行う場面 | `EXTRACTION_FAILED(canvas)` |
| `openNewChat` 後、`composer` 出現時点の最終判定で `stopButton` が可視 | `NEW_CHAT_FAILED(generating)` → `PROMPT_SUBMIT_FAILED` |
| 同上で URL に `/c/` を含む | `NEW_CHAT_FAILED(existing_conversation)` → `PROMPT_SUBMIT_FAILED` |
| 同上で `composer` が空でない | `NEW_CHAT_FAILED(composer_not_empty)` → `PROMPT_SUBMIT_FAILED` |
| `modelPicker` / `modelPickerCurrentLabel` が見つからない・複数 | `DOM_CHANGED` |
| 見つかるが表示ラベルが `presetLabels` のどれにも逆引きできない、または 2 つ以上に一致 | `MODEL_NOT_VERIFIABLE` |
| メニューは開くが要求 preset の選択肢が 0 件（`modelPickerOption` は count モードで数え、`DOM_CHANGED` にしない） | `MODEL_NOT_AVAILABLE` |
| 要求 preset の選択肢が 2 件以上 | `MODEL_NOT_VERIFIABLE` |
| 選択後・送信直前の再観測で表示が要求 / 前回観測と不一致 | `MODEL_NOT_VERIFIABLE` |
| `unique` 要素が候補のいずれでも見つからない、または 2 件以上一致（`BROWSER_STARTED` 〜 `PROMPT_ENTERED`） | `DOM_CHANGED` |
| `PROMPT_ENTERED` の `VERIFY_LOCK` で自トークンが無い | `ALREADY_RUNNING`（`cause: lock_lost`、送信なし） |
| `PROMPT_SUBMITTING` で解決済み `sendButton` が消えた・無効・クリック失敗 | `SUBMIT_FAILED` → `PROMPT_SUBMIT_FAILED`（`submitted: unknown`） |
| `PROMPT_SUBMITTING` の click 直前の preset 再観測が baseline と不一致 | `SUBMIT_ABORTED(preset_changed)` → `MODEL_NOT_VERIFIABLE`（`submitted: no`、marker を best-effort 削除） |
| `requestDir/result.json` が無く `response.md` がある | `INVALID_REQUEST(stale_response)`（削除しない） |
| プロファイルパスの realpath が禁止パスに一致・包含、または最終要素・祖先が reparse point | `INVALID_CONFIG` |
| Playwright が `Target closed` / `Browser has been closed` / `page.crash`（起動後） | `BROWSER_CRASHED` |
| 起動前プリチェックで `profileDir/lockfile` の排他オープンが `EBUSY` / `EPERM` | `PROFILE_IN_USE` |
| `launchPersistentContext` が例外（プリチェック通過後） | `BROWSER_LAUNCH_FAILED` |

文言は `selectors.ts` の `phrases` に ja / en で集約する（14-SELECTOR-STRATEGY）。

## 5. 再試行方針（FR-042）

- `retryable` は MVP で常に `false`。ブリッジ内部の一時再試行（`11-STATE-MACHINE.md` §5）は結果に現れない。
- 呼び出し元が再送してよいのは `submitted == "no"` かつ原因を取り除いた後のみ。それでも **新しい requestId** を使う。

## 6. メッセージ規約

- `message` は日本語、1〜2 文、次に何をすべきかを含む。
- プロンプト本文・回答本文・URL（クエリ・フラグメントを含む）・Cookie・トークンを含めない。`conversationUrl` はトップレベルにのみ置く。
- `cause` は種別タグ（`banner` 等）を優先し、例外メッセージを入れる場合は `redact()` を通した後に 200 文字で切る。URL は `redact()` がクエリ・フラグメントを潰すが、`cause` には原則 URL を入れない。

## 7. REL-1 lifecycle and JSON failures (A-150)

`--json` is a stdout protocol. On every handled command failure it emits exactly one object of the form `{"error":{"code":"...","message":"..."}}`; non-JSON diagnostics use stderr. `submit --json` uses `INVALID_REQUEST`/exit 2 for bad input, `ALREADY_RUNNING`/exit 4 for a live lock, and `SUBMIT_SPAWN_FAILED`/exit 5 when no runner was handed off.

Each `run` lock records PID, OS process start identity, and a five-second heartbeat. A heartbeat older than 30 seconds is reported as abandoned. A dead or reused PID remains automatically reclaimable; a live PID with a stale heartbeat is deliberately **not** auto-reclaimed. `unlock --stale` only removes the former class and never kills a process. This preserves fail-closed behavior for a shared browser profile.

`SIGINT`, `SIGTERM`, and Windows `SIGBREAK` request a terminal result, browser close/CDP detach, then lock release. A hard kill cannot run cleanup and is recovered through lease diagnosis. The daemon is not a child of a request run; closing an attached request session only closes its dedicated page/disconnects CDP and never terminates the daemon.

For detached Windows `submit` children, `taskkill`/`TerminateProcess` does not deliver those handlers. `run` therefore has an internal two-window watchdog. After validation but before dispatch, its deadline is the existing allowed pre-submit work: `3×BROWSER_STARTED(60 s) + 3×AUTH_CHECKED(90 s) + 2×NEW_CHAT_READY(30 s) + 2×PRESET_VERIFIED(60 s) + 2×1 s` browser retry waits, plus (only with attachments) `2×uploadBudgetMs(totalBytes)`, plus `RUN_CLEANUP_BUDGET_MS` (30 s). The multipliers are the existing retry limits, so every permitted full retry remains legitimate while a launch/CDP/pre-submit hang is still bounded. On confirmed dispatch it cancels that timer and re-arms from `dispatchedAt` for `timeoutMs + fallbackStabilizationMs(5 s) + IMAGE_CAPTURE_BUDGET_MS(120 s) + RUN_CLEANUP_BUDGET_MS(30 s)`. Thus `timeoutMs` remains a submit-to-completion limit rather than a run-start limit.

When either outer deadline fires, `forceTerminal()` is started, but it is not trusted to settle: an independent 15-second hard grace ends the process even if result writing, CDP close, or async lock release is hung. Immediately before that hard exit, the run makes only a synchronous token-and-PID-checked unlink of its owned lock. If that cannot be done (for example, sharing violation or ownership changed), the exited PID makes the remaining lock reclaimable through the ordinary stale-lock policy. Signal handlers remain a foreground-run convenience, not the detached-run guarantee.

## A-155 submit-not-confirmed

`SUBMIT_NOT_CONFIRMED` is a failed exit-1 result with `submitted: "no"` and
`error.retryable: true`. It is emitted only when the post-click bounded check still finds the exact
prompt in the composer, no matching new verified user turn, no stop button, no accepted new-chat URL,
and the composer was never observed empty after the click. The bridge must clear both the draft and
all registry-verified composer attachment chips before it removes the submit marker. Any cleanup
failure, a restored draft, or a moved new-chat conversation URL is `SUBMIT_STATE_UNKNOWN`, not
retryable. The same requestId may be retried only after `SUBMIT_NOT_CONFIRMED`.

`SUBMIT_STATE_UNKNOWN` remains the outcome for an emptied, restored, otherwise changed, or
uncleanable composer without direct user-turn/generation evidence. It is never safe to resend; use
`collect` if a conversation URL was recorded. No automatic second click is performed in either case.

# 10 — Architecture

| 項目 | 値 |
|---|---|
| 文書版 | 1.3 (Phase 3、Codex レビュー F-02 / F-06 / F-07 反映) |
| 作成日 | 2026-09-14 |
| 状態 | **FROZEN FOR MVP v1.0（2026-09-15）**。以降の変更は ADR または DECISION-LOG に記録する |
| 上位文書 | `02-REQUIREMENTS.md`（要件 ID を参照）、`01-RESEARCH-AND-DECISION.md`（D-01〜D-08） |

## 1. 設計原則

1. **薄いブリッジ**: 人間が ChatGPT Web で行う操作（新規チャット → preset 確認 → 入力 → 送信 → 待つ → コピー）を、そのまま Playwright で代行する。それ以上のことはしない（CON-008）。
2. **fail closed**: 確認できないことは「していない」とみなし、送信しない・成功にしない（CON-007, FR-016, FR-027）。途中で切れた回答、複数回答、エラー文言入りの回答を `completed` にしない。
3. **送信は一度きり**: 送信操作の前に write-ahead マーカーを **requestId でグローバルな場所**に書き、送信後はいかなる失敗からも再送しない（FR-025, FR-038, R-003）。
4. **ブラウザ無しでテストできる**: 状態機械・契約・抽出・ロック・redaction・完了判定は Playwright に依存しない純関数／小さなポートに閉じ込める（NFR-007）。
5. **selector は一か所**: DOM への知識は `chatgpt/selectors.ts` にのみ存在する（NFR-005, FR-022）。
6. **秘密情報はプロセスの外へ出さない**: Cookie・トークンを読むコードパスを持たない。trace は保存前にサニタイズする（SEC-002, SEC-010）。

## 2. コンポーネント図

```text
┌───────────────────────────────────────────────────────────────────────┐
│ CLI (src/cli)                                                         │
│   login | doctor | run --request <path> | inspect-ui [--dump-dom]     │
│   引数解析 (node:util parseArgs) / 終了コード変換 / stdout・stderr 出力  │
└───────────────┬───────────────────────────────────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────────────────┐
│ Orchestrator (src/state)                                              │
│   machine.ts  純関数 (state, event) → (next, effects)                  │
│   controller.ts  effects を各ポートへディスパッチ、フェーズ上限・観測ループ │
│   ports.ts  ChatGptPort / BrowserPort / LockPort / ContractsPort / Clock│
└──┬──────────┬──────────────┬──────────────┬──────────────┬────────────┘
   │          │              │              │              │
┌──▼───────┐ ┌▼─────────┐ ┌──▼──────────┐ ┌─▼──────────┐ ┌─▼──────────────┐
│Contracts │ │ Locks    │ │ Browser     │ │ ChatGPT    │ │ Extraction     │
│(src/     │ │(src/state│ │(src/browser)│ │(src/chatgpt│ │(src/extraction)│
│contracts)│ │ /lock.ts,│ │ launch      │ │ selectors  │ │ copy-capture   │
│ Ajv      │ │ marker.ts)│ │ profile-    │ │ page ops   │ │ html→markdown  │
│ schema   │ │          │ │  guard      │ │ preset map │ │ innerText      │
│ atomic   │ │          │ │ trace-      │ │ completion │ │ verify         │
│ write    │ │          │ │  sanitizer  │ │ (純関数)   │ │                │
│ invariants│ │         │ │ screenshot  │ │            │ │                │
└──────────┘ └──────────┘ └──────┬──────┘ └─────┬──────┘ └────────────────┘
                                 │              │
                          ┌──────▼──────────────▼──────┐
                          │ Diagnostics (src/diagnostics)│
                          │ logger(redact) / artifacts   │
                          │ doctor / inspect-ui report   │
                          └──────────────────────────────┘
```

依存方向は上から下のみ。`ChatGPT` は `Browser` の `Page` を受け取るが、`Browser` は `ChatGPT` を知らない。`Orchestrator` は `Page` を直接触らず、`ChatGptPort` 経由で操作する。

## 3. モジュール責務

| モジュール | 責務 | 依存 | テスト方式 |
|---|---|---|---|
| `src/cli/` | コマンド解析、`RunController` 起動、終了コード変換、人間向け進捗出力 | Orchestrator | Unit（引数→コマンド） |
| `src/contracts/` | `request.json`（BOM 除去後 parse）/ `result.json` の型、Ajv 検証、**schema では表せない不変条件**（`invariants.ts`: `12-IO-CONTRACT.md` §3.4）、アトミック書き出し、パス解決 | `schemas/*.json` | Unit |
| `src/state/machine.ts` | 状態遷移の純関数。`transition(state, event)` | なし | Unit（全遷移表、送信境界の総当たり） |
| `src/state/controller.ts` | 状態機械を駆動。effects を各ポートへ渡し、結果を event として戻す。送信前フェーズ上限（§9）、観測ループ（250 ms）、成果物収集、`result.json` 書き出し | 全ポート | Unit（フェイクポート＋仮想時計） |
| `src/state/lock.ts` | プロセスロック（O_EXCL、所有トークン、内容照合付き rename による stale 回収、PID 生存＋起動時刻照合、取得直後・marker 直前・解放時のトークン再検証） | `fs`, `child_process`（PowerShell 経由 WMI、best-effort） | Unit |
| `src/state/marker.ts` | `runtime/state/<requestId>/submit.marker` の write-ahead 書込（tmp → fsync → rename）、存在判定、送信後の追記 | `fs` | Unit |
| `src/browser/launch.ts` | `launchPersistentContext`、クラッシュ購読、`context.close()` の上限付き終了 | Playwright | Live |
| `src/browser/profile-guard.ts` | プロファイルパス検証（`realpath` canonical 比較、reparse point の fail closed 拒否）、占有プリチェック（`lockfile` の排他オープン） | `fs` | Unit（パス、junction / symlink）+ Live（占有） |
| `src/browser/trace.ts`, `trace-sanitizer.ts` | trace 開始／停止、zip からのネットワーク記録・危険リソースの除去、残存検査 | Playwright, zip | Unit（サニタイザ）+ Live |
| `src/chatgpt/selectors.ts` | **唯一の DOM 知識**。要素定義、候補、verify、preset ラベル表、UI 文言（ja/en） | Playwright `Page` 型のみ | Fixture |
| `src/chatgpt/page.ts` | `ChatGptPort` 実装: `observeAuth` / `openNewChat` / `observePreset` / `selectPreset` / `enterPrompt` / `dispatchSubmit` / `observe` / `readLatestAssistant` / `captureCopy`。URL は `PagePort.currentUrl()` 経由で受け取り fixture で差し替え可能 | selectors, Page | Fixture + Live |
| `src/chatgpt/completion.ts` | 完了判定の純関数 `judge(history, config)`。DOM を読まない | なし | Unit（仮想時計） |
| `src/extraction/` | copy-capture（ページ内シム、`run` のみ）、HTML→Markdown（turndown + gfm + KaTeX）、innerText、`verify()`、末尾改行正規化 | turndown | Unit + Fixture |
| `src/diagnostics/logger.ts` | redaction 付きロガー | なし | Unit |
| `src/diagnostics/doctor.ts` | FR-002 の各診断項目を個別関数として実装（Node / Playwright / ブラウザ / プロファイルパス / ブリッジロック / プロファイル占有 / ログイン / 書込権限） | ports | Unit（モック入力）+ Live |
| `src/diagnostics/inspect-ui.ts` | 全 `ElementKey` の候補ごとの一致数・可視性、preset 選択肢一覧を JSON 化。`--dump-dom` は `runtime/artifacts/inspect-ui/<timestamp>.raw.html` にのみ書く | selectors | Fixture |

## 4. データフロー（`run`）

```text
request.json ─┐
prompt.md ────┤
              ▼
 [1] 読取（BOM 除去 → JSON.parse）・requestId 抽出（無ければ null）
 [2] requestDir/result.json の有無 → あれば ALREADY_PROCESSED（exit 4、何も書かない）。result.json が無く response.md が残っていれば INVALID_REQUEST(stale_response)（exit 2、削除しない）
 [3] Ajv 検証 + prompt 非空 + プロファイルパス検証 → INVALID_REQUEST / INVALID_CONFIG（exit 2、result.json あり）
 [4] プロセスロック取得（runtime/locks/bridge.lock）→ 取れなければ ALREADY_RUNNING（exit 4、何も書かない）
 [5] runtime/state/<requestId>/submit.marker の有無 → あれば SUBMIT_STATE_UNKNOWN（exit 1、result.json あり）
 [6] プロファイル占有プリチェック → 占有なら PROFILE_IN_USE（exit 4、result.json あり）
 [7] ブラウザ起動（専用プロファイル、headed、trace 開始、copy-capture シム登録）
 [8] chatgpt.com へ移動 → ドメイン・ログイン・チャレンジ・上限表示の判定
 [9] 新規チャットを開く（URL に /c/ が無い、入力欄が一意・空、stopButton 不在）
[10] preset 観測（current）／選択＋一致確認（それ以外）→ observedPreset 確定（逆引きは一意）
[11] prompt 投入 → 入力欄内容と prompt の一致確認
[12] 送信前スナップショット（assistant 数、URL、時刻、preset 再観測、sendButton の解決。preset が変化していれば MODEL_NOT_VERIFIABLE）
[13] ロック所有トークンを再検証（奪われていれば ALREADY_RUNNING で送信しない）
[14] submit.marker を write-ahead で書く（tmp → fsync → rename）  ◀── ここから先は再送禁止
[15] click 直前に preset 表示を再観測（probe）。変化していれば click せず MODEL_NOT_VERIFIABLE（submitted: no、marker は best-effort で削除）。一致なら解決済み sendButton をクリック（1 回）→ marker に dispatchedAt / urlAfter を追記（best-effort）
[16] 完了検出ループ（timeoutMs まで。観測スナップショットを completion.judge へ。観測は例外を投げない読み取り API のみ）
[17] 最新 assistant ターン抽出（innerText が空なら即 EXTRACTION_FAILED(empty)。copy-capture → dom → innerText。降格で扱い DOM_CHANGED にしない）
[18] response.md（atomic）→ [trace（成功時保存が有効なら）] → result.json（atomic）
[19] ブラウザ終了（上限 15 s、超過で kill）→ ロック解放（自トークンのときのみ）→ exit 0
```

失敗時は該当ステップで停止し、[7] 以降なら **スクリーンショット → trace 停止＋サニタイズ → result.json → ブラウザ終了 → ロック解放** の順で処理する（`result.json.artifacts` に載せるファイルは result.json より先に存在する）。スクリーンショット・trace・inspect-ui レポートは **best-effort** で、失敗しても必ず result.json を書く（失敗は `result.json.warnings[]` に記録）。

## 5. ブラウザライフサイクル

| 段階 | 動作 | 失敗時 |
|---|---|---|
| 占有プリチェック | `profileDir/lockfile`（Chrome が排他保持する 0 バイトの判定用ファイル。Cookie 等の内容は持たない）を開く。`EBUSY` / `EPERM` なら他プロセスが保持中 → `PROFILE_IN_USE`。ファイル不在・開けた場合は即閉じて続行（内容は読まない。必要な最小のオープンモードは Phase 4 で確認）。**Windows Chrome の挙動として Phase 4 の Live で確認し、成立しなければ WMI（`Win32_Process` のコマンドラインに profileDir を含む `chrome.exe`）に切り替える** | — |
| 起動 | `chromium.launchPersistentContext(profileDir, { channel, headless: false, viewport: null })`。`channel` は既定 `'chrome'`、設定で `'chromium'`。UA・fingerprint・stealth 系引数は付けない。`run` のみ `context.addInitScript(copyCaptureShim)` を登録する（`login` / `doctor` / `inspect-ui` は登録しない） | 起動例外 → `BROWSER_LAUNCH_FAILED`（trace 無し、artifacts 空、exit 4） |
| trace | 起動直後に `context.tracing.start({ screenshots: true, snapshots: true, sources: false })` | — |
| ページ | 既存タブがあれば最初のタブを再利用、無ければ `newPage()`。他タブは閉じない | — |
| クラッシュ検出 | `context.on('close')`、`page.on('crash')`、`page.on('close')` を購読し `BROWSER_CRASHED` を状態機械へ | trace 停止は best-effort |
| 終了 | `tracing.stop` → サニタイズ → `context.close()`（上限 15 s。超過時は `browser.process().kill()`）→ ロック解放。**必ずブラウザ終了の後にロックを解放する**（次の `run` が PROFILE_IN_USE にならないため） | close 失敗はログのみ、kill にフォールバック |

**再ログイン**: `run` はログインを行わない。未ログインを検出したら `AUTH_REQUIRED` で停止し、人間が `login` を実行する。`login` は同じ専用プロファイルで headed 起動し、ログイン済み判定（入力欄の出現）またはユーザーの Enter キーで終了する。

## 6. 完了検出アルゴリズム（FR-026, FR-027）

`page.ts` は 250 ms 間隔で **観測スナップショット** を取り、`completion.judge(history, config)` に渡す。judge は純関数で、時刻は `Observation.t` のみを使う。

```ts
type Observation = {
  t: number;                        // 送信 dispatch からの経過 ms
  assistantCount: number;           // assistant ターン数（countMatches）
  lastAssistantHash: string;        // 最新 assistant 本文 innerText のハッシュ
  lastAssistantEmpty: boolean;      // 本文 trim() が空か
  streaming: boolean;               // stopButton が可視
  composerReady: boolean;           // stopButton 不在 かつ composer が可視・編集可能（disabled でない）。sendButton の有効/無効は使わない（空入力欄では無効のため）
  copyAvailable: boolean;           // 最新ターンの「メッセージ単位」コピー操作が可視（コードブロックの Copy は含めない）
  truncated: boolean;               // continueButton（「Continue generating」）が可視
  sidePanel: boolean;               // Canvas 等の編集パネルが可視
  errorBanner: 'none' | 'chat_error' | 'rate_limited' | 'network';  // role=alert とターン内の phrases.chatError の両方から
  challenge: 'none' | 'login' | 'captcha' | 'consent';
};

type Config = {
  timeoutMs: number;                // request.json
  stabilizationMs: number;          // 既定 1500
  fallbackStabilizationMs: number;  // 既定 5000（生成中 UI を一度も観測できなかった場合）
};
```

`observe()` は `unique` 要素も例外を投げない読み取り API（`probe`）で読み、0 件・複数件は `false` / 空として扱う（送信後に `DOM_UNEXPECTED` を発生させない。`14-SELECTOR-STRATEGY.md` §1）。

judge は履歴から `baseline`（送信前 assistant 数）、`streamingSeen`、`streamingOffAt`（`streaming` が最後に true→false に転じた `t`）、`lastHashChangedAt`（`lastAssistantHash` が最後に変化した `t`）、`responseSeen`（一度でも `assistantCount > baseline` を観測したか）を導出し、**上から順に**評価する:

1. `challenge !== 'none'` → `VERDICT_CHALLENGE(kind)`。
2. `errorBanner === 'rate_limited'` → `VERDICT_RATE_LIMITED`。`'chat_error' | 'network'` → `VERDICT_CHAT_ERROR(banner | network)`。
3. `truncated` → `VERDICT_CHAT_ERROR(output_truncated)`（「続きを生成」は自動クリックしない。再送に相当し得る）。
4. `assistantCount - baseline > 1` → `VERDICT_CHAT_ERROR(multiple_responses)`（A/B 比較等。どちらを採用したか保証できない）。
5. `t >= timeoutMs` → `VERDICT_TIMEOUT`（**以降の規則より優先**。生成中 UI が出続けていても timeoutMs で打ち切る自体は変わらない）。ただしこの時点で `streaming === true`（停止ボタンがまだ出ている＝ CLI が待つのを諦めただけで ChatGPT 側は生成継続中の可能性が高い）なら `VERDICT_TIMEOUT` ではなく `VERDICT_TIMEOUT_ACTIVE` を返す（2026-09-17, #124: 専有プロファイルへの二重送信事故の再発防止。`GENERATION_TIMEOUT` は真にスタールした場合専用）。
6. `assistantCount <= baseline` → `VERDICT_WAITING`（`responseSeen === true` の後に起きた場合は SPA 再描画等の一過性とみなし、状態機械側で継続扱い。`11-STATE-MACHINE.md` §4）。
7. `streaming` → `VERDICT_GENERATING`。
8. `streaming === false`:
   - `streamingSeen === true`: 安定化窓の起点 `origin = max(streamingOffAt, lastHashChangedAt)` から `stabilizationMs` 以上経過し、その間 `streaming` が true にならず、`composerReady === true` → `VERDICT_COMPLETE`。それ以外 → `VERDICT_STABILIZING`。
   - `streamingSeen === false`（代替経路）: `origin = max(最新 assistant 出現時刻, lastHashChangedAt)` から `fallbackStabilizationMs` 以上経過し、`composerReady === true`、かつ `copyAvailable === true` → `VERDICT_COMPLETE`。それ以外 → `VERDICT_STABILIZING`。

注意:
- 本文が空（`lastAssistantEmpty`）でも `VERDICT_COMPLETE` を返す。空の判定は抽出層が行い `EXTRACTION_FAILED` にする（FR-034）。
- `STABILIZING` 中に `streaming` が再び true になれば `VERDICT_GENERATING` に戻り、`streamingOffAt` は次に false に転じた時刻で更新される。停止ボタン表示中の本文不変期間は数えないが、停止ボタン消失後に本文が変化（後描画・ハイライト等）すれば `lastHashChangedAt` により起点がずれ、そこから再度 `stabilizationMs` を数える。
- 停止ボタンが 1 観測だけ消えて戻るケース（思考→回答の切替）は `stabilizationMs`（6 観測分）で吸収する。
- 固定 sleep は使わない。安定化は経過時間で判定する（NFR-004）。

## 7. 回答抽出（FR-030〜034）

対象は **送信後に出現した最新の assistant ターン**（`assistantCount === baseline + 1` を規則 4 で保証済み）。抽出の入口で `readLatestAssistant().innerText.trim() === ''` なら方式 1〜3 を試さず即 `EXTRACTION_EMPTY(empty)`。`sidePanel === true`（Canvas 等）の場合は本文が要約になっている可能性があるため `EXTRACTION_EMPTY(canvas)` で fail closed。

| 順 | 方式 | 実現 | 採用条件 |
|---|---|---|---|
| 1 | `copy` | `run` の起動時に `addInitScript` で `navigator.clipboard.writeText` / `.write` をページ内でフックし、書き込まれたテキストを `window.__bridgeCopyCapture` に保持する。クリック直前に `__bridgeCopyCapture = null` へリセットし、最新ターンの **メッセージ単位**のコピー操作をクリックして捕捉テキストを得る。**システムクリップボードには書かない・読まない** | 捕捉テキストが非空、かつ `verify()` に合格。コピー操作が見つからない／複数ある場合は次へ降格（`DOM_CHANGED` にしない） |
| 2 | `dom` | 最新ターン本文の `innerHTML` を turndown（gfm、KaTeX `annotation[encoding="application/x-tex"]` → `$…$` / `$$…$$`、コードブロック言語クラス → fence 言語）で Markdown 化 | 変換例外なし、かつ `verify()` に合格 |
| 3 | `innerText` | 最新ターン本文の `innerText` | 非空なら採用。`extractionQuality: degraded`。空なら `EXTRACTION_EMPTY(empty)` |

`verify(candidate, innerText)`: innerText が空なら不合格。両者を正規化（空白圧縮、Markdown 記号除去、NFKC）した上で、innerText の先頭 200 文字と末尾 200 文字が candidate に含まれ、長さ比が 0.5〜3.0 の範囲にあること（FR-031, R-008）。

書き出し前に末尾の空白・改行を除去し LF を 1 つ付与する（FR-012）。

## 8. ファイル配置（runtime）

```text
runtime/
├─ profile/                         専用 user data dir（既定。設定で変更可、通常 User Data は拒否）
├─ locks/
│  └─ bridge.lock                   { pid, startedAt, token, command, requestId }（O_EXCL 作成。token は所有者の乱数）
├─ state/<requestId>/
│  └─ submit.marker                 write-ahead マーカー（12-IO-CONTRACT §5。requestDir に依存しない）
├─ requests/<requestId>/            呼び出し元が用意（request.json, prompt.md）。場所は任意
│  ├─ response.md                   成功時
│  └─ result.json                   終端時（FR-010 例外を除く）
└─ artifacts/
   ├─ <requestId>/
   │  ├─ screenshot.png
   │  ├─ trace.zip                  サニタイズ済み
   │  └─ inspect-ui.json            DOM_CHANGED 時
   └─ inspect-ui/<timestamp>.raw.html   `inspect-ui --dump-dom` の生 DOM（gitignore、共有禁止）
```

`result.json` / `response.md` の出力先は `request.json` と同じディレクトリ。`submit.marker` は **requestId でグローバル**（`runtime/state/`）に置くため、同じ requestId を別ディレクトリで再実行しても再送されない（ADR-005）。

## 9. 設定（MVP 最小）

環境変数と、それより優先する CLI オプション（`--profile-dir`, `--log-level`）のみ。設定ファイルは作らない（OPS-010）。

| 変数 / オプション | 既定 | 用途 | 根拠 |
|---|---|---|---|
| `CHATGPT_BRIDGE_PROFILE_DIR` / `--profile-dir` | `<repo>/runtime/profile` | 専用プロファイル | FR-015, SEC-001 |
| `CHATGPT_BRIDGE_CHANNEL` | `chrome` | `chrome` / `chromium` | A-020 |
| `CHATGPT_BRIDGE_TRACE_ON_SUCCESS` | `0` | `1` で成功時も trace 保存 | A-010 |
| `CHATGPT_BRIDGE_LOG_LEVEL` / `--log-level` | `info` | `debug` で観測ループを出力（本文は redaction 済み） | SEC-005 |
| `BRIDGE_LIVE` | 未設定 | `1` で Live テストを有効化（テスト専用） | NFR-008 |
| `CHATGPT_BRIDGE_MAX_CONCURRENCY` | `1` | Phase 3 MVP（A-136）。`run` が daemon 経由で同時に使える生成枠の数。2〜8で `state/slot-lock.ts` の N 枠プールへ切り替わる（`login`/`doctor`/`inspect-ui` は対象外、常に排他）。無効値は警告して 1、8 超過は警告して 8 にする | `docs/23-DURABLE-BRIDGE-PHASES.md` Phase 3 |

定数（A-029。Live で調整し、変更時は本表を更新）:

| 定数 | 値 |
|---|---|
| 観測間隔 | 250 ms |
| `stabilizationMs` | 1500 |
| `fallbackStabilizationMs` | 5000 |
| 送信前フェーズ上限 | `11-STATE-MACHINE.md` §5（60 / 90 / 30 / 60 s。A-145でAUTH_CHECKEDを30→90sへ） |
| `context.close()` 上限 | 15 s |
| 再試行前の固定待機 | 1 s（`BROWSER_STARTED` のみ） |
| rename `EPERM` 再試行 | 1 回、200 ms 後 |

## 10. 依存ライブラリ（MVP）

| 用途 | 採用 | 理由 |
|---|---|---|
| ブラウザ | `playwright`（固定バージョン） | D-02 |
| スキーマ検証 | `ajv` + `ajv-formats` | `schemas/*.json` を唯一の契約とする |
| HTML→Markdown | `turndown` + `turndown-plugin-gfm` | 表・取り消し線対応。KaTeX ルールは自前 |
| テスト | `vitest` | Unit / Fixture / Live |
| Lint/Format | `biome` | 一つのツールで完結（A-021） |
| CLI 引数 | `node:util` `parseArgs` | 依存追加なし |
| zip 操作 | `yauzl` + `yazl` | trace.zip の再構成。Phase 4 で確定 |

`openai`、stealth 系、OCR 系、proxy 系パッケージは追加しない（AC-029）。Fixture テスト用に `npx playwright install chromium` をセットアップ手順に含める（`channel: 'chrome'` 既定でも Fixture は同梱 Chromium headless を使う）。

## 11. Phase 4 縦切りで実装する範囲

- `cli`: `login`, `doctor`（最小項目）, `run`
- `contracts`: schema 検証、invariants、atomic write、BOM 除去
- `state`: 状態機械（全状態を定義、Phase 4 では `PRESET_VERIFIED` は `current` 観測のみ）、controller、lock、marker
- `browser`: 起動、profile-guard、trace、サニタイズ、screenshot、上限付き close
- `chatgpt`: selectors（実画面で確認した候補のみ）、`observeAuth`、`openNewChat`、`observePreset`（`current`）、`enterPrompt`、`dispatchSubmit`、`observe`、`readLatestAssistant`、`captureCopy`、completion
- `extraction`: copy-capture と innerText（`dom` は turndown 導入が容易なら Phase 4 で入れる）
- `diagnostics`: redaction ロガー、artifacts、doctor 最小

`inspect-ui`、preset 選択、多言語、全エラーコード、fixture 群は Phase 5。

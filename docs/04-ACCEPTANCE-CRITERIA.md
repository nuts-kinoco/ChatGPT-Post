# 04 — Acceptance Criteria

| 項目 | 値 |
|---|---|
| 文書版 | 1.1 (Phase 2 で確定値を反映) |
| 作成日 | 2026-09-14 |
| 状態 | Phase 1 成果物。Phase 2 で確定値を反映し `16-TEST-STRATEGY.md` でテストケースへ展開済み |

## 0. 読み方

- 各 AC は **検証方法**（Unit / Fixture / Live / Review / Inspection）と **合否の判定文** を持つ。
- **Live** は実 ChatGPT に対する手動または明示フラグ付き自動テスト。既定の CI では走らない。
- **Inspection** はコード・文書・Git の目視確認。
- 「対応要件」は `02-REQUIREMENTS.md` の ID。
- 全 Must 要件は少なくとも 1 つの AC に対応する。対応表は末尾。
- **確定値の出典**: エラーコード・終了コードは `13-ERROR-MODEL.md`（`02` §7 と同一）、状態名は `11-STATE-MACHINE.md`、ファイル名（`screenshot.png`, `trace.zip`, `inspect-ui.json`, `submit.marker`）と `result.json` の出力先は `12-IO-CONTRACT.md` / `10-ARCHITECTURE.md` §8、環境変数名（`BRIDGE_LIVE` 等）は `10-ARCHITECTURE.md` §9、selector エントリのフィールド名は `14-SELECTOR-STRATEGY.md` §1。Phase 2 で確定済み（変更時は本文書も更新）。

## 1. CLI

### AC-001 login（FR-001, CON-005）
- **検証**: Live
- **Given** 専用プロファイルが存在しない、または未ログイン
- **When** `chatgpt-bridge login` を実行
- **Then** 可視ブラウザが `runtime/profile/` を user data dir として起動し、chatgpt.com が開く。人間がログインを完了しコマンドを終了（またはログイン検出で自動終了）した後、`chatgpt-bridge doctor` が「ログイン済み」と報告する。
- **Fail** 自動でメール・パスワード入力を行う、通常 Chrome のプロファイルが開く、Cookie が標準出力・ファイルに出る。

### AC-002 doctor（FR-002）
- **検証**: Live + Unit
- **Then** 以下を各行で OK / NG と理由付きで出力し、NG が 1 つでもあれば非ゼロ終了する:
  Node バージョン、Playwright バージョン、ブラウザ実行ファイル、専用プロファイルの存在、プロファイルが通常 `User Data` を指しておらず reparse point を含まないこと、`runtime/state/`（送信監査台帳）が存在すること（欠落は警告）、ブリッジロック（`runtime/locks/` の有無・所有 PID・生存判定。stale なら「手動削除可」と案内）、専用プロファイルの他プロセス占有、ログイン状態（ブラウザを起動して確認）、`runtime/` 配下の書き込み権限。
- **Unit**: 各診断項目は個別関数としてモック入力で OK/NG を返せる。

### AC-003 run（FR-003, CON-002, CON-003）
- **検証**: Live（Phase 4 の縦切り受入）
- **Given** ログイン済み専用プロファイル、`preset: "current"`、prompt.md に以下を含む:
  ```markdown
  次の3要素を含むMarkdownを返してください。
  1. 見出し「Bridge Smoke Test」
  2. request id: `<REQUEST_ID>`
  3. `hello_bridge()` というTypeScriptコードブロック
  ```
- **When** `chatgpt-bridge run --request <path>` を実行
- **Then** 終了コード 0、`result.json.status == "completed"`、`result.json.observedPreset` が非 null（FR-020）、`response.md` に `<REQUEST_ID>` の文字列と ```` ```ts ```` または ```` ```typescript ```` で始まるコードブロックが含まれる。
- **Fail** 途中の回答を保存する、response.md に requestId が無い、preset を観測できないまま送信する。

### AC-004 inspect-ui（FR-004）
- **検証**: Live
- **When** `chatgpt-bridge inspect-ui` を実行
- **Then** 送信操作を一切行わずに、入力欄 / 送信ボタン / モデル選択 / 最新 assistant メッセージ / 生成中表示の各要素について「検出した selector 候補」「候補ごとの一致数」「未検出」を出力する。実行後に ChatGPT に新しいメッセージが送られていない。

### AC-005 出力チャネルと終了コード（FR-005, FR-006）
- **検証**: Unit + Inspection
- **Then** 終了コード表が README とコードで一致し、`completed`=0、`INVALID_REQUEST` / `INVALID_CONFIG`=2、`manual_intervention_required`=3、起動前停止（`ALREADY_RUNNING` / `ALREADY_PROCESSED` / `PROFILE_IN_USE` / `BROWSER_LAUNCH_FAILED`）=4、ブラウザ起動後の失敗と `SUBMIT_STATE_UNKNOWN` / `INTERNAL_ERROR`=1 が返る（`13-ERROR-MODEL.md` §3）。標準出力に Cookie・トークン・プロンプト全文が出ない。

## 2. 入出力契約

### AC-006 request.json 検証（FR-007, FR-008, FR-009, FR-010）
- **検証**: Unit
- **Then** 以下の入力それぞれで送信前・ブラウザ起動前に終了コード 2・`error.code == "INVALID_REQUEST"` となり、`request.json` と同じディレクトリに `result.json` が書かれる（`requestId` が欠落・パターン不一致の場合は `requestId: null` で、冪等判定はスキップされる）: 必須フィールド欠落（`timeoutMs` は任意なので対象外）、未知の `preset`、`timeoutMs` が範囲外、`promptFile` が存在しない、prompt が空または空白のみ、`newChat: false`（MVP）、`schemaVersion` 不一致、未知フィールド。BOM 付き `request.json` / `prompt.md` は正常に受理される。
- **Then** プロファイルパスが通常の User Data を指す場合は `INVALID_CONFIG`・終了コード 2・`result.json` あり（AC-012）。
- **Then** `requestDir/result.json` が無く `response.md` が存在する場合は `INVALID_REQUEST`（`cause: stale_response`）・終了コード 2 で停止し、`response.md` は削除されず、ブラウザを起動しない。
- **Then** `request.json` が存在しない、または JSON として読めない場合は終了コード 2 と標準エラーのみ（`result.json` は書かれない）。
- **Then** `requestId` が読め、同じ `requestId` の `result.json` が既に存在する場合は、スキーマ違反があっても `INVALID_REQUEST` ではなく AC-011（`ALREADY_PROCESSED`）が優先し、既存 `result.json` は上書きされない（FR-010 の処理順序）。
- **Then** 正常な request.json はスキーマ検証を通過する。

### AC-007 result.json の完全性（FR-010, FR-011, FR-040）
- **検証**: Unit + Fixture
- **Then** 状態機械の全終端状態（COMPLETED と全失敗状態。ただし FR-010 の例外 (1)〜(4)、すなわち request.json 不読・`ALREADY_PROCESSED`・`ALREADY_RUNNING`・`result.json` 自身の書き出し失敗を除く）で `result.json` が生成され、`status` と `error.code` の組が `13-ERROR-MODEL.md` §2 の表と一致することがテストで検証される。schema は `status` ごとに許容 `code` を制約し、`failed + AUTH_REQUIRED`、`manual_intervention_required + CHAT_ERROR`、`completed + observedPreset: "current"` を拒否する。`warnings` は常に配列。`error == null` は `status == "completed"` のときのみ。`extractionMethod` / `extractionQuality` は `completed` のときのみ非 null。
- **Then** `result.json` 自身の書き出しに失敗した場合は終了コード 1 と標準エラーで通知され、部分的な `result.json` が最終パスに残らない（AC-009）。
- **Then** `startedAt` / `completedAt` は ISO 8601 with offset、`durationMs` は両者の差と一致する。

### AC-008 response.md（FR-012）
- **検証**: Live + Fixture
- **Then** `status == "completed"` のとき、`responseFile` が指すファイルが存在し UTF-8 で読め、BOM 無し、末尾改行あり。`completed` 以外では `responseFile == null` かつ response.md が存在しない。

### AC-009 アトミック書き出し（FR-013）
- **検証**: Unit
- **Then** 書き出し関数は一時ファイル（同一ディレクトリ）へ書き、fsync 後に rename する。rename 失敗時は一時ファイルを削除し `WRITE_FAILED` を返す。テストで「最終パスに部分内容が存在した瞬間が無い」ことを、rename をフックして検証する。

### AC-010 送信前確認（FR-016, FR-009, CON-002）
- **検証**: Fixture + Live
- **Then** (a)〜(g) の各条件を 1 つだけ不成立にした fixture / 状況で、送信操作（Enter または送信ボタンクリック）が呼ばれず、対応するエラーコード（`13-ERROR-MODEL.md`）で終了する:
  (a) 非 chatgpt.com → `INVALID_STATE`（ログイン系ドメインへのリダイレクトは (b)）、(b) 未ログイン・ログイン系ドメイン → `AUTH_REQUIRED`、(c) 入力欄が 0 または 2 件 → `DOM_CHANGED`、(d) 既存会話 URL → `PROMPT_SUBMIT_FAILED`、(e) preset を観測できない / 不一致 → `MODEL_NOT_VERIFIABLE`、(f) 生成中 → `PROMPT_SUBMIT_FAILED`、(g) 空 prompt → `INVALID_REQUEST`（ブラウザ起動前に検出）。
  ロック競合は AC-024 で検証する。

### AC-011 冪等性（FR-014）
- **検証**: Unit
- **Given** 同じ requestId の `result.json` が既に存在
- **When** `run` を実行
- **Then** スキーマ検証・ロック取得・ブラウザ起動を行わず、送信せず、既存 `result.json` の内容とタイムスタンプが変化せず、終了コード 4 で終了し、標準エラーに `ALREADY_PROCESSED` と既存 `result.json` のパスが出力される。新しい `result.json` は書かれない。
- **Given** `requestDir/result.json` が無く `runtime/state/<requestId>/submit.marker` が存在する（0 バイトや JSON 不正を含む） **When** `run` **Then** ロック取得後にブラウザを起動せず、`result.json` が `status: failed` / `error.code: SUBMIT_STATE_UNKNOWN` / `submitted: "unknown"` / `artifacts: []` で書かれ、終了コード 1。同じ requestId を **別ディレクトリ**の `request.json` で実行した場合も同様（再送されない）。
- **Given** 同じ requestId を別プロセスが処理中（ロック保持、marker あり） **When** `run` **Then** `ALREADY_RUNNING`・終了コード 4 で、`result.json` は一切書かれない（marker 判定はロック取得後に行われる）。

## 3. ブラウザとセッション

### AC-012 専用プロファイル（FR-015, SEC-001, CON-004）
- **検証**: Unit + Inspection
- **Then** プロファイルパスの `realpath` が `%LOCALAPPDATA%\Google\Chrome\User Data`、`%LOCALAPPDATA%\Microsoft\Edge\User Data`、またはそれらの配下を指す場合（通常 `User Data` へ張った junction / symlink を経由する場合を含む）、およびパスの最終要素・祖先が reparse point である場合、`doctor` は NG、`run` は `INVALID_CONFIG`（終了コード 2、ロック取得前）で拒否する。既定パスは `runtime/profile/`。コード全体に `storageState(` の呼び出し・Cookie DB（`Cookies` ファイル）の読み取りが無い（grep で確認）。

### AC-013 手動介入停止（FR-017, CON-011）
- **検証**: Fixture + Live
- **Then** 各 fixture で `status == "manual_intervention_required"`、`retryable == false`、スクリーンショットが `artifacts` に含まれ、送信操作が呼ばれない。期待 `error.code`（`13-ERROR-MODEL.md`）: ログイン画面 → `AUTH_REQUIRED`、CAPTCHA / Cloudflare / Turnstile → `CAPTCHA_OR_CHALLENGE`、同意ダイアログ → `MANUAL_INTERVENTION_REQUIRED`、利用上限バナー → `RATE_LIMITED`。
- **Live**: ログアウト状態で `run` を実行し、`AUTH_REQUIRED`・終了コード 3 で停止する。

### AC-014 クラッシュ・競合（FR-018, FR-019）
- **検証**: Live
- **Then** 生成待機中にブラウザプロセスを強制終了すると `BROWSER_CRASHED`・`submitted: "yes"` で終了し、`result.json` が書かれる。trace / スクリーンショットは取得できた分だけ `artifacts` に列挙され、列挙されたパスはすべて存在する（best-effort）。
- **Then** 専用プロファイルをブリッジ以外のプロセス（`chrome.exe --user-data-dir=<profile>` を手動起動）が開いている状態で `run` すると、ブリッジのロックは取れるが起動前プリチェックで `PROFILE_IN_USE`・終了コード 4・`result.json` あり・`artifacts: []` で終了する（Playwright を起動しない）。
- **Then** プリチェックを通過した後に起動が失敗した場合（例: ブラウザ実行ファイルを一時的に無効化）は `BROWSER_LAUNCH_FAILED`・終了コード 4。
- **Then** 別のブリッジプロセス（`login` 等）が実行中の状態で `run` すると `ALREADY_RUNNING`・終了コード 4 で終了する（AC-024 と同じ判定）。

## 4. preset

### AC-015 preset の選択と検証（FR-020, FR-021, CON-007）
- **検証**: Live + Fixture
- **Then** `preset: "current"` では選択 UI を操作せず `observedPreset` に観測値（`instant` / `medium` / `high` / `extra_high` / `pro` のいずれか。`current` は不可）が入る。click 直前の再観測で表示が変わっていれば click せず `MODEL_NOT_VERIFIABLE`（`cause: preset_changed`）・`submitted: "no"`（fixture `preset-changed-before-click`）。`preset: "current"` かつ UI 表示から preset を一意に逆引きできない fixture（未知ラベル、または 2 つの preset に一致するラベル）では送信せず `MODEL_NOT_VERIFIABLE`。モデル選択トリガ自体が無い fixture は `DOM_CHANGED`（AC-026）。送信直前の再観測で表示が変わっていれば `MODEL_NOT_VERIFIABLE`・`submitted: "no"`。`preset: "pro"` 等では選択後の UI 表示が要求値と一致し `observedPreset == requestedPreset`。UI に存在しない preset（例: fixture で `pro` を除去）では送信せず `MODEL_NOT_AVAILABLE`、表示を読めない fixture では `MODEL_NOT_VERIFIABLE`。
- **Fail** 別 preset で送信して `completed` を返す。`current` で表示を読めないまま送信する。

### AC-016 selector 集約と多言語（FR-022, NFR-005, NFR-006, OPS-008）
- **検証**: Inspection + Fixture
- **Then** ブラウザ操作コードの selector 定義は単一モジュールに存在し、各エントリに `purpose`、`candidates[]`（優先順）、`verify` を持つ。日本語 UI と英語 UI の fixture 双方で主要要素が検出される。selector 文字列がそのモジュール外にハードコードされていない（grep で確認）。

## 5. 送信と完了検出

### AC-017 新規チャットと投入確認（FR-023, FR-024）
- **検証**: Live
- **Then** 送信前の URL が新規チャット（`/c/` を含まない）で、停止ボタンが無い。長文（10,000 文字以上）、複数の改行、コードブロック、絵文字、日本語を含む prompt（LS-11）を投入したとき、送信前に入力欄の内容が prompt と一致することが確認され、不一致なら `PROMPT_INPUT_FAILED`（fixture `composer-mismatch`）。

### AC-018 単一送信・再送禁止（FR-025, FR-038, FR-042）
- **検証**: Unit + Fixture
- **Then** 状態機械のテスト（全状態 × 全イベントの総当たり。送信後 3 状態 × `VERDICT_*` 9 種を含む）で、送信 effect `DISPATCH_SUBMIT` は `transition(PROMPT_ENTERED, MARKER_WRITTEN)` の戻り値にのみ現れ、その `next` は `PROMPT_SUBMITTING`。`PROMPT_SUBMITTING` 以降で `DOM_UNEXPECTED` を受ける遷移が存在しない。`PROMPT_SUBMITTING` 以降の任意の失敗（タイムアウト、クラッシュ）から `PROMPT_ENTERED` 以前へ戻る遷移が存在しない。再試行可能な遷移は `BROWSER_STARTED` / `AUTH_CHECKED` / `NEW_CHAT_READY` / `PRESET_VERIFIED` にのみ存在し、上限回数（3/3/2/2）と上限超過コードを持つ（`11-STATE-MACHINE.md` §5, §6）。
- **Then** 終端時の `result.json.submitted`: 直前状態が `PROMPT_SUBMITTING` → `"unknown"`、`WAITING_FOR_RESPONSE` 以降 → `"yes"`、それ以前 → `"no"`（`SUBMIT_STATE_UNKNOWN` は `"unknown"`）。
- **Then** marker は tmp → fsync → rename で書かれ、rename 完了前に `MARKER_WRITTEN` が発火しない。marker 書込の直前にロック所有トークンを再検証し、失敗時は marker を書かない。

### AC-019 完了検出（FR-026, FR-027, NFR-004）
- **検証**: Fixture + Live
- **Fixture / Unit**: (1) 生成中→完了の正常系、(2) 途中で一時停止して再開する系（停止ボタン表示中の不変期間は数えず、消失後に安定化を計る）、(3) 生成中 UI が出ない系（代替経路: 長い安定化 + 送信ボタン復帰 + コピー操作可用）、(4) エラーバナーが出る系、(5) 空回答系、(6) 「続きを生成」が出る打ち切り系、(7) assistant ターンが 2 つ出る系、(8) 停止ボタンが 1 観測だけ消えて戻る系、(9) 生成中に `timeoutMs` 到達 — で、それぞれ「完了」「未完了継続→完了」「代替経路で完了」「CHAT_ERROR(banner)」「完了→EXTRACTION_FAILED(empty)」「CHAT_ERROR(output_truncated)」「CHAT_ERROR(multiple_responses)」「未完了継続」「GENERATION_TIMEOUT」となる。
- **Live**: 長時間生成（pro / extra_high で 2 分以上）でも途中保存せず完全な回答を得る。
- **Inspection**: 固定 sleep の合計が 1 リクエストあたり 5 秒以内。

### AC-020 タイムアウト（FR-028, NFR-003）
- **検証**: Live
- **Then** `timeoutMs: 20000` で長い回答を要求すると、生成中 UI が出続けていても約 20 秒後に `GENERATION_TIMEOUT`、`retryable == false`、`submitted: "yes"`、trace と screenshot が保存され、再送されない。既定 timeout は 900000 ms。新しい assistant が現れない場合も `timeoutMs` で `GENERATION_TIMEOUT`（別の固定上限は無い）。

### AC-021 チャットエラー・レート制限（FR-029, CON-011）
- **検証**: Fixture
- **Then** エラーバナー fixture で `CHAT_ERROR`・`status == "failed"`・終了コード 1、利用上限 fixture で `RATE_LIMITED`・`status == "manual_intervention_required"`・終了コード 3。両者とも `retryable == false` で自動待機・再送しない。

## 6. 回答抽出

### AC-022 抽出対象と方式（FR-030, FR-031, FR-032, FR-034）
- **検証**: Fixture + Live
- **Then** 複数の assistant メッセージがある fixture で、送信後に出現した最新のもののみが抽出される。コピー操作が使え、ページ内フックで捕捉できた場合 `extractionMethod == "copy"`（システムクリップボードは読み書きされない — Unit で `navigator.clipboard.readText` 不使用を grep）、使えない fixture では `"dom"`、DOM 変換が失敗する fixture では `"innerText"` と `extractionQuality == "degraded"`。回答が空の fixture では `EXTRACTION_FAILED` で response.md が書かれない。
- **Then** 捕捉したコピー内容が最新 assistant メッセージの `innerText` と照合して一致しない fixture（フックに無関係な文字列を書かせる）では、`copy` を採用せず `"dom"` にフォールバックし、無関係な内容を `completed` として返さない。

### AC-023 Markdown 忠実度（FR-033）
- **検証**: Fixture（golden file）
- **Then** 以下の要素を含む fixture の抽出結果が期待 Markdown と一致する: 言語指定付きコードブロック（ts / python / bash / 指定なし）、ネストしたコードフェンス、表（ヘッダー + 整列）、H1〜H4、順序付き・順序なし・ネストリスト、リンク、引用、インライン数式とブロック数式、日本語・絵文字・結合文字、太字・斜体・インラインコード。

## 7. 排他制御

### AC-024 ロック（FR-035, FR-036, FR-037, CON-006）
- **検証**: Unit + Live
- **Then** `run` 2 プロセスを同時起動すると一方が `ALREADY_RUNNING`（終了コード 4）で即終了し、ブラウザを起動せず、`result.json` を書かない（標準エラーのみ）。ロックを奪われたプロセス（Unit で lock を差し替え）は `submit.marker` を書かず送信せずに `ALREADY_RUNNING`（`cause: lock_lost`）で終了する。同一 requestId で二重起動した場合、進行中プロセスが最終的に書く `result.json` が敗者によって書き換えられていない。`login` / `inspect-ui` の実行中に `run` を起動しても同様。プロセスを kill して残った lock は、次回起動時に PID 不在を確認して回収される。PID が生存していれば `ALREADY_RUNNING`。

## 8. 診断成果物

### AC-025 失敗時の成果物（FR-039, SEC-010）
- **検証**: Live + Unit
- **Then** ブラウザ起動後の失敗終了（`INVALID_STATE`, `AUTH_REQUIRED`, `CAPTCHA_OR_CHALLENGE`, `MANUAL_INTERVENTION_REQUIRED`, `RATE_LIMITED`, `MODEL_*`, `PROMPT_*`, `GENERATION_TIMEOUT`, `CHAT_ERROR`, `DOM_CHANGED`, `EXTRACTION_FAILED`, `WRITE_FAILED(response)`）で `runtime/artifacts/<requestId>/` に `screenshot.png` と `trace.zip` が存在し、**`result.json` が書かれる時点で既に存在し**、`result.json.artifacts` に列挙され、`npx playwright show-trace` で開ける。
- **Unit（失敗注入）**: スクリーンショット・trace 停止・サニタイズ・artifacts ディレクトリ作成のいずれが失敗しても `result.json` が書かれ、`submitted` が正しく、失敗が `warnings[]` に記録される。
- **Then** ブラウザ起動前の失敗のうち `result.json` を書くもの（`INVALID_REQUEST`, `INVALID_CONFIG`, `PROFILE_IN_USE`, `BROWSER_LAUNCH_FAILED`, `SUBMIT_STATE_UNKNOWN`）では `artifacts == []`。`ALREADY_PROCESSED` / `ALREADY_RUNNING` は `result.json` 自体を書かない（FR-010）。`BROWSER_CRASHED` では trace / screenshot は best-effort で、列挙されたパスは存在する。`WRITE_FAILED` のうち `result.json` 自身の書き出し失敗は本 AC の対象外（AC-007）。
- **Then** 成功時は trace を既定で保存しない（設定で有効化可）。
- **Unit**: trace サニタイザが `*.network` をヘッダー無しの縮約形に書き直し、許可リスト外の resources（text/html・JS・JSON・event-stream）を除去し、残存エントリに `15-SECURITY-AND-PRIVACY.md` §3 の正規表現群（ヘッダ形 `(cookie|authorization|set-cookie)\s*[:=]`、`Bearer …`、JWT 形、`__Secure-`、`sk-`）に一致する箇所が無く、単語としての "cookie" を含む本文は残ることをテストで固定する（SEC-010）。

### AC-026 DOM 変更時の安全停止（FR-041）
- **検証**: Fixture
- **Then** 入力欄・送信ボタン・モデル選択トリガのいずれかを除去または重複させた fixture で、クリック・入力操作を行わずに `DOM_CHANGED` で終了し、`inspect-ui` 相当の診断情報（`inspect-ui.json`）が artifacts に含まれる。存在検出用の要素（エラーバナー、チャレンジ、コピー操作等）が無いだけでは `DOM_CHANGED` にならない。送信後に要素が見つからない場合は `DOM_CHANGED` ではなく抽出の降格または `EXTRACTION_FAILED` になる。

## 9. 非機能

### AC-027 プラットフォームとツールチェーン（NFR-001, NFR-001a, NFR-002, NFR-010, CON-013, CON-014）
- **検証**: Inspection + Live
- **Then** `tsconfig.json` が `strict: true`。`package-lock.json` のみ存在（pnpm-lock / yarn.lock 無し）。PowerShell 5.1 から `npx chatgpt-bridge doctor` が動く。PowerShell 7 は現環境に未インストール（`01` §4）のため、OQ-008 の PO 判断に従い Phase 6 で導入して検証するか対象外とする。Windows パス（`C:\...`）と `/` 区切りの両方の `promptFile` を受け付ける。

### AC-028 テスト可能性（NFR-007, NFR-008）
- **検証**: Inspection + Unit
- **Then** 状態機械・完了判定・抽出・契約検証・ロック・marker・redaction・doctor のユニットテスト（`tests/unit`）が Playwright ブラウザを起動せずに通る。Fixture テスト（`tests/fixture`）は同梱 Chromium を headless で起動するが chatgpt.com に接続しない。`npm test` は両方を実行し、新規環境では `npx playwright install chromium` の後に通る。Live テストは `BRIDGE_LIVE=1` の明示フラグ無しではスキップされる。

### AC-029 秘密情報・テレメトリ・禁止技術（CON-001, CON-005, CON-008, CON-009, CON-010, SEC-002, SEC-003, SEC-005, SEC-008, SEC-010, NFR-009）
- **検証**: Inspection + Unit
- **Then** 以下が **存在しない** ことを grep と依存一覧（`package.json` / `package-lock.json`）で確認する:
  - 秘密情報: `storageState(`、`cookies()`、`recordHar`、`extraHTTPHeaders` で Authorization を設定する箇所、Cookie DB（`Cookies` ファイル）の読み取り
  - OpenAI API（CON-001）: `openai` 系 npm パッケージ、`api.openai.com` / `platform.openai.com` への参照
  - 内部 API・ネットワーク傍受（CON-008）: **chatgpt.com 配下を含む** あらゆる URL への直接 `fetch` / `page.request` / `context.request` / `APIRequestContext`、および `page.route(`、`waitForResponse(`、`waitForRequest(`、`page.on('request'|'response'|'websocket')`
  - OCR・座標回収（CON-009）: `tesseract` 等の OCR パッケージ、スクリーンショット画像からの文字認識
  - 検知回避（SEC-008）: stealth 系パッケージ、`userAgent` 上書き、fingerprint 偽装、proxy ローテーション
  - headless 既定（CON-005）: `headless: true` が既定値になっている箇所
  - 外部送信（NFR-009）: chatgpt.com 以外のホストへの通信
- **Then** ログ redaction のユニットテストで、prompt / response 本文が先頭 200 文字 + 総文字数に丸められる（SEC-005）。

### AC-030 README と運用手順（NFR-011, SEC-006, SEC-007, SEC-009）
- **検証**: Inspection
- **Then** README に (1) 新規 Windows 環境のセットアップ手順、(2) 初回ログイン手順、(3) 各コマンドの使い方と終了コード表、(4) トラブルシューティング（AUTH_REQUIRED / DOM_CHANGED / PROFILE_IN_USE / GENERATION_TIMEOUT）、(5) trace・screenshot に個人情報が含まれる注意、(6) prompt / response がローカルに保持され自動削除されない旨、(7) 規約・アカウントリスクの明記 — が含まれる。

### AC-031 .gitignore（SEC-004, CON-010）
- **検証**: Inspection
- **Then** `.gitignore` に `runtime/`、trace、screenshots、`*.har`、`*.log`、`.env` が含まれ、`git status` に runtime 配下のファイルが現れない。

## 10. プロセス

### AC-032 フェーズゲート・状態更新・証拠・スコープ（OPS-001, OPS-002, OPS-003, OPS-007, OPS-009, OPS-010, CON-012）
- **検証**: Inspection
- **Then** 各フェーズ終了時に PO 報告テンプレートによる報告があり、`docs/PROJECT_STATUS.md` がそのフェーズの状態を反映している。作業ブランチが `main` でない。仕様変更が ADR または `DECISION-LOG.md` にある。「完了」報告にはコマンドと結果（ログ・ファイルパス）が添えられている。
- **Then** Phase 4 / 5 のコードレビュー（Claude 自己レビュー + Codex）で、FR-090〜096 に該当する機能・そのための抽象化・設定項目が存在しないことを確認項目に含める。

### AC-033 Codex 独立レビュー（OPS-004, OPS-005, OPS-006）
- **検証**: Inspection
- **Then** Phase 3 / 4 / 5 / 7 で `reviews/` にレビュー依頼・Codex 原文（または失敗証拠: コマンド・終了コード・stderr）・採否記録が存在し、全指摘に Accept / Accept with modification / Reject / Deferred と根拠が付く。Codex 実行は `-s read-only` 相当でリポジトリを変更していない（`git status` で確認）。

### AC-034 Live 受入シナリオ一覧（Phase 5 出口条件）
- **検証**: Live（`BRIDGE_LIVE=1` 相当の明示フラグ + ログイン済み専用プロファイル）
- **Then** 以下 11 シナリオを Windows 実環境で実行し、各シナリオの request.json / result.json / 使用した prompt / 終了コード / 所要時間を `reviews/` または `docs/live-results/`（Phase 2 で確定）に記録する。プロンプトには一意の requestId を含め、回答と照合する。

| ID | シナリオ | 期待結果 | 関連 AC |
|---|---|---|---|
| LS-01 | 短い単純回答（1 段落） | `completed`、response.md に requestId | AC-003 |
| LS-02 | 複数段落 + 見出し + 箇条書き | `completed`、構造が保持 | AC-023 |
| LS-03 | fenced code block（言語指定あり） | `completed`、コードブロックが保持 | AC-023 |
| LS-04 | Markdown table | `completed`、表が保持 | AC-023 |
| LS-05 | 日本語と Unicode（絵文字・結合文字） | `completed`、文字化け無し | AC-023 |
| LS-06 | 長時間生成（`pro` または `extra_high`、2 分以上） | `completed`、途中保存無し | AC-019 |
| LS-07 | ログアウト状態 | `AUTH_REQUIRED`、終了コード 3、送信無し | AC-013 |
| LS-08 | 要求 preset が UI に無い | `MODEL_NOT_AVAILABLE`、送信無し | AC-015 |
| LS-09 | `timeoutMs` を短く設定 | `GENERATION_TIMEOUT`、再送無し | AC-020 |
| LS-10 | 生成中にブラウザ強制終了 | `BROWSER_CRASHED`、result.json あり、`submitted: yes` | AC-014 |
| LS-11 | 10,000 文字以上・複数改行・コードブロック混在の長文プロンプト | `completed`、投入内容の一致確認が通る | AC-017 |

## 11. 要件 → AC 対応表

| 要件 | AC |
|---|---|
| CON-001 | AC-029 |
| CON-002 | AC-003, AC-010 |
| CON-003 | AC-003 |
| CON-004 | AC-012 |
| CON-005 | AC-001, AC-029 |
| CON-006 | AC-024 |
| CON-007 | AC-015 |
| CON-008, CON-009 | AC-029 |
| CON-010 | AC-029, AC-031 |
| CON-011 | AC-013, AC-021 |
| CON-012 | AC-032 |
| CON-013, CON-014 | AC-027 |
| FR-001 | AC-001 |
| FR-002 | AC-002 |
| FR-003 | AC-003 |
| FR-004 | AC-004 |
| FR-005, FR-006 | AC-005 |
| FR-007, FR-008 | AC-006 |
| FR-009 | AC-006, AC-010 |
| FR-010 | AC-006, AC-007 |
| FR-011, FR-040 | AC-007 |
| FR-012 | AC-008 |
| FR-013 | AC-009 |
| FR-014 | AC-011 |
| FR-015 | AC-012 |
| FR-016 | AC-010 |
| FR-017 | AC-013 |
| FR-018, FR-019 | AC-014 |
| FR-020, FR-021 | AC-015 |
| FR-022 | AC-016 |
| FR-023, FR-024 | AC-017 |
| FR-025, FR-038, FR-042 | AC-018 |
| FR-026, FR-027 | AC-019 |
| FR-028 | AC-020 |
| FR-029 | AC-021 |
| FR-030, FR-031, FR-032, FR-034 | AC-022 |
| FR-033 | AC-023 |
| FR-035, FR-036, FR-037 | AC-024 |
| FR-015（プロファイルパス拒否） | AC-006, AC-012 |
| FR-039 | AC-025 |
| FR-041 | AC-026 |
| NFR-001, NFR-001a, NFR-002, NFR-010 | AC-027 |
| NFR-003 | AC-020 |
| NFR-004 | AC-019 |
| NFR-005, NFR-006 | AC-016 |
| NFR-007, NFR-008 | AC-028 |
| NFR-009 | AC-029 |
| NFR-011 | AC-030 |
| SEC-001 | AC-012 |
| SEC-002, SEC-003, SEC-005, SEC-008 | AC-029 |
| SEC-004 | AC-031 |
| SEC-006, SEC-009 | AC-030 |
| SEC-007 | AC-030, AC-002 |
| SEC-010 | AC-025, AC-029 |
| OPS-001, 002, 003, 007, 009, 010 | AC-032 |
| OPS-004, 005, 006 | AC-033 |
| OPS-008 | AC-016 |
| （Phase 5 出口条件） | AC-034 |

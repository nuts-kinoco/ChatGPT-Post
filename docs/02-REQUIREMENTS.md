# 02 — Requirements

| 項目 | 値 |
|---|---|
| 文書版 | 1.0 (Phase 1) |
| 作成日 | 2026-09-14 |
| 状態 | Phase 1 成果物。Phase 2 で設計へ展開、Phase 3 で Freeze |

## 0. 読み方

- ID 体系: `CON`（絶対条件・制約）、`FR`（機能）、`NFR`（非機能）、`SEC`（セキュリティ・プライバシー）、`OPS`（運用・開発プロセス）。
- 優先度は MoSCoW: **Must**（MVP 必須）、**Should**（MVP 内で強く推奨、落とす場合は PO 合意）、**Could**（MVP 内で余力があれば）、**Won't**（MVP では行わない。明示的に除外）。
- 各要件は `04-ACCEPTANCE-CRITERIA.md` の AC-ID と対応する。対応が無い Must は存在してはならない。
- 用語: **preset** = ChatGPT UI 上で選択するモデル / 思考 effort の組（`current | instant | medium | high | extra_high | pro`）。**呼び出し元** = Claude Code 等のローカルオーケストレータ。

## 1. 制約（CON）— PO 決定。変更不可

| ID | 制約 | 優先度 | AC |
|---|---|---|---|
| CON-001 | OpenAI API（無料枠・試用枠・API キー・従量課金を含む）を使用しない。代替案としても提示しない | Must | AC-029 |
| CON-002 | ChatGPT Web（chatgpt.com の通常 UI）を使用する | Must | AC-003, AC-010 |
| CON-003 | 送信だけでなく回答の回収まで行う | Must | AC-003 |
| CON-004 | ユーザーの通常 Chrome / Edge プロファイルを自動化しない。専用プロファイルを使う | Must | AC-012 |
| CON-005 | 可視（headed）ブラウザを基本とする。MVP で headless を優先しない | Must | AC-001, AC-029 |
| CON-006 | 単一リクエストを直列処理する。並列化しない | Must | AC-024 |
| CON-007 | 要求 preset が UI 上で選択・確認できない場合は送信せず失敗する（fail closed）。別 preset へ暗黙フォールバックしない。`current` 指定でも UI 表示から preset を観測できなければ同様に失敗する | Must | AC-015 |
| CON-008 | ChatGPT の内部 / 非公開 API を再現・直接呼び出ししない。ネットワーク傍受（`page.route` / `waitForResponse` 等）による完了検出も行わない。DOM・アクセシビリティ・通常 UI 操作のみ | Must | AC-029 |
| CON-009 | OCR や画面座標ベースの文字回収を使わない | Must | AC-029 |
| CON-010 | 秘密情報（Cookie、トークン、認証状態）をログ・Git・**必須成果物**（`response.md`, `result.json`, 標準出力）に残さない。診断用成果物（trace / screenshot）は SEC-010 の条件で扱う | Must | AC-029, AC-031 |
| CON-011 | CAPTCHA、再ログイン、利用上限、チャレンジ画面は手動介入ステータス（`manual_intervention_required`）で停止する。自動突破・回避しない | Must | AC-013, AC-021 |
| CON-012 | 実装前に仕様を固め、各フェーズにゲートを設ける | Must | AC-032 |
| CON-013 | Windows 10/11 を第一対象とする。Linux/macOS の完全対応は行わない | Must | AC-027 |
| CON-014 | Node.js LTS + TypeScript strict + Playwright を用いる | Must | AC-027 |

## 2. 機能要件（FR）

### 2.1 CLI とコマンド

| ID | 要件 | 優先度 | AC |
|---|---|---|---|
| FR-001 | `login` コマンド: 専用プロファイルで可視ブラウザを起動し、chatgpt.com を開き、人間がログインを完了するまで待機してから終了する。自動ログインは行わない | Must | AC-001 |
| FR-002 | `doctor` コマンド: Node/Playwright/ブラウザ実行ファイル/専用プロファイルの存在/ブリッジロック（`runtime/locks/` の有無・所有 PID・生存判定）/専用プロファイルの他プロセス占有/ログイン状態/書き込み先ディレクトリの権限を診断し、人間可読な結果と非ゼロ終了コードで異常を示す | Must | AC-002 |
| FR-003 | `run --request <path>` コマンド: 単一の `request.json` を処理し、`response.md` と `result.json` を書き出して終了する | Must | AC-003 |
| FR-004 | `inspect-ui` コマンド: 送信を行わずに、現在の ChatGPT UI の主要要素（入力欄、送信ボタン、モデル選択、assistant メッセージ、生成中表示）の検出結果と候補 selector の一致状況、preset 選択肢一覧を出力する。`--dump-dom` オプションは生 DOM を `runtime/artifacts/inspect-ui/` にのみ保存する（gitignore、共有禁止）。UI 変更時の診断用 | Must | AC-004 |
| FR-005 | 標準出力は人間向けの簡潔な進捗、標準エラーは診断、最終結果は `result.json` と終了コードで返す | Must | AC-005 |
| FR-006 | 終了コードを定義する: 0=completed、1=ブラウザ起動後の失敗または送信状態不明、2=不正な入力・設定（`INVALID_REQUEST` / `INVALID_CONFIG`）、3=手動介入必要、4=起動前停止（`ALREADY_PROCESSED` / `ALREADY_RUNNING` は result.json を書かず、`PROFILE_IN_USE` / `BROWSER_LAUNCH_FAILED` は書く）。呼び出し元は 4 を「何も送信されていない。result.json があれば読み、無ければ stderr」と解釈する。正式表は `13-ERROR-MODEL.md` §3 | Must | AC-005 |

### 2.2 入出力契約

| ID | 要件 | 優先度 | AC |
|---|---|---|---|
| FR-007 | `request.json` を受け取る。必須フィールド: `schemaVersion`, `requestId`, `promptFile`, `preset`, `newChat`, `responseFormat`。`timeoutMs` は任意（省略時 900000、A-030）。`requestId` は末尾英数字のパターンに一致し、Windows 予約デバイス名を含まない。JSON Schema は `schemas/request.schema.json` | Must | AC-006 |
| FR-008 | `request.json` はスキーマ検証し、不正なら送信前に `INVALID_REQUEST` で失敗する | Must | AC-006 |
| FR-009 | `promptFile` の内容（UTF-8 Markdown。先頭 BOM は除去）をそのままプロンプトとして投入する。`request.json` も先頭 BOM を除去して読む。空・空白のみのプロンプトは送信前に拒否する | Must | AC-006, AC-010 |
| FR-010 | `result.json` を書き出し、成功・失敗・手動介入のいずれでも最終状態が一意に分かるようにする。最低限のフィールド: `schemaVersion`, `requestId`, `status`, `requestedPreset`, `observedPreset`, `responseFile`, `conversationUrl`, `startedAt`, `completedAt`, `durationMs`, `artifacts`, `warnings`（best-effort 処理の失敗記録）, `error`, `extractionMethod`, `extractionQuality`, `submitted`（`yes` / `no` / `unknown`）, `bridgeVersion`。`observedPreset` は観測値であり `current` を取らない。出力先は `request.json` と同じディレクトリ（12-IO-CONTRACT で確定）。`requestDir/result.json` が無いのに `response.md` が存在する場合は `INVALID_REQUEST`（`cause: stale_response`）で停止し、`response.md` を削除しない。**`result.json` を書かない例外**（終了コードと標準エラーのみで通知）: (1) `request.json` が存在しない・JSON として読めない（終了コード 2）、(2) `ALREADY_PROCESSED`（既存 `result.json` を保護、終了コード 4）、(3) `ALREADY_RUNNING`（同一 requestId の進行中結果を壊さないため、終了コード 4）、(4) `result.json` 自身の書き出し失敗（終了コード 1、`result.json` は存在しない可能性がある）。処理順序: `request.json` 読取 → `requestDir/result.json` の有無（`ALREADY_PROCESSED`）→ スキーマ検証・プロファイルパス検証（FR-008 / SEC-001）→ ロック取得（FR-035）→ **ロック保持下で** `runtime/state/<requestId>/submit.marker` の有無（`SUBMIT_STATE_UNKNOWN`）→ プロファイル占有プリチェック（FR-019）→ ブラウザ起動（A-017 改訂） | Must | AC-006, AC-007 |
| FR-011 | `status` は `completed`, `failed`, `manual_intervention_required` の 3 値。`error` は `code`, `message`, `retryable`, `phase`, `cause` を持ち、`status == "completed"` のときのみ `null`。エラーコードと status の対応は §7 | Must | AC-007 |
| FR-012 | 成功時、回答本文の末尾の空白・改行を除去し LF を 1 つ付与して `response.md` へ UTF-8（BOM 無し）で書き出す | Must | AC-008 |
| FR-013 | `response.md` / `result.json` は同一ディレクトリの一時ファイルへ書き、fsync 後に同一ファイルシステム上でアトミックにリネームする。読み手が途中書き込みを観測しない。`response.md` の書き出し失敗は `WRITE_FAILED` として `result.json` に記録する。`result.json` 自身の書き出し失敗は FR-010 例外 (4) | Must | AC-009 |
| FR-014 | 同じ `requestId` の `result.json` が既に存在する場合、スキーマ検証・ロック取得・ブラウザ起動のいずれも行わず、既存 `result.json` を上書きせず、終了コード 4 と標準エラー（`ALREADY_PROCESSED`）で終了する（冪等性）。`requestDir/result.json` が無く `runtime/state/<requestId>/submit.marker` がある場合（前回の異常終了、または同じ requestId を別ディレクトリで再実行）は、**ロック取得後に**ブラウザを起動せず `SUBMIT_STATE_UNKNOWN`（`submitted: unknown`）の `result.json` を書いて終了コード 1 で終了する | Must | AC-011 |

### 2.3 ブラウザとセッション

| ID | 要件 | 優先度 | AC |
|---|---|---|---|
| FR-015 | Playwright `launchPersistentContext` で `runtime/profile/` 配下の専用 user data directory を使う。パスは設定可能だが、`realpath` で解決した canonical path が通常 Chrome / Edge / Chromium / Firefox の User Data を指す・含まれる場合、およびパスの最終要素または祖先が symlink / junction（reparse point）である場合は `doctor` / `run` が起動前に拒否する（`INVALID_CONFIG`） | Must | AC-012 |
| FR-016 | 送信前に以下をすべて確認し、一つでも確認できなければ送信しない: (a) chatgpt.com ドメイン（失敗時 `INVALID_STATE`。ログイン系ドメインへのリダイレクトは (b) の `AUTH_REQUIRED`）、(b) ログイン済み、(c) 入力欄が一意に特定できる、(d) 新規チャット（URL に `/c/` を含まない）、(e) UI 表示から preset を一意に観測でき、かつ（`current` 以外では）要求 preset と一致し、送信直前（marker 書込前）と click 直前の再観測でも変化していない、(f) 生成中でない（停止ボタン不在）、(g) prompt が空でない。ロック（FR-035）はブラウザ起動前に取得済みであり本項の対象外 | Must | AC-010 |
| FR-017 | ログイン画面・CAPTCHA・Cloudflare/Turnstile・同意画面・利用上限バナーを検出した場合、`manual_intervention_required` で停止し、スクリーンショットを残す。自動突破・待機・再送を行わない。暫定コード: ログイン画面→`AUTH_REQUIRED`、CAPTCHA/Cloudflare/Turnstile→`CAPTCHA_OR_CHALLENGE`、同意画面→`MANUAL_INTERVENTION_REQUIRED`、利用上限→`RATE_LIMITED` | Must | AC-013 |
| FR-018 | ブラウザプロセスのクラッシュ・切断を検出し `BROWSER_CRASHED` で終了する | Must | AC-014 |
| FR-019 | ブラウザ起動前に専用プロファイルの占有をプリチェック（`profileDir/lockfile` の排他オープン。成立しない場合は WMI）し、ブリッジ以外のプロセスが使用中なら `PROFILE_IN_USE` で終了する。プリチェック通過後の起動例外は `BROWSER_LAUNCH_FAILED`。ブリッジ自身の single-flight ロック（FR-035）が取れない場合は `ALREADY_RUNNING` であり、三者を区別する | Must | AC-014 |

### 2.4 preset（モデル / effort）選択

| ID | 要件 | 優先度 | AC |
|---|---|---|---|
| FR-020 | `preset` は `current | instant | medium | high | extra_high | pro` を受け付ける。`current` は UI の現在選択を変更せず、観測値を `observedPreset` に記録する。**`current` でも UI 表示から preset を観測できない場合は `MODEL_NOT_VERIFIABLE` で送信せず失敗する**（CON-007） | Must | AC-015 |
| FR-021 | `current` 以外は UI のモデル/effort 選択 UI を操作して選択し、選択後（送信前）に UI 表示を読み取って要求値と一致することを確認する。要求 preset が UI に存在しなければ `MODEL_NOT_AVAILABLE`、表示を読めない・一致しなければ `MODEL_NOT_VERIFIABLE` で送信せず失敗する。送信後・生成中のモデル切替は検出対象外（R-005 / R-012 残存リスク） | Must | AC-015 |
| FR-022 | preset と UI 表示文字列（日本語・英語）の対応表は selector 集約点と同じ場所で一元管理する | Must | AC-016 |

### 2.5 送信と完了検出

| ID | 要件 | 優先度 | AC |
|---|---|---|---|
| FR-023 | 新規チャット（`newChat: true`）を開いてからプロンプトを投入する。MVP では `newChat: false` は `INVALID_REQUEST` とする | Must | AC-017 |
| FR-024 | プロンプト投入後、送信前に入力欄の内容が投入内容と一致することを確認する（長文・改行・Unicode の欠落防止） | Must | AC-017 |
| FR-025 | 送信直前に `runtime/state/<requestId>/submit.marker`（write-ahead、tmp → fsync → rename）を書き、直前の状態（時刻、assistant メッセージ数、URL、preset 表示）を記録する。送信直後に `dispatchedAt` / `urlAfter` を追記する。マーカーを書けなければ送信しない。送信操作は 1 リクエストにつき最大 1 回 | Must | AC-018 |
| FR-026 | 生成完了判定は固定 sleep のみに依存せず、複数信号を組み合わせる: 送信前 assistant 数の記録 → 新 assistant 出現（増分がちょうど 1）→ 生成中 UI/停止ボタンの出現 → その消失 → **停止ボタン消失を起点として**最新回答 DOM の一定期間不変 → 入力欄・送信ボタンの復帰 → エラーバナー・打ち切り表示・チャレンジ無し。本文の空判定は抽出層に委ねる（FR-034） | Must | AC-019 |
| FR-027 | 生成中 UI を観測できなかった場合の代替経路（assistant 出現・より長い安定化・送信ボタン復帰・メッセージ単位のコピー操作の可用化）を持つ。ただし完了を確認できない場合は成功扱いにしない | Must | AC-019 |
| FR-028 | `timeoutMs` 経過で `GENERATION_TIMEOUT` として停止する。タイムアウト時に「送信されていない」と推測して再送しない | Must | AC-020 |
| FR-029 | 生成中のネットワーク切断・ChatGPT 側エラーバナー（role=alert またはターン内のエラー文言）・出力上限による打ち切り（「続きを生成」表示。自動クリックしない）・複数回答（A/B 比較）は `CHAT_ERROR`（status `failed`、`cause` に `banner` / `network` / `output_truncated` / `multiple_responses`）、レート制限・利用上限表示は `RATE_LIMITED`（status `manual_intervention_required`、CON-011）に分類する。いずれも自動待機・再送しない | Must | AC-021 |

### 2.6 回答抽出

| ID | 要件 | 優先度 | AC |
|---|---|---|---|
| FR-030 | 抽出対象は「送信後に出現した最新の assistant メッセージ」であり、`requestId` を含む Live テストで照合できること | Must | AC-022 |
| FR-031 | 抽出方式の優先順位: (1) 最新 assistant メッセージの「コピー」操作をクリックし、ページ内フックで捕捉したテキスト（システムクリップボードは使わない、ADR-004）を Markdown 相当として取得し、**取得内容を同メッセージの `innerText` と照合（正規化後の包含・長さ比較）して一致しなければ (2) へ進む**、(2) メッセージ DOM の HTML を Markdown へ変換、(3) `innerText` を保存し `extractionQuality: degraded` を記録 | Must | AC-022 |
| FR-032 | `result.json` に採用した抽出方式 `extractionMethod`（`copy` / `dom` / `innerText`）と品質 `extractionQuality`（`full` / `degraded`）を記録する。`completed` 以外では `null` | Must | AC-022 |
| FR-033 | コードブロック（言語指定含む）、表、見出し、箇条書き、リンク、引用、数式、Unicode、日本語が欠落・破損しないことをテストで担保する | Must | AC-023 |
| FR-034 | 回答が空（`cause: empty`）、または Canvas 等のサイドパネルに本文が生成された（`cause: canvas`）場合は `EXTRACTION_FAILED` で失敗し、`response.md` を書かない。完了判定は本文が空でも完了を返し、空の判定は抽出層が行う | Must | AC-022 |

### 2.7 排他制御と二重送信防止

| ID | 要件 | 優先度 | AC |
|---|---|---|---|
| FR-035 | プロセス全体の single-flight ロック（`runtime/locks/bridge.lock`、O_EXCL）を、専用プロファイルを開くすべてのコマンド（`run`, `login`, `inspect-ui`, ブラウザを起動する `doctor` の診断項目）が取得する。取得できなければ `ALREADY_RUNNING` で即終了する（`doctor` は NG 項目として報告）。解放はブラウザ終了の後に行う | Must | AC-024 |
| FR-036 | 同一 requestId の同時実行を防ぐ。実現はプロセスロック（FR-035）と、requestId でグローバルな `submit.marker` / `requestDir/result.json` の存在判定の組み合わせで行い、別ファイルの requestId ロックは持たない（A-031, ADR-005）。marker の判定はロック保持下でのみ行い、拒否された側は進行中リクエストの `result.json` を書き換えない（FR-010 例外 (3)） | Must | AC-024 |
| FR-037 | 異常終了時に残ったブリッジのロックは、所有 PID の生存確認と起動時刻照合（PID 再利用検出）により stale と判定し、内容照合付きの rename で回収する（他者の生きた lock を奪った場合は元に戻して `ALREADY_RUNNING`）。ロックは所有トークンを持ち、取得直後・`submit.marker` 書込直前・解放時に再検証する。奪われたプロセスは送信せずに終了する。PID が生存している、または判断できない場合は `ALREADY_RUNNING` 側に倒す | Must | AC-024 |
| FR-038 | 送信後の不明状態（送信済みか判断できない）から同一リクエストを自動再送しない | Must | AC-018 |

### 2.8 エラー・診断成果物

| ID | 要件 | 優先度 | AC |
|---|---|---|---|
| FR-039 | ブラウザ起動後の失敗時にスクリーンショットと Playwright trace を `runtime/artifacts/<requestId>/` に保存し、`result.json.artifacts` にパスを列挙する。artifacts は `result.json` より先に書くが、その取得・保存の失敗は `result.json` の書き出しを妨げない（best-effort。失敗は `warnings` に記録）。ブラウザ起動前の失敗（`INVALID_REQUEST`, `INVALID_CONFIG`, `ALREADY_RUNNING`, `PROFILE_IN_USE`, `BROWSER_LAUNCH_FAILED`, `ALREADY_PROCESSED`, `SUBMIT_STATE_UNKNOWN`）では `artifacts` は空配列。`BROWSER_CRASHED` では trace・スクリーンショットとも best-effort（取得できた分だけ列挙） | Must | AC-025 |
| FR-040 | エラーコードは `13-ERROR-MODEL.md`（Phase 2）で一意に定義し、最終状態と原因コードを必ず一意に返す。状態遷移とエラーコードを混同しない | Must | AC-007 |
| FR-041 | 送信前に操作対象の UI 要素（exactly-one）を確認できない・想定外構造の場合は誤操作せず `DOM_CHANGED` で停止し、`inspect-ui` 相当の selector 一致状況を診断ファイルとして `artifacts` に含める。存在検出用の要素（エラーバナー、チャレンジ等）は全候補を OR 評価し、0 件でも `DOM_CHANGED` にしない。送信後は `DOM_CHANGED` を発生させず、抽出方式の降格で扱う | Must | AC-026 |
| FR-042 | 自動再試行は送信前の一時的な UI 待機・ページロード・selector 再解決に限り、回数上限を持つ。送信後・CAPTCHA・認証・利用上限・preset 不一致では再試行しない | Must | AC-018 |

### 2.9 MVP 後（Won't for MVP）

| ID | 要件 | 優先度 |
|---|---|---|
| FR-090 | 添付ファイル・画像入力・画像生成・音声 | Won't |
| FR-091 | 既存会話の継続、プロジェクト指定、Custom GPT、一時チャット | Won't |
| FR-092 | 複数アカウント、複数ブラウザ並列 | Won't |
| FR-093 | サーバー常駐、HTTP REST API、Redis/DB/メッセージブローカー、ファイルキュー監視 | Won't |
| FR-094 | 自動ログイン、CAPTCHA 回避、bot 検知回避、UA / fingerprint 偽装、stealth plugin | Won't（恒久的禁止） |
| FR-095 | ChatGPT 内部ネットワーク通信の解析・再送・HAR 保存 | Won't（恒久的禁止） |
| FR-096 | Linux / macOS の完全対応 | Won't |

## 3. 非機能要件（NFR）

| ID | 要件 | 優先度 | AC |
|---|---|---|---|
| NFR-001 | Windows 10/11 + PowerShell 5.1 から起動できる。パスは Windows 形式（`C:\...`）と `/` 混在を許容する | Must | AC-027 |
| NFR-001a | PowerShell 7 からも起動できる。現環境に未インストールのため OQ-008 の判断で Must に昇格または対象外とする | Could | AC-027 |
| NFR-002 | Node.js LTS（現環境 v24）で動作する。TypeScript は `strict: true` | Must | AC-027 |
| NFR-003 | 1 リクエストの既定タイムアウトは 15 分（900000 ms）。`request.json` の `timeoutMs` で上書き可能（10 s〜60 分）。送信後は `timeoutMs` が他のあらゆる待機より優先して `GENERATION_TIMEOUT` を発生させる。送信前フェーズの上限は `11-STATE-MACHINE.md` §5 | Must | AC-020 |
| NFR-004 | 固定 sleep の合計は 1 リクエストあたり数秒以内に抑え、待機は条件付き待機を基本とする | Should | AC-019 |
| NFR-005 | selector は一か所（単一モジュール）に集約し、各 selector に用途・代替候補・確認条件を持たせる。優先順位: getByRole → getByLabel/Placeholder → data-testid → テキスト+構造 → CSS → XPath | Must | AC-016 |
| NFR-006 | 日本語 UI と英語 UI の双方を扱う。単一の文字列に依存しない | Must | AC-016 |
| NFR-007 | ブラウザ操作層・状態機械・抽出層・I/O 契約層を分離し、ブラウザ無しで状態機械と抽出をユニットテストできる | Must | AC-028 |
| NFR-008 | Unit / fixture テストは CI 相当（ネットワーク・ログイン不要）で実行できる。Live テストは明示フラグとログイン済みプロファイルを要求し、既定では実行しない | Must | AC-028 |
| NFR-009 | 外部テレメトリ、自動更新、外部送信を実装しない | Must | AC-029 |
| NFR-010 | パッケージマネージャは npm のみ。Lint/Format は ESLint + Prettier または Biome のどちらか一方（Phase 2 で決定） | Should | AC-027 |
| NFR-011 | README に新規 Windows 環境向けセットアップ手順・運用手順・トラブルシューティングを含む | Must | AC-030 |

## 4. セキュリティ・プライバシー要件（SEC）

| ID | 要件 | 優先度 | AC |
|---|---|---|---|
| SEC-001 | 通常 Chrome / Edge の `User Data` を指定不可。専用プロファイル以外の Cookie DB を読まない | Must | AC-012 |
| SEC-002 | Cookie・トークン・Authorization ヘッダーをプログラム内で取り出さない、ログに書かない、ファイルへ書き出さない（Playwright `storageState()` の書き出しも行わない） | Must | AC-029 |
| SEC-003 | HAR を保存・要求しない | Must | AC-029 |
| SEC-004 | `runtime/`（profile, requests, responses, locks, artifacts）、trace、screenshots、ログ、`.env` を `.gitignore` に含める | Must | AC-031 |
| SEC-005 | ログはプロンプト・回答本文を既定で全文出力しない（先頭 200 文字と総文字数のみ）。redaction をユニットテストする | Must | AC-029 |
| SEC-006 | README に「Playwright trace とスクリーンショットには認証情報・個人情報が含まれ得るため共有時に注意」と明記する | Must | AC-030 |
| SEC-007 | prompt / response はローカルにのみ保持する。MVP では保持期間の自動削除は行わず、その旨を README に明記する（将来設定可能）。`runtime/state/`（送信監査台帳）は一般削除の対象外とし、`doctor` が欠落を警告する | Must | AC-030, AC-002 |
| SEC-008 | CAPTCHA solver、stealth plugin、UA/fingerprint 偽装、IP/アカウントローテーション、レート制限回避を実装しない | Must | AC-029 |
| SEC-009 | 規約・アカウントリスクを README と `03-RISK-REGISTER.md` に明記し、以降のフェーズで削除しない。本プロジェクトのいかなる文書・報告でも「規約上問題ない」「規約リスクは解消した」と表現しない | Must | AC-030 |
| SEC-010 | 診断用成果物（Playwright trace / スクリーンショット）は失敗時のみ既定で保存し、trace はネットワーク本文・ヘッダーを記録しない設定（Playwright の `snapshots` / `screenshots` のみ、`sources` なし等）で取得する。Cookie / Authorization ヘッダーが trace に含まれない設定を Phase 2 `15-SECURITY-AND-PRIVACY.md` で確定し、テストで確認する。設定上除外できない情報が残る場合は README に明記する（SEC-006） | Must | AC-025, AC-029 |

## 5. 運用・開発プロセス要件（OPS）

| ID | 要件 | 優先度 | AC |
|---|---|---|---|
| OPS-001 | 各フェーズ終了時に PO 報告テンプレートで報告し、続行指示があるまで次フェーズのファイル変更を行わない | Must | AC-032 |
| OPS-002 | `docs/PROJECT_STATUS.md` を作業中に更新する | Must | AC-032 |
| OPS-003 | main へ直接作業しない。フェーズ用 branch を使う | Should | AC-032 |
| OPS-004 | Codex Pro は独立レビュー担当。非対話 `codex exec` で編集禁止のレビューを行い、原文を `reviews/` に保存。Claude が採否（Accept / Accept with modification / Reject / Deferred）を記録する | Must | AC-033 |
| OPS-005 | Codex 起動失敗時は失敗証拠を保存し、Claude 自身の敵対的レビューで代替し、「外部レビュー未実施」と報告する | Must | AC-033 |
| OPS-006 | Claude と Codex に同一 worktree を同時編集させない | Must | AC-033 |
| OPS-007 | 仕様変更は ADR または `DECISION-LOG.md` に記録する | Must | AC-032 |
| OPS-008 | selector は推測で実装せず、実画面または sanitized fixture で確認する | Must | AC-016 |
| OPS-009 | 「完成」「解決」は動作証拠（テスト結果・trace・出力ファイル）を伴う | Must | AC-032 |
| OPS-010 | FR-090〜096 の Won't に該当する機能、およびそれらを見越した抽象化・拡張点・設定項目を MVP に入れない。「将来必要そう」は理由にならない | Must | AC-032 |

## 6. 未決事項（Open Questions）

| ID | 内容 | 決定者 | 期限 |
|---|---|---|---|
| OQ-001 | OpenAI 利用規約の最新版を PO が手動確認し、R-001 の記述を更新する | PO | Phase 3 Freeze 前 |
| OQ-002 | ChatGPT UI 上の preset と実際の UI 表示の対応 | **一部解決（Phase 4, A-061）**: 思考量スライダー 5 段階。段階 3 = 「極高」= `extra_high` を確定。残り 4 段階のラベルは Phase 5 の選択実装で確定 | Phase 5 |
| OQ-003 | 「コピー」操作が Markdown を返すか、`navigator.clipboard.writeText` を呼ぶか | **解決（Phase 4, A-062）**: `writeText` で Markdown（fence 言語付き）を書く。ページ内フックで捕捉、システムクリップボード不使用 | — |
| OQ-004 | ブラウザ実行ファイルは Playwright 同梱 Chromium か、インストール済み Chrome か | **解決（Phase 2, A-020）**: 既定 `channel: 'chrome'`、環境変数で `chromium` に切替可（ADR-002） | — |
| OQ-005 | Lint/Format | **解決（Phase 2, A-021）**: Biome | — |
| OQ-006 | `requestId` の形式と生成責任 | **解決（Phase 2, A-022）**: 呼び出し元が生成。`^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$`、推奨 `<yyyyMMddTHHmmssZ>-<8 hex>`（12-IO-CONTRACT） | — |
| OQ-007 | クリップボード方式が PO の同時作業と衝突する | **解決（Phase 2, A-023）**: システムクリップボードを使わず、ページ内で `navigator.clipboard.writeText` を捕捉する方式に変更（ADR-004）。衝突自体が消えるため PO 判断不要 | — |
| OQ-008 | PowerShell 7（`pwsh`）は現環境に未インストール。AC-027 の PS7 検証を Phase 6 で導入して行うか、5.1 のみに限定するか | PO | Phase 6 |
| OQ-009 | 既定選択が Auto 系の場合の `current` の扱い | **再定義（Phase 4, A-061）**: preset は effort スライダーの段階であり、モデル側の「最新」（Auto 相当）は preset の対象外。effort は常に 5 段階のいずれかなので `current` は必ず逆引きできる（未登録段階は Phase 5 でラベル確定まで `MODEL_NOT_VERIFIABLE`）。モデルを preset に含めるかは Phase 5 で PO 判断 | Phase 5 |

## 7. エラーコード一覧（確定: `13-ERROR-MODEL.md` §2 と同一。変更時は両方と `04` を更新）

状態遷移（`11-STATE-MACHINE.md`）とエラーコードは別物である。本表は `result.json.error.code` の一覧と、`status` / `retryable` / 終了コード / ブラウザ起動要否 / `result.json` 出力有無の対応を示す。

| code | status | retryable | 終了コード | ブラウザ起動後か | result.json | 発生箇所 |
|---|---|---|---|---|---|---|
| `INVALID_REQUEST` | failed | false | 2 | 前 | 書く（request.json が読めない場合は書かない） | FR-008, FR-009, FR-023, FR-010（`stale_response`） |
| `INVALID_CONFIG` | failed | false | 2 | 前 | 書く | FR-015 / SEC-001（プロファイルパス） |
| `ALREADY_PROCESSED` | （既存を保持） | false | 4 | 前 | **書かない**（標準エラーのみ） | FR-014 |
| `ALREADY_RUNNING` | （進行中を保持） | false | 4 | 前 / 後（`lock_lost`、送信なし） | **書かない**（標準エラーのみ） | FR-035, FR-036, FR-037 |
| `SUBMIT_STATE_UNKNOWN` | failed | false | 1 | 前 | 書く（`submitted: unknown`） | FR-014（前回の `submit.marker` が残存） |
| `PROFILE_IN_USE` | failed | false | 4 | 前（プリチェック） | 書く | FR-019 |
| `BROWSER_LAUNCH_FAILED` | failed | false | 4 | 前（起動失敗） | 書く（trace 無し） | FR-019 |
| `INVALID_STATE` | failed | false | 1 | 後 | 書く | FR-016 (a)、ページロード失敗の上限超過 |
| `AUTH_REQUIRED` | manual_intervention_required | false | 3 | 後 | 書く | FR-017（送信前・生成中） |
| `CAPTCHA_OR_CHALLENGE` | manual_intervention_required | false | 3 | 後 | 書く | FR-017（送信前・生成中） |
| `MANUAL_INTERVENTION_REQUIRED` | manual_intervention_required | false | 3 | 後 | 書く | FR-017（同意画面等） |
| `RATE_LIMITED` | manual_intervention_required | false | 3 | 後 | 書く | FR-017, FR-029 |
| `MODEL_NOT_AVAILABLE` | failed | false | 1 | 後 | 書く | FR-021 |
| `MODEL_NOT_VERIFIABLE` | failed | false | 1 | 後 | 書く | FR-020, FR-021, FR-016 (e)（click 直前の変化は `cause: preset_changed`、`submitted: no`） |
| `PROMPT_INPUT_FAILED` | failed | false | 1 | 後 | 書く | FR-024 |
| `PROMPT_SUBMIT_FAILED` | failed | false | 1 | 後 | 書く | FR-016 (d)(f)、送信操作の失敗・解決済み送信ボタンの消失（`submitted: unknown`） |
| `GENERATION_TIMEOUT` | failed | false | 1 | 後 | 書く | FR-028 |
| `CHAT_ERROR` | failed | false | 1 | 後 | 書く（`cause`: banner / network / output_truncated / multiple_responses） | FR-029 |
| `DOM_CHANGED` | failed | false | 1 | 後（`PROMPT_ENTERED` まで） | 書く | FR-041 |
| `EXTRACTION_FAILED` | failed | false | 1 | 後 | 書く（`cause`: empty / canvas） | FR-034 |
| `BROWSER_CRASHED` | failed | false | 1 | 後 | 書く（trace は best-effort） | FR-018 |
| `WRITE_FAILED` | failed | false | 1 | 後 | 書く（marker / `response.md` の失敗）/ 書けない（`result.json` 自身の失敗、FR-010 例外 (4)） | FR-013, FR-025 |
| `INTERNAL_ERROR` | failed | false | 1 | 任意 | 可能なら書く | ブリッジ内部の未分類例外 |

`retryable` は MVP では全コードで `false`。送信前の一時的な失敗（ページロード等）は FR-042 の内部再試行で吸収し、上限超過後は上記コードに分類する。

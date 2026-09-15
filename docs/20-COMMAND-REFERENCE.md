# ChatGPT Web Bridge — コマンドリファレンス（貼り付け用）

対象バージョン: 0.1.0（Phase 5 時点、2026-09-15、契約 1.1）。このファイルは単体で他の文書やチャットに貼り付けられるよう、前提を含めて自己完結させている。

## 0. 前提

- Windows 11、Node.js 24、Google Chrome（stable）がインストール済み
- リポジトリ: `S:\Projects\chatgpt-web-bridge`（以下 `<repo>`）
- ブラウザは **専用プロファイル** `<repo>\runtime\profile` を使う。普段使いの Chrome プロファイルには一切触れない
- 1 プロセス 1 リクエスト。並行実行はしない（2 つ目は `ALREADY_RUNNING` で止まる）
- OpenAI API は使わない。ChatGPT Web の画面操作のみ

## 1. 初回セットアップ

```powershell
cd S:\Projects\chatgpt-web-bridge
npm ci
npm run build
npm link
chatgpt-bridge doctor
```

`npm link` で `chatgpt-bridge` がどのディレクトリからでも使える（以下の例はこの形）。link しない場合は `node S:\Projects\chatgpt-web-bridge\dist\cli\main.js <command>` と読み替える。

## 2. ログイン（初回のみ / セッション切れ時）

### 2a. Google アカウントの場合（推奨）

Google は自動操作中のブラウザでのログインを拒否する。ブリッジはこれを回避しないので、**自動操作なしの通常 Chrome を専用プロファイルで起動**してログインする。

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="S:\Projects\chatgpt-web-bridge\runtime\profile" https://chatgpt.com/
```

1. 開いたウィンドウで chatgpt.com にログインする
2. ページが読み込み終わってから **ウィンドウを閉じる**（開いたままだと `PROFILE_IN_USE`。閉じるのが早いとセッションが保存されない）
3. `chatgpt-bridge doctor` で `login: logged in` を確認

### 2b. メールアドレス + 確認コードの場合

```powershell
chatgpt-bridge login
```

ブリッジが専用ブラウザを開くので、その中でログインする。ログイン導線が消えると自動終了する（Enter で強制終了）。

## 3. 診断

```powershell
chatgpt-bridge doctor
```

出力項目: node / playwright / browser / profile.path / profile.exists / profile.free / profile.processes / lock / runtime dirs / login。すべて OK で exit 0、1 つでも NG で exit 1。

```powershell
chatgpt-bridge inspect-ui
chatgpt-bridge inspect-ui --walk-effort
chatgpt-bridge inspect-ui --dump-dom
```

UI 要素の検出状況・思考量スライダー・モデル選択肢を JSON で `runtime/artifacts/inspect-ui/<timestamp>/` に出力する。**送信はしない**。`--walk-effort` はスライダーを全段階なめてラベルを記録し、元の段階に戻す（UI 変更時のラベル確認用）。`--dump-dom` は生 DOM を保存する（個人情報を含むので共有しない）。

```powershell
chatgpt-bridge usage
chatgpt-bridge usage --json
```

ブリッジ経由で送った件数を、モデル種別 × 移動窓（Pro 系 = 週、Thinking / Instant = 日、添付 = 3 時間）で集計し、`runtime/limits.json` の上限と比べる。**手動送信分は含まれない下限値**で、上限値は ChatGPT 自身の回答（公式未確認）。`runtime/limits.json` は初回に生成され、編集できる。

## 4. リクエストの実行

### 4a. ファイルを用意する

```
<repo>\runtime\requests\<requestId>\
  request.json
  prompt.md
```

`request.json`:

```json
{
  "schemaVersion": "1.1",
  "requestId": "20260915T061014Z-6e8c7591",
  "promptFile": "prompt.md",
  "attachments": ["inventory.ts"],
  "preset": "high",
  "model": "latest",
  "newChat": true,
  "timeoutMs": 300000,
  "responseFormat": "markdown"
}
```

| 項目 | 値 | 備考 |
|---|---|---|
| `schemaVersion` | `"1.0"` または `"1.1"` | 1.1 で `model` / `attachments` が使える |
| `requestId` | `^[A-Za-z0-9][A-Za-z0-9._-]{6,62}[A-Za-z0-9]$` | 推奨 `<yyyyMMddTHHmmssZ>-<8 hex>`。ディレクトリ名になる。Windows 予約名（CON, NUL 等）不可 |
| `promptFile` | 相対 or 絶対パス | 相対は `request.json` の場所基準。UTF-8（BOM 可）。**20,000 文字まで**（超えると exit 2。長い内容は添付に） |
| `attachments` | パスの配列（任意、最大 20） | composer に添付するファイル。相対は `request.json` 基準。1 ファイル 100 MB まで。`.env` / 鍵 / `node_modules` 配下 / 秘密らしい内容 / 空 / 同名重複は送信前に exit 2 |
| `preset` | `current` / `instant` / `medium` / `high` / `extra_high` / `pro` | **思考量**（画面の Instant / 中程度 / 高 / 極高 / Pro）。`current` は現在値をそのまま使う。`pro` は「最新」モデルでは GPT-6 Pro になり週次上限（目安 50 件）を消費する |
| `model` | `current` / `latest` / `gpt-5.6-sol` / `gpt-5.5`（任意、既定 `current`） | 画面のモデル選択（最新 / GPT-5.6 Sol / GPT-5.5）。`current` は観測のみ（ページ読込ごとに「最新」に戻るので実質 `latest`） |
| `newChat` | `true` 固定 | 既存チャットへの追記は未対応 |
| `timeoutMs` | 10000〜3600000 | 省略時 900000（15 分） |
| `responseFormat` | `"markdown"` 固定 | |

### 4b. 実行する

```powershell
chatgpt-bridge run --request .\runtime\requests\<requestId>\request.json
chatgpt-bridge run --request .\runtime\requests\<requestId>\request.json --json
```

標準出力の最後に `status=<status> submitted=<yes|no|unknown> [code=<ERROR_CODE>]` と `result:` の絶対パスが出る。`--json` なら result.json の内容 + `exitCode` + `resultPath` を 1 行の JSON で出す（オーケストレータ向け。result.json が書かれない `ALREADY_RUNNING` 等では `status: "not_started"` のスタブ）。

実行中、ブリッジは `preset` に合わせてアカウントの思考量設定を変更し、**終了時に元の段階へ戻す**。

### 4c. 出力

```
<repo>\runtime\requests\<requestId>\
  response.md      … 回答本文（Markdown）。失敗時は作られない
  result.json      … 実行結果。ALREADY_RUNNING 以外では必ず作られる
```

`result.json` 例（成功）:

```json
{
  "schemaVersion": "1.1",
  "bridgeVersion": "0.1.0",
  "requestId": "20260915T061014Z-6e8c7591",
  "status": "completed",
  "requestedPreset": "high",
  "observedPreset": "high",
  "requestedModel": "latest",
  "observedModel": "latest",
  "observedModelSlug": "gpt-5-6-thinking",
  "submitted": "yes",
  "conversationUrl": "https://chatgpt.com/c/<uuid>",
  "responseFile": "S:\\...\\response.md",
  "extractionMethod": "copy",
  "extractionQuality": "full",
  "startedAt": "2026-09-15T06:10:14.947Z",
  "completedAt": "2026-09-15T06:10:38.327Z",
  "durationMs": 23380,
  "artifacts": [],
  "warnings": [],
  "error": null
}
```

| 項目 | 意味 |
|---|---|
| `status` | `completed` / `failed` / `manual_intervention_required` / `already_processed` |
| `submitted` | `yes`: ChatGPT に送信済み。`no`: 送信前に停止。`unknown`: 送信したか不明（**再実行禁止**。ブラウザで会話を確認） |
| `observedPreset` | 送信直前に画面で読み取った思考量（`current` の実体） |
| `observedModel` / `observedModelSlug` | 送信前に確認したモデルと、回答ターンの内部 slug（`gpt-5-6-thinking`, `gpt-5-5-thinking`, `gpt-6-pro` 等）。期待と食い違えば `warnings` に `model_slug_mismatch` |
| `extractionMethod` | `copy`（「回答をコピーする」経由の Markdown）/ `dom`（HTML→Markdown 変換）/ `innerText` |
| `extractionQuality` | `full` / `partial`（本文検証で差があった） |
| `artifacts` | screenshot / trace の相対パス（失敗時に自動保存） |
| `warnings` | 処理は続行したが記録すべき事象（`restore_effort_failed`: 思考量を元に戻せなかった → 画面で手動で戻す） |
| `error` | `{ code, message, cause }` または `null` |

### 4d. 終了コード

| exit | 意味 | 代表的な `error.code` |
|---|---|---|
| 0 | 成功。`response.md` あり | — |
| 1 | ブラウザ起動後の失敗、または送信状態不明 | `RESPONSE_TIMEOUT`, `EXTRACTION_FAILED`, `DOM_CHANGED`, `MODEL_NOT_VERIFIABLE`, `SUBMIT_STATE_UNKNOWN`, `INTERNAL_ERROR` 等 |
| 2 | 入力または設定が不正 | `INVALID_REQUEST`, `INVALID_CONFIG` |
| 3 | **人間の介入が必要**（自動リトライ禁止） | `AUTH_REQUIRED`, `CAPTCHA_OR_CHALLENGE`, `RATE_LIMITED`, `MANUAL_INTERVENTION_REQUIRED` |
| 4 | ブラウザ起動前に停止 | `ALREADY_PROCESSED`（result.json 既存）, `ALREADY_RUNNING`（result.json なし）, `PROFILE_IN_USE`, `BROWSER_LAUNCH_FAILED` |

呼び出し側の判断ルール:
- exit 0 → `response.md` を読む
- exit 3 → 人間に通知して止める。自動再試行しない
- exit 4 `ALREADY_RUNNING` / `PROFILE_IN_USE` → 前の実行の終了を待ってから同じ request を再実行してよい（送信前なので安全）
- exit 1 で `submitted: "unknown"` → 同じ requestId を再実行しない。`conversationUrl` または ChatGPT の履歴を人間が確認する
- exit 1 で `submitted: "no"` → 原因を直してから同じ requestId で再実行してよい（`result.json` を削除する必要がある）

### 4e. リポジトリの一部を渡す（`bundle`）

```powershell
chatgpt-bridge bundle --root S:\Projects\PixivVault --include "src/**/*.ts" --exclude "**/*.test.ts" --max-bytes 200000 --out .\runtime\requests\<requestId>\context.md
chatgpt-bridge bundle --root . --include "src/**/*.ts" --diff HEAD~1 --out context.md
```

ファイルツリー + 各ファイルの fence 付き本文 [+ `git diff <ref>`] を 1 つの Markdown にする。ブラウザは使わない。`.git` / `node_modules` / `dist` / 画像 / ロックファイル等は既定で除外。**秘密パターン（Bearer / Cookie / sk- / JWT 等）に当たるファイルが 1 つでもあれば生成を拒否**する（ファイル名のみ表示。`--exclude` で外す）。`--max-bytes` を超えた分は省略され、省略一覧が先頭に載る。出来た `context.md` は `attachments` に入れて渡す（本文に貼るのは 20,000 文字まで）。

## 5. 共通オプション / 環境変数

| CLI オプション | 環境変数 | 既定 | 意味 |
|---|---|---|---|
| `--profile-dir <path>` | `CHATGPT_BRIDGE_PROFILE_DIR` | `<repo>\runtime\profile` | 専用プロファイルの場所。ジャンクション / シンボリックリンクは拒否 |
| `--log-level <level>` | `CHATGPT_BRIDGE_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| — | `CHATGPT_BRIDGE_CHANNEL` | `chrome` | `chromium` にすると Playwright 同梱 Chromium を使う（テスト用） |
| — | `CHATGPT_BRIDGE_TRACE_ON_SUCCESS` | `0` | `1` で成功時も trace を保存 |
| `--allow-unverified` | — | off | 実画面未確認の selector 候補も使う。**診断専用。通常の `run` では付けない** |
| `--help` | — | — | 使い方を表示 |

## 6. 開発者向け

```powershell
npm run typecheck     # tsc --noEmit
npm run lint          # biome check
npm run format        # biome format --write
npm test              # unit テスト（ブラウザ不要）
npm run test:fixture  # 保存済み DOM に対するテスト（Playwright Chromium が必要）
$env:BRIDGE_LIVE="1"; npm run test:live   # 実 ChatGPT に対する live テスト（ログイン済みが前提）
npm run build         # dist/ を生成
```

## 7. 主な状態ファイル

| パス | 役割 | 手で消してよいか |
|---|---|---|
| `runtime/locks/bridge.lock` | プロセスロック | ブリッジが動いていないことを確認した上で可（`doctor` の `lock` 項目参照） |
| `runtime/state/<requestId>/submit.marker` | 送信直前の write-ahead マーカー。残っていれば「送信したか不明」 | ChatGPT 側で会話を確認してから可 |
| `runtime/artifacts/<requestId>/` | 失敗時の screenshot / trace（サニタイズ済み） | 可 |
| `runtime/profile/` | ログイン情報を含む専用プロファイル | **共有・コピー禁止**。消すと再ログインが必要 |

## 7b. 実測値（2026-09-15）

| 項目 | 実測 |
|---|---|
| 1 往復（短い質問、Thinking 高） | 28〜31 s |
| 1 往復（Pro） | 54 s |
| 1 往復（添付 2 件 + 引用） | 32 s |
| 添付 57 k 文字（1,000 行）の参照 | 66 s、全行正確 |
| 3 MB のアップロード | 10 s 超 |
| 111 行のコードレビュー（バグ 3 件仕込み） | 3/3 発見、誤検出 0、51 s |
| 本文入力の上限 | 20,000 文字（ブリッジ側の制限。10〜20 k で 10〜15 s） |

## 8. できないこと（意図的）

- OpenAI API の利用、内部 API の再現、Cookie / Token の取り出し
- 普段使いの Chrome プロファイルの操作
- ヘッドレス実行（既定は可視ブラウザ）
- CAPTCHA / 再ログイン / 利用上限の自動突破（すべて exit 3 で停止）
- 送信状態が不明なリクエストの自動再送
- 複数リクエストの並行処理
- 既存チャットへの追記、画像の受け取り（Phase 6 の検討事項）
- 本文 20,000 文字超の直接入力（添付を使う）

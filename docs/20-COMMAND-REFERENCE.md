# ChatGPT Web Bridge — コマンドリファレンス（貼り付け用）

対象バージョン: 0.1.0（Phase 4 完了時点、2026-09-15）。このファイルは単体で他の文書やチャットに貼り付けられるよう、前提を含めて自己完結させている。

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
node dist/cli/main.js doctor
```

## 2. ログイン（初回のみ / セッション切れ時）

### 2a. Google アカウントの場合（推奨）

Google は自動操作中のブラウザでのログインを拒否する。ブリッジはこれを回避しないので、**自動操作なしの通常 Chrome を専用プロファイルで起動**してログインする。

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="S:\Projects\chatgpt-web-bridge\runtime\profile" https://chatgpt.com/
```

1. 開いたウィンドウで chatgpt.com にログインする
2. ページが読み込み終わってから **ウィンドウを閉じる**（開いたままだと `PROFILE_IN_USE`。閉じるのが早いとセッションが保存されない）
3. `node dist/cli/main.js doctor` で `login: logged in` を確認

### 2b. メールアドレス + 確認コードの場合

```powershell
node dist/cli/main.js login
```

ブリッジが専用ブラウザを開くので、その中でログインする。ログイン導線が消えると自動終了する（Enter で強制終了）。

## 3. 診断

```powershell
node dist/cli/main.js doctor
```

出力項目: node / playwright / browser / profile.path / profile.exists / profile.free / profile.processes / lock / runtime dirs / login。すべて OK で exit 0、1 つでも NG で exit 1。

```powershell
node dist/cli/main.js inspect-ui
node dist/cli/main.js inspect-ui --dump-dom
```

UI 要素の検出状況・思考量スライダー・モデル選択肢を JSON で `runtime/artifacts/inspect-ui/<timestamp>/` に出力する。**送信はしない**。`--dump-dom` は生 DOM を保存する（個人情報を含むので共有しない）。

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
  "schemaVersion": "1.0",
  "requestId": "20260915T061014Z-6e8c7591",
  "promptFile": "prompt.md",
  "preset": "current",
  "newChat": true,
  "timeoutMs": 300000,
  "responseFormat": "markdown"
}
```

| 項目 | 値 | 備考 |
|---|---|---|
| `schemaVersion` | `"1.0"` 固定 | |
| `requestId` | `^[A-Za-z0-9][A-Za-z0-9._-]{6,62}[A-Za-z0-9]$` | 推奨 `<yyyyMMddTHHmmssZ>-<8 hex>`。ディレクトリ名になる。Windows 予約名（CON, NUL 等）不可 |
| `promptFile` | 相対 or 絶対パス | 相対は `request.json` の場所基準。UTF-8（BOM 可） |
| `preset` | `current` / `instant` / `medium` / `high` / `extra_high` / `pro` | **Phase 4 時点では `current` のみ動作**。他は `MODEL_NOT_VERIFIABLE` で送信せず停止 |
| `newChat` | `true` 固定 | 既存チャットへの追記は未対応 |
| `timeoutMs` | 10000〜3600000 | 省略時 900000（15 分） |
| `responseFormat` | `"markdown"` 固定 | |

### 4b. 実行する

```powershell
node dist/cli/main.js run --request .\runtime\requests\<requestId>\request.json
```

標準出力の最後に `status=<status> submitted=<yes|no|unknown> [code=<ERROR_CODE>]` と `result:` の絶対パスが出る。

### 4c. 出力

```
<repo>\runtime\requests\<requestId>\
  response.md      … 回答本文（Markdown）。失敗時は作られない
  result.json      … 実行結果。ALREADY_RUNNING 以外では必ず作られる
```

`result.json` 例（成功）:

```json
{
  "schemaVersion": "1.0",
  "bridgeVersion": "0.1.0",
  "requestId": "20260915T061014Z-6e8c7591",
  "status": "completed",
  "requestedPreset": "current",
  "observedPreset": "extra_high",
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
| `extractionMethod` | `copy`（「回答をコピーする」経由の Markdown）/ `dom`（HTML→Markdown 変換）/ `innerText` |
| `extractionQuality` | `full` / `partial`（本文検証で差があった） |
| `artifacts` | screenshot / trace の相対パス（失敗時に自動保存） |
| `warnings` | 処理は続行したが記録すべき事象 |
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

## 8. できないこと（意図的）

- OpenAI API の利用、内部 API の再現、Cookie / Token の取り出し
- 普段使いの Chrome プロファイルの操作
- ヘッドレス実行（既定は可視ブラウザ）
- CAPTCHA / 再ログイン / 利用上限の自動突破（すべて exit 3 で停止）
- 送信状態が不明なリクエストの自動再送
- 複数リクエストの並行処理
- 既存チャットへの追記、画像やファイルの添付、画像の受け取り（Phase 5 以降の検討事項）

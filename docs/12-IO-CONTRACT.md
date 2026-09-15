# 12 — I/O Contract

| 項目 | 値 |
|---|---|
| 文書版 | 1.3 (Phase 3、Codex レビュー反映。FROZEN FOR MVP v1.0、2026-09-15) |
| 作成日 | 2026-09-14 |
| 機械可読版 | `schemas/request.schema.json`, `schemas/result.schema.json`（JSON Schema draft 2020-12。**こちらが正**） |
| 上位文書 | `02-REQUIREMENTS.md` FR-007〜014, FR-032 |

## 1. ディレクトリ規約

呼び出し元は 1 リクエストにつき **新規の空ディレクトリ**を用意する（場所は任意、推奨 `runtime/requests/<requestId>/`）。`result.json` が無いのに `response.md` が残っているディレクトリは `INVALID_REQUEST(cause: stale_response)` で拒否され、ブリッジはそれを削除しない。

```text
<requestDir>/
├─ request.json      呼び出し元が書く（必須）
├─ prompt.md         呼び出し元が書く（必須。request.json の promptFile が指す）
├─ response.md       ブリッジが書く（completed のときのみ）
└─ result.json       ブリッジが書く（終端時。FR-010 の例外を除く）

runtime/state/<requestId>/
└─ submit.marker     ブリッジが書く（送信直前。requestDir に依存しない。呼び出し元は読まなくてよい）
```

`result.json` と `response.md` の出力先は **`request.json` と同じディレクトリ**。`--output-dir` のようなオプションは MVP では設けない（OPS-010）。

## 2. `request.json`

```json
{
  "schemaVersion": "1.0",
  "requestId": "20260914T113000Z-a1b2c3d4",
  "promptFile": "prompt.md",
  "preset": "current",
  "newChat": true,
  "timeoutMs": 900000,
  "responseFormat": "markdown"
}
```

| フィールド | 型 | 制約 | 説明 |
|---|---|---|---|
| `schemaVersion` | string | const `"1.0"` | 契約版。不一致は `INVALID_REQUEST` |
| `requestId` | string | `^[A-Za-z0-9][A-Za-z0-9._-]{6,62}[A-Za-z0-9]$`（末尾は英数字） | 呼び出し元が生成する一意 ID。ディレクトリ名に使うため、Windows 予約名（`CON`, `PRN`, `AUX`, `NUL`, `COM1`〜`9`, `LPT1`〜`9` とそれに `.` が続く形、大小文字無視）は `INVALID_REQUEST`。**推奨形式**: `<UTC 時刻 yyyyMMddTHHmmssZ>-<8 桁 hex>`（時系列ソート可、依存ライブラリ不要）。UUID v4/v7 も可（OQ-006） |
| `promptFile` | string | 1 文字以上 | プロンプトファイル。相対パスは `request.json` のディレクトリ基準。絶対パス可（`C:\...` / `/` 混在可） |
| `preset` | string | enum `current, instant, medium, high, extra_high, pro` | UI 上のモデル / 思考 effort。`current` は UI の現在選択を観測して使う |
| `newChat` | boolean | const `true` | MVP では `true` のみ。`false` は `INVALID_REQUEST` |
| `timeoutMs` | integer | 10000 〜 3600000、**任意** | 送信から完了までの上限。省略時 900000（A-030。FR-007 / NFR-003 と整合） |
| `responseFormat` | string | const `"markdown"` | 将来拡張用。MVP は markdown のみ |

`additionalProperties: false`。未知フィールドは `INVALID_REQUEST`（呼び出し元の typo を早期に検出するため）。

**request.json / prompt.md** はいずれも UTF-8 で、先頭 BOM は除去して扱う（PowerShell 5.1 の `-Encoding utf8` は BOM を付けるため）。**prompt.md**: 空・空白のみは `INVALID_REQUEST`。サイズ上限は設けないが、ChatGPT 側の入力上限超過は `PROMPT_INPUT_FAILED`（入力欄内容の不一致として検出）になる。

## 3. `result.json`

### 3.1 成功例

```json
{
  "schemaVersion": "1.0",
  "bridgeVersion": "0.1.0",
  "requestId": "20260914T113000Z-a1b2c3d4",
  "status": "completed",
  "requestedPreset": "current",
  "observedPreset": "pro",
  "submitted": "yes",
  "conversationUrl": "https://chatgpt.com/c/....",
  "responseFile": "S:\\Projects\\chatgpt-web-bridge\\runtime\\requests\\20260914T113000Z-a1b2c3d4\\response.md",
  "extractionMethod": "copy",
  "extractionQuality": "full",
  "startedAt": "2026-09-14T11:30:00.000+09:00",
  "completedAt": "2026-09-14T11:33:12.412+09:00",
  "durationMs": 192412,
  "artifacts": [],
  "warnings": [],
  "error": null
}
```

### 3.2 手動介入例

```json
{
  "schemaVersion": "1.0",
  "bridgeVersion": "0.1.0",
  "requestId": "20260914T113000Z-a1b2c3d4",
  "status": "manual_intervention_required",
  "requestedPreset": "pro",
  "observedPreset": null,
  "submitted": "no",
  "conversationUrl": null,
  "responseFile": null,
  "extractionMethod": null,
  "extractionQuality": null,
  "startedAt": "2026-09-14T11:30:00.000+09:00",
  "completedAt": "2026-09-14T11:30:14.008+09:00",
  "durationMs": 14008,
  "artifacts": [
    "S:\\Projects\\chatgpt-web-bridge\\runtime\\artifacts\\20260914T113000Z-a1b2c3d4\\screenshot.png",
    "S:\\Projects\\chatgpt-web-bridge\\runtime\\artifacts\\20260914T113000Z-a1b2c3d4\\trace.zip"
  ],
  "warnings": ["trace_failed: tracing.stop timed out"],
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "ChatGPT へのログインが必要です。`chatgpt-bridge login` を実行してください。",
    "retryable": false,
    "phase": "BROWSER_STARTED",
    "cause": null
  }
}
```

### 3.3 フィールド定義

| フィールド | 型 | 説明 |
|---|---|---|
| `schemaVersion` | `"1.0"` | |
| `bridgeVersion` | string | `package.json` の version |
| `requestId` | string \| null | `request.json` から。欠落・パターン不一致の場合 null（AC-006） |
| `status` | `completed` \| `failed` \| `manual_intervention_required` | |
| `requestedPreset` | preset enum \| null | 検証前に失敗した場合 null |
| `observedPreset` | `instant` \| `medium` \| `high` \| `extra_high` \| `pro` \| null | UI から観測した値。**`current` は含まない**（要求指定であり観測値ではない）。`completed` では必ず非 null（FR-020） |
| `submitted` | `"yes"` \| `"no"` \| `"unknown"` | 送信操作が dispatch されたか。`"unknown"` は `PROMPT_SUBMITTING` 状態での終端（`PROMPT_SUBMIT_FAILED` / `BROWSER_CRASHED` / `INTERNAL_ERROR`）と `SUBMIT_STATE_UNKNOWN`。**呼び出し元は `"no"` 以外を「送信された可能性あり」と扱い、同じ内容を再送する場合は必ず新しい requestId を使う** |
| `conversationUrl` | string \| null | 送信後に観測した `https://chatgpt.com/c/...`。人間が手動で確認する際の手がかり |
| `responseFile` | string \| null | 絶対パス。`completed` のみ非 null |
| `extractionMethod` | `copy` \| `dom` \| `innerText` \| null | `completed` のみ非 null |
| `extractionQuality` | `full` \| `degraded` \| null | `innerText` のとき `degraded`。`completed` のみ非 null |
| `startedAt` / `completedAt` | date-time（RFC 3339、オフセット付き） | |
| `durationMs` | integer ≥ 0 | `completedAt - startedAt` |
| `artifacts` | string[] | 絶対パス。ブラウザ起動前の失敗では `[]` |
| `warnings` | string[] | best-effort 処理（screenshot / trace / inspect-ui / marker 追記・削除 / ブラウザ終了）の失敗記録。`"<kind>_failed: <redacted cause>"` 形式。通常は `[]` |
| `error` | object \| null | `completed` のとき null、それ以外は必須 |
| `error.code` | string | `13-ERROR-MODEL.md` の enum |
| `error.message` | string | 人間向け（日本語）。秘密情報・プロンプト本文を含まない |
| `error.retryable` | boolean | MVP では常に `false` |
| `error.phase` | enum | 失敗時の状態名（`11-STATE-MACHINE.md` §2。schema の `$defs.stateName`） |
| `error.cause` | string \| null | 種別タグ（`banner` / `output_truncated` 等）または例外メッセージの先頭 200 文字（redaction 済み、URL を含めない） |

`additionalProperties: false`。

### 3.4 不変条件（AC-007 でテスト）

schema（`allOf`）で機械検証するもの:

- `status == "completed"` ⇔ `error == null` ⇔ `responseFile != null` ⇔ `extractionMethod != null` ⇔ `extractionQuality != null`
- `status == "completed"` ⇒ `observedPreset != null` かつ `submitted == "yes"`
- `status == "manual_intervention_required"` ⇔ `error.code ∈ { AUTH_REQUIRED, CAPTCHA_OR_CHALLENGE, MANUAL_INTERVENTION_REQUIRED, RATE_LIMITED }`
- `status == "failed"` ⇒ `error.code ∉` 上記 4 つ `∪ { ALREADY_PROCESSED, ALREADY_RUNNING }`（後者 2 つは `result.json` を書かないため現れない）
- `observedPreset != "current"`（enum から除外）
- `error.phase` は `11-STATE-MACHINE.md` §2 の状態名 enum

schema では表しにくいため `src/contracts/invariants.ts` で検証するもの（`11-STATE-MACHINE.md` §6.3）:

- `error.phase == PROMPT_SUBMITTING` ⇒ `submitted == "unknown"`（例外: `MODEL_NOT_VERIFIABLE` with `cause: preset_changed` は click 前中止なので `"no"`）；`WAITING_FOR_RESPONSE` 以降 ⇒ `"yes"`；それ以前 ⇒ `"no"`（`SUBMIT_STATE_UNKNOWN` は `"unknown"`）
- `submitted == "unknown"` ⇒ `error.code ∈ { PROMPT_SUBMIT_FAILED, SUBMIT_STATE_UNKNOWN, BROWSER_CRASHED, INTERNAL_ERROR }`
- `artifacts` の各パスは存在するファイル（Live で確認）

## 4. アトミック書き出し（FR-013）

```text
1. <target>.tmp-<pid>-<random> に書く（UTF-8、BOM 無し。response.md は末尾の空白・改行を除去して LF を 1 つ付与）
2. fs.fsync(fd)
3. fs.rename(tmp, target)   … 同一ディレクトリなので同一ボリューム
4. 失敗時: tmp を削除し WRITE_FAILED
```

`submit.marker` も同じ手順で書く（§5）。`response.md` → `result.json` の順。`result.json` の存在が「終端した」の合図なので、呼び出し元は `result.json` の出現を待ってから `status` を見て `responseFile` を読む。

Windows での注意: 対象ファイルを別プロセスが開いていると `rename` が `EPERM` になる。1 回だけ 200 ms 後に再試行し、それでも失敗なら `WRITE_FAILED`。

## 5. `submit.marker`（内部）

場所: `runtime/state/<requestId>/submit.marker`（requestDir ではなく requestId でグローバル）。

```json
{ "requestId": "...", "writtenAt": "2026-09-14T11:30:05.100+09:00", "urlBefore": "https://chatgpt.com/", "baselineAssistantCount": 0, "presetLabelBefore": "...",
  "dispatchedAt": "2026-09-14T11:30:05.400+09:00", "urlAfter": "https://chatgpt.com/c/..." }
```

- 送信操作の直前に `dispatchedAt` / `urlAfter` 無しで書く（write-ahead、tmp → fsync → rename。rename 完了後にのみ `MARKER_WRITTEN`）。書けなければ送信しない（`WRITE_FAILED`、`submitted: "no"`）。
- 送信操作の直後に `dispatchedAt` / `urlAfter` を追記して書き直す（FR-025 の「直後の状態」）。追記は best-effort で、失敗しても送信状態には影響しない（write-ahead 部分が残っていれば冪等判定は成立する）。
- 正常終了時も削除しない。冪等判定はロック保持下で行い、`requestDir/result.json` が無く marker があるときのみ `SUBMIT_STATE_UNKNOWN`。0 バイト・JSON 不正でも「存在」として扱う。

## 6. 終了コード（FR-006。`13-ERROR-MODEL.md` §3 と同一）

| コード | 意味 | 呼び出し元の解釈 |
|---|---|---|
| 0 | completed | `responseFile` を読む |
| 1 | ブラウザ起動後の失敗、または送信状態不明 | `result.json` を読む。**`submitted` を必ず確認**してから対処 |
| 2 | 不正な入力・設定 | `request.json` / `prompt.md` / プロファイル設定を直す。送信されていない |
| 3 | 手動介入必要 | 人間に `error.message` を提示。終了コード 3 の 4 コードはいずれも送信後にも起こり得るため **`submitted` を必ず確認** |
| 4 | 起動前停止 | 何も送信されていない。`result.json` があれば読む（`PROFILE_IN_USE`, `BROWSER_LAUNCH_FAILED`）、無ければ stderr（`ALREADY_RUNNING` は待って再実行可、`ALREADY_PROCESSED` は既存 `result.json` を読む） |

## 7. 呼び出し元（Claude Code）向け最小手順

```text
1. requestId を生成し、<requestDir>/prompt.md と request.json を書く
2. chatgpt-bridge run --request <requestDir>/request.json を実行し、終了コードを得る
3. <requestDir>/result.json を読む（無ければ終了コードと stderr で判断）
4. status == completed なら responseFile を読む
5. それ以外は error.message と submitted に従う。再送するなら新しい requestId で
```

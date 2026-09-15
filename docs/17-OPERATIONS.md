# 17 — Operations

| 項目 | 値 |
|---|---|
| 文書版 | 1.3 (Phase 3、Codex レビュー反映。FROZEN FOR MVP v1.0、2026-09-15) |
| 作成日 | 2026-09-14 |
| 用途 | Phase 4 以降の README / 運用手順の骨子。Phase 7 で README に統合 |

## 1. セットアップ（新規 Windows 環境）

```powershell
# 前提: Node.js LTS (>= 20)、Google Chrome、Git
git clone <repo> chatgpt-web-bridge
cd chatgpt-web-bridge
npm ci
npx playwright install chromium   # Fixture テスト用（製品の既定は Google Chrome）
npm run build
npm test
npx chatgpt-bridge doctor
```

`doctor` が NG を出した項目を解消してから次へ進む。製品でも同梱 Chromium を使う場合は `CHATGPT_BRIDGE_CHANNEL=chromium`。

## 2. 初回ログイン

**Google アカウントでログインする場合（推奨手順）**: Google はブラウザ自動操作中のログインを「このブラウザまたはアプリは安全でない可能性があります」として拒否する。ブリッジはこれを回避しないので、ログインだけは **自動操作なしの通常 Chrome** を専用プロファイルで起動して行う（A-055）:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="<repo>\runtime\profile" https://chatgpt.com/
```

1. 開いたウィンドウで chatgpt.com にログインする（普段の Chrome とは別プロファイル。ブリッジは何も入力しない）
2. ログイン後、**ウィンドウを閉じる**（開いたままだと `PROFILE_IN_USE`）。閉じる前にページが読み込み終わっていること（閉じるのが早いとセッションが保存されない）
3. `npx chatgpt-bridge doctor` で `login: logged in` を確認

**メールアドレス + 確認コードでログインする場合**: `npx chatgpt-bridge login` で開くブラウザ内で完了できる（Google の制限は対象外）。ログイン導線が消えるとブリッジが自動終了する。

通常使いの Chrome にはログイン情報が共有されない（別プロファイル）。

## 3. リクエストの実行

```powershell
$id = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ") + "-" + (-join ((48..57)+(97..102) | Get-Random -Count 8 | % {[char]$_}))
$dir = (Resolve-Path .).Path + "\runtime\requests\$id"
New-Item -ItemType Directory $dir | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)   # PowerShell 5.1 の -Encoding utf8 は BOM 付きになるため
[IO.File]::WriteAllText("$dir\prompt.md", "…プロンプト…", $utf8)
[IO.File]::WriteAllText("$dir\request.json", '{ "schemaVersion": "1.0", "requestId": "' + $id + '", "promptFile": "prompt.md", "preset": "current", "newChat": true, "timeoutMs": 900000, "responseFormat": "markdown" }', $utf8)

npx chatgpt-bridge run --request "$dir\request.json"
echo "exit=$LASTEXITCODE"
Get-Content -Encoding UTF8 "$dir\result.json"
```

ブリッジは BOM 付きの request.json / prompt.md も受け付ける（BOM を除去して読む）が、`Get-Content` で BOM 無し UTF-8 を読む際は `-Encoding UTF8` を付ける。

Phase 6 でこの手順を `scripts/ask-chatgpt.ps1` にまとめる。

## 4. コマンド一覧

| コマンド | 目的 | 終了コード |
|---|---|---|
| `login` | 専用ブラウザを開き人間がログイン（Google の場合は通常 Chrome での手順を案内） | 0 / 1 / 4（`ALREADY_RUNNING`） |
| `doctor` | 環境診断（Node、Playwright、Chrome、プロファイルパス、ブリッジロックと stale 判定、プロファイル占有、ログイン、書き込み権限） | 0 = 全 OK / 1 = NG あり |
| `run --request <path>` | 1 リクエスト処理 | 0〜4（13-ERROR-MODEL §3） |
| `inspect-ui [--dump-dom]` | UI 要素の検出状況・思考量スライダー・モデル選択肢を JSON で出力（送信しない）。`--dump-dom` は生 DOM を `runtime/artifacts/inspect-ui/` に保存（共有禁止） | 0 / 1 / 4（`ALREADY_RUNNING`） |

共通オプション（続き）: `--allow-unverified` は実画面未確認の selector 候補も使う診断用フラグ。通常の `run` では付けない。

共通オプション: `--profile-dir <path>`（環境変数 `CHATGPT_BRIDGE_PROFILE_DIR` より優先）、`--log-level debug`（10-ARCHITECTURE §9）。

## 5. 実行中に人間がすべきこと

**何もしない。** ブラウザウィンドウは見えるが、キーボード・マウスで触らない（入力欄の内容が変わると `PROMPT_INPUT_FAILED`、他タブを開くと観測が乱れる）。ブラウザを閉じると `BROWSER_CRASHED` になる。

## 6. トラブルシューティング

| 症状 / code | 原因 | 対処 |
|---|---|---|
| `INVALID_CONFIG` | プロファイルパスが通常の User Data を指す、または symlink / junction を含む | `CHATGPT_BRIDGE_PROFILE_DIR` / `--profile-dir` を reparse point を含まない専用ディレクトリに |
| `INVALID_REQUEST`（`cause: stale_response`） | `result.json` が無いのに `response.md` が残っている | 古い `response.md` を人間が確認・退避してから新しい requestId で再実行。requestDir は新規・空にする |
| `AUTH_REQUIRED` | セッション失効 | `login` を実行。`submitted` が `yes` なら `conversationUrl` も確認 |
| `CAPTCHA_OR_CHALLENGE` | Cloudflare / CAPTCHA | `login` で開いたブラウザでチャレンジを完了。頻発する場合は利用頻度を下げる（R-001） |
| `MANUAL_INTERVENTION_REQUIRED` | 同意画面等 | `login` で開いて対応 |
| `RATE_LIMITED` | 利用上限 | 時間を置く。ブリッジは自動待機しない |
| `MODEL_NOT_AVAILABLE` / `MODEL_NOT_VERIFIABLE` | preset が UI に無い、または表示を読めない | `inspect-ui` で選択肢を確認。UI 変更なら §7 |
| `DOM_CHANGED` | ChatGPT UI 変更 | §7 |
| `PROFILE_IN_USE` | 専用プロファイルを Chrome が開いている | そのウィンドウを閉じる（`login` の残り、前回のブリッジが kill した後の残骸など。`doctor` が該当プロセスを表示） |
| `BROWSER_LAUNCH_FAILED` | Chrome / Chromium の起動失敗 | `doctor` でブラウザ実行ファイルと版を確認。`CHATGPT_BRIDGE_CHANNEL=chromium` で切り分け |
| `ALREADY_RUNNING` | 別のブリッジが実行中、または stale lock | 実行中なら待つ。`doctor` が stale と判定したら `runtime/locks/bridge.lock` を削除 |
| `ALREADY_PROCESSED` | 同じ requestId を再実行 | 既存 `result.json` を読む。再送は新しい requestId で |
| `SUBMIT_STATE_UNKNOWN` | 前回、送信直前〜終端前に異常終了 | chatgpt.com の会話一覧を見て、送信済みなら回答を手動で取得。新しい requestId で再送 |
| `GENERATION_TIMEOUT` | 生成が `timeoutMs` 内に終わらない | `conversationUrl` を開いて確認。`timeoutMs` を伸ばして **新しい requestId** で再送。タイムアウト延長だけで問題を隠さない |
| `EXTRACTION_FAILED` | 回答本文が空（`cause: empty`）、または Canvas 等のパネルに生成された（`cause: canvas`） | `conversationUrl` から手動取得 |
| `CHAT_ERROR` | `cause: banner` / `network` / `output_truncated`（出力上限で打ち切り。ブリッジは「続きを生成」を押さない）/ `multiple_responses`（A/B 比較） | `conversationUrl` を開いて確認。必要なら人間が続きを生成 |
| `WRITE_FAILED` | ディスク / 権限 / ファイルロック | `requestDir` を他のアプリで開いていないか確認 |
| `BROWSER_CRASHED` | Chrome 終了 | `submitted` を確認。`yes` なら `conversationUrl` を確認 |
| 終了コード非ゼロで `result.json` 無し | 強制終了、Node 例外 | stderr を確認。次回 `run` で `SUBMIT_STATE_UNKNOWN` になれば送信済みの可能性 |

## 7. ChatGPT UI 変更時の手順

`14-SELECTOR-STRATEGY.md` §7 を参照。要約:

1. `artifacts/<id>/inspect-ui.json` と `screenshot.png` を見る
2. `npx chatgpt-bridge inspect-ui` を実行
3. `login` で開いたブラウザの DevTools で新しい構造を確認（人間）
4. `src/chatgpt/selectors.ts` の候補を更新し `verifiedOn` を記録
5. fixture を更新して `npm test`
6. LS-01 を実行

## 8. データの場所と削除

| パス | 内容 | 削除してよいか |
|---|---|---|
| `runtime/profile/` | ブラウザプロファイル（Cookie 含む） | 可（再ログインが必要） |
| `runtime/locks/` | ロック | 実行中でなければ可 |
| `runtime/requests/<id>/` | prompt / response / result | 可 |
| `runtime/state/<id>/` | submit.marker（送信監査台帳） | **不可**。削除すると同じ requestId を別ディレクトリで再実行した場合に再送を拒否できない。`doctor` が欠落を警告する |
| `runtime/artifacts/<id>/` | screenshot / trace / inspect-ui | 可。**第三者に共有しない** |

自動削除は行わない（SEC-007）。

## 9. Codex レビューの実行（Phase 3 / 4 / 5 / 7）

```powershell
codex --version
codex exec --help | Select-String -Pattern 'ephemeral|--cd|-C|sandbox|output-last-message'
Get-Content .\reviews\<request>.md -Raw |
  codex exec --ephemeral -C . -s read-only -m <model> -c model_reasoning_effort=high -o .\reviews\<output>.md -
git status --short   # Codex がファイルを変更していないことを確認
```

失敗した場合はコマンド・終了コード・stderr を `reviews/<output>.failed.md` に保存し、自己レビューで代替、報告に「外部レビュー未実施」と記す（OPS-005）。

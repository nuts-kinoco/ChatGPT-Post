# 17 — Operations（運用手順）

| 項目 | 値 |
|---|---|
| 文書版 | 2.0（Phase 7 全面改訂、2026-09-15。契約 1.2） |
| 作成日 | 2026-09-14 |
| 用途 | 日常運用の唯一の手順書。コマンド詳細は `20-COMMAND-REFERENCE.md`、他 PJ からの利用は `skills/chatgpt-bridge/SKILL.md` |

## 1. セットアップ（新規 Windows 環境）

```powershell
# 前提: Node.js 24、Google Chrome（stable）、Git
git clone <repo> chatgpt-web-bridge
cd chatgpt-web-bridge
npm ci
npm run build
npm test            # unit 129 + fixture 3（fixture は Chrome の headless で DOM スナップショットを検証。ChatGPT には接続しない）
npm link            # chatgpt-bridge をグローバルコマンドに
chatgpt-bridge doctor
```

`doctor` の項目: node / playwright / browser / profile.path / profile.exists / profile.free / profile.processes / lock / runtime dirs / login。NG を解消してから次へ。同梱 Chromium を使う場合は `npx playwright install chromium` + `CHATGPT_BRIDGE_CHANNEL=chromium`（切り分け用。製品の既定は Chrome）。

## 2. 初回ログイン（セッション切れ時も同じ）

**Google アカウント（推奨手順）**: Google は自動操作中のブラウザでのログインを拒否する。ブリッジは回避しないので、ログインだけは自動操作なしの通常 Chrome を専用プロファイルで起動して行う（A-055）。

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="<repo>\runtime\profile" https://chatgpt.com/
```

1. 開いたウィンドウで chatgpt.com にログインする（普段の Chrome とは別プロファイル）
2. ページが読み込み終わってから**ウィンドウを閉じる**（開いたままだと `PROFILE_IN_USE`。早すぎるとセッションが保存されない）
3. `chatgpt-bridge doctor` で `login: logged in`

**メール + 確認コード**: `chatgpt-bridge login` で開くブラウザ内で完了できる。

閉じる前に**入力欄を空にしておく**（下書きが残ると次の `run` が `composer_not_empty` で止まる。A-082）。

## 3. 日常の使い方

### 3.1 1 件を送る

```powershell
$id  = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ") + "-" + (-join ((48..57)+(97..102) | Get-Random -Count 8 | % {[char]$_}))
$dir = "<repo>\runtime\requests\$id"
New-Item -ItemType Directory $dir | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText("$dir\prompt.md", (Get-Content <repo>\prompts\code-review.md -Raw) -replace '\{\{requestId\}\}', $id, $utf8)
Copy-Item .\src\thing.ts $dir\
[IO.File]::WriteAllText("$dir\request.json", '{ "schemaVersion": "1.2", "requestId": "' + $id + '", "promptFile": "prompt.md", "attachments": ["thing.ts"], "preset": "high", "newChat": true, "timeoutMs": 900000, "responseFormat": "markdown" }', $utf8)
chatgpt-bridge run --request "$dir\request.json" --json
```

- `preset`: 1 ファイル規模のレビューは `medium` で十分（`extra_high` と同品質、半分の時間）。調査・横断的判断は `high`〜`extra_high`。`pro` は週次上限を消費
- 本文は 20,000 文字まで。長い材料は `attachments`（`bundle` で作った `context.md` も）
- 実行中はブラウザに触らない。ブリッジは思考量の設定を変更し、終了時に元に戻す

### 3.2 複数件をまとめて

```powershell
chatgpt-bridge worker --queue S:\work\bridge-queue --drain
```

`pending/<requestId>/` に置いた順（requestId 順）に 1 件ずつ処理。`done/` `failed/` `blocked/` へ移る。`blocked/`（ログイン・CAPTCHA・上限）が出たらキューは止まる → §6 で対応 → 再度 `--drain`。前回異常終了して `running/` に残った項目は起動時に自動回復する（result.json があればその status へ、無ければ `pending/` へ。再送はブリッジのマーカーが守る）。

### 3.3 画像

- **渡す**: `attachments` に `.png` / `.jpg`
- **受け取る**: 生成を依頼するだけ。`images/1.png` … に保存され `result.json.images` と `response.md` に載る

### 3.4 会話を続ける

`"newChat": false, "conversationUrl": "<前回の result.json の conversationUrl>"`。存在しない・生成中・下書きありなら送信前に停止。

### 3.5 リポジトリを渡す

```powershell
chatgpt-bridge bundle --root S:\Projects\X --include "src/**/*.ts" --exclude "**/*.test.ts" --diff HEAD~3 --out $dir\context.md
```

秘密パターンが 1 つでもあれば拒否される。**内容を消して通さず**、`--exclude` で対象から外す。

### 3.6 使用量の目安

```powershell
chatgpt-bridge usage            # または --json / --queue <dir>
```

ブリッジ経由の送信だけを数えた下限値。手動送信は含まれない。上限値（`runtime/limits.json`）は ChatGPT 自身の回答で公式未確認。`pro_pool` の残りが少ないときは `pro` を使わない。

## 4. 知見の管理（`knowledge/`）

- 残す価値がある回答だけ `knowledge/INDEX.md` に 1 行（日付 / 種別 / タイトル / 要点 / requestId / 状態）。原文は写さない
- 週 1 回: `rejected` と 30 日超の `pending` を INDEX の 1 行に圧縮
- 月 1 回: 同じ tag を `knowledge/SUMMARY.md`（200 行以内）にまとめる
- 四半期: `runtime/requests/` の 90 日超を `runtime/archive/<yyyy-mm>.zip` に移す（`runtime/state/` のマーカーは残す）
- Claude Code / Codex に読ませる順: SUMMARY → INDEX → 必要なノート 1 件。`response.md` 原文は最後

規約の全文は `22-BEST-PRACTICES.md` §5。

## 5. 実行中に人間がすべきこと

**何もしない。** ブラウザウィンドウは見えるが触らない（入力欄を触ると `PROMPT_INPUT_FAILED`、閉じると `BROWSER_CRASHED`）。ビューアや別タブを開かない。

## 6. トラブルシューティング

exit code の意味: 0 成功 / 1 ブラウザ起動後の失敗 / 2 入力・設定 / 3 **人間の介入** / 4 起動前に停止。詳細は `20 §4d`。

| 症状 / code | 原因 | 対処 |
|---|---|---|
| exit 3 `AUTH_REQUIRED` | セッション失効 | §2 でログインし直す。`submitted: yes` なら `conversationUrl` も確認 |
| exit 3 `CAPTCHA_OR_CHALLENGE` | Cloudflare / CAPTCHA | 通常 Chrome を専用プロファイルで開いて完了する。頻発するなら頻度を下げる（R-001） |
| exit 3 `MANUAL_INTERVENTION_REQUIRED` | 同意画面等 | 同上 |
| exit 3 `RATE_LIMITED` | 利用上限 | 待つ。`usage` で目安を見る。ブリッジは自動待機しない |
| `INVALID_CONFIG` | プロファイルパスが通常の User Data、または junction / symlink | `--profile-dir` を reparse point の無い専用ディレクトリに |
| `INVALID_REQUEST`（schema） | フィールドの誤り | stderr の `/field: …` を直す。`newChat: false` には `conversationUrl` が必要 |
| `INVALID_REQUEST`（添付） | 秘密らしい名前 / 内容、symlink、空、同名重複、20 件超、100 MB 超、走査できない大きなテキスト | 対象から外す。ブリッジは内容を表示しない |
| `INVALID_REQUEST`（prompt 20,000 文字超） | 直接入力が遅すぎる | 本文を添付に移す |
| `INVALID_REQUEST`（`stale_response`） | `result.json` 無しで `response.md` が残っている | 退避して新しい requestId で |
| `MODEL_NOT_AVAILABLE` / `MODEL_NOT_VERIFIABLE` | preset / model が UI に無い、読み戻しが要求と不一致、トリガ表示が未知（`unmapped: "…"`） | `inspect-ui --walk-effort` で段階とラベルを確認。UI 変更なら §7 |
| `PROMPT_INPUT_FAILED`（`attachment_failed: …`） | チップ数不一致、アップロードが時間内に終わらない | ネットワークとサイズを確認。送信前なので再実行可 |
| `PROMPT_SUBMIT_FAILED`（`composer_not_empty`） | 下書きが残っている | 専用プロファイルの Chrome で入力欄を空にする |
| `PROMPT_SUBMIT_FAILED`（`conversation_not_found`） | `conversationUrl` の会話が無い / 別 origin へ転送 | URL を確認 |
| `PROMPT_SUBMIT_FAILED`（`generating`） | 会話が生成中 | 終わるまで待つ |
| `DOM_CHANGED` | ChatGPT UI 変更 | §7 |
| `PROFILE_IN_USE` | 専用プロファイルを Chrome が開いている | そのウィンドウを閉じる（`doctor` がプロセスを表示） |
| `BROWSER_LAUNCH_FAILED` | Chrome 起動失敗 | `doctor`。`CHATGPT_BRIDGE_CHANNEL=chromium` で切り分け |
| `ALREADY_RUNNING` | 別のブリッジ実行中、または stale lock | 待つ。`doctor` が stale と言えば `runtime/locks/bridge.lock` を削除 |
| `ALREADY_PROCESSED` | 同じ requestId | 既存 `result.json` を読む。再送は新 requestId |
| `SUBMIT_STATE_UNKNOWN` | 前回、送信直前〜終端前に異常終了（クラッシュ含む） | chatgpt.com の会話一覧で送信済みか確認。送信済みなら回答を手動取得、または `newChat: false` で同じ会話に「先ほどの回答をもう一度」と依頼。再送は新 requestId |
| `GENERATION_TIMEOUT` | `timeoutMs` 内に終わらない（真にスタール） | `conversationUrl` を開いて確認。伸ばすなら新 requestId |
| `GENERATION_TIMEOUT_ACTIVE` | `timeoutMs` 到達時点でまだ生成中（停止ボタン表示中、#124） | すぐ再送しない。screenshot / `doctor` の profile.free・lock を確認するか人間に聞く。専有プロファイルで二重生成を起こし得る |
| `EXTRACTION_FAILED` | 本文が空（画像も無い）/ Canvas（`canvas`） | `conversationUrl` から手動取得 |
| `CHAT_ERROR` | `banner` / `network` / `output_truncated` / `multiple_responses` | `conversationUrl` を開いて確認 |
| `BROWSER_CRASHED` | Chrome 終了。`CHATGPT_BRIDGE_IMAGE_VIA_VIEWER=1` のときは画像ビューア「保存」が原因のことがある | `submitted` を確認。環境変数を外す。`runtime/profile/Crashpad/reports/*.dmp` は削除してよい |
| `WRITE_FAILED` | ディスク / 権限 / ロック | requestDir を他のアプリで開いていないか |
| `warnings: restore_effort_failed` | 思考量を元に戻せなかった | chatgpt.com で思考量を手で戻す |
| `warnings: model_slug_mismatch` | 回答の内部 slug が要求と不一致（上限で自動切替など） | 回答は取得済み。内容を疑う場合は再実行 |
| `warnings: image_capture_failed` | 画像を保存できなかった | `conversationUrl` から手動保存 |
| `worker` が `stoppedBy: error` | 項目の移動に失敗（別プロセスが開いている等） | 該当項目を閉じて再起動。`running/` は起動時に回復 |
| 終了コード非ゼロで `result.json` 無し | 強制終了、Node 例外 | stderr を確認。次回 `SUBMIT_STATE_UNKNOWN` なら送信済みの可能性 |

## 7. ChatGPT UI 変更時の手順（fail closed からの復旧）

`DOM_CHANGED` / `MODEL_NOT_VERIFIABLE` が出たら:

1. `runtime/artifacts/<requestId>/screenshot.png` と `inspect-ui.json` を見る（`candidates[].attached / visible` が 0 の要素が変わった箇所）
2. `chatgpt-bridge inspect-ui --walk-effort` で現在の要素・思考量ラベル・モデル選択肢を取る（送信しない）
3. 必要なら `chatgpt-bridge inspect-ui --dump-dom` で生 DOM（**共有しない**）
4. `src/chatgpt/selectors.ts` の候補・`PRESET_LABELS` / `MODEL_LABELS` / `MODEL_HINTS` / `MODEL_SLUG_PATTERNS` を更新し、`verifiedOn` に日付を書く（`verifiedOn` の無い候補は `run` で使われない）
5. `tests/fixtures/chatgpt-<date>.html` を新しい構造で作り直し（個人情報なし、`backend-api` 等の禁止トークンを含めない）、`npm test`
6. `docs/14-SELECTOR-STRATEGY.md` §3 / §4 を更新
7. LS-01（短い質問）→ 必要なら添付 / 画像 / 追記の各 1 件で確認し、`docs/live-results/` に記録

## 8. データの場所と削除

| パス | 内容 | 削除してよいか |
|---|---|---|
| `runtime/profile/` | ブラウザプロファイル（Cookie 含む） | 可（再ログインが必要）。**共有・コピー禁止** |
| `runtime/profile/Crashpad/reports/` | Chrome のクラッシュダンプ | 可 |
| `runtime/locks/` | ロック | 実行中でなければ可 |
| `runtime/requests/<id>/` | prompt / response / result / images | 可（`usage` の台帳でもあるので 90 日はアーカイブ推奨） |
| `runtime/state/<id>/` | submit.marker（送信監査台帳） | **不可**。同じ requestId の再送を拒否するため |
| `runtime/artifacts/<id>/` | screenshot / trace / inspect-ui | 可。**共有しない** |
| `runtime/limits.json` | usage の上限値 | 編集可。消せば既定値で再生成 |
| `<queue>/` | ワーカーの項目 | `done/` は knowledge 化した後に可 |

自動削除は行わない（SEC-007）。

## 9. Codex レビューの実行

```powershell
codex exec --ephemeral -C . -s read-only -m gpt-5.6-terra -c model_reasoning_effort=<medium|high> -o .\reviews\<output>.md "<依頼文の場所を示す 1 文>" < $null
git status --short   # Codex がファイルを変更していないことを確認
```

`< $null`（bash なら `< /dev/null`）を付けないと stdin 待ちで止まることがある。結果は `reviews/<phase>-…-codex.md` に保存し、裁定を `…-adjudication.md` に残す。

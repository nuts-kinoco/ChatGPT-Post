---
name: chatgpt-bridge
description: ChatGPT Web（Pro）に 1 往復の質問・レビュー・調査・分類を投げて Markdown で受け取る。ローカルの chatgpt-bridge CLI（専用 Chrome プロファイル、API 不使用）を使う。独立した作業（材料をすべて渡せるもの）向け。
---

# chatgpt-bridge スキル

## Recovery first

`collect` proves the immediately preceding user prompt as well as the assistant baseline. It never
clears or edits a saved composer draft; a detected draft is preserved and reported. It rejects a
temporary `WEB:` route and works for direct `run` markers without jobs.db. The explicit recovery
form needs `--prompt-file`; `--since` is recovery metadata, not a DOM-time filter.

For `GENERATION_TIMEOUT`, `GENERATION_TIMEOUT_ACTIVE`, `SUBMIT_STATE_UNKNOWN`, or `CONVERSATION_MISMATCH`, do not resend. Run `chatgpt-bridge collect <requestId> --json`: it opens only the recorded conversation under the normal lock and recovers only one reply proven by the marker baseline. It never sends and preserves the original failed result in favor of a separately marked recovery. `wait` exit 6 / `status: "waiting_timeout"` is retryable, not final; call `wait` again or `collect`.

`SUBMIT_NOT_CONFIRMED` is the sole send failure safe to retry: it has `submitted: "no"` and
`error.retryable: true`, and proves the exact prompt remained in the composer with no matching new
user turn, stop button, or accepted new-chat URL. The bridge cleared that draft and every
registry-verified composer attachment chip, then removed its marker. Do not retry
`SUBMIT_STATE_UNKNOWN`; a cleared, restored, changed, uncleanable, or URL-moved composer is ambiguous
and deliberately stays unsafe.

他プロジェクトの Claude Code / Codex から ChatGPT Web を「外部アドバイザー」として使うための手順。このスキルは **`chatgpt-bridge` が `npm link` 済みで、専用プロファイルにログイン済み**であることを前提にする（`chatgpt-bridge doctor` で確認）。詳細は `S:\Projects\chatgpt-web-bridge\docs\20-COMMAND-REFERENCE.md`。

## 使いどころ

- 独立したコードレビュー（1〜数ファイル）、修正パッチの生成、設計のセカンドオピニオン、web 検索付きの調査、JSON Lines のバッチ分類・タグ付け、画像生成 / 画像の説明
- **向かない**: 対話的な多段作業、リアルタイム応答、リポジトリ全体を前提にした作業（ChatGPT はローカルを見られない。材料は bundle / 添付で渡す）

## 6 手順

1. **残量確認**: `chatgpt-bridge usage --json` → `pro_pool.remaining` が 5 未満なら `preset: pro` を使わない。`lastRateLimited` が直近なら人間に確認
2. **材料を作る**（必要なら）: `chatgpt-bridge bundle --root <repo> --include "src/**/*.ts" --exclude "**/*.test.ts" --max-bytes 200000 --out <dir>/context.md`。拒否されたら（秘密パターン）`--exclude` で外す。**秘密を消して通すことはしない**
3. **request を作る**: `requestId = <UTC yyyyMMddTHHmmssZ>-<8 hex>`。`S:\Projects\chatgpt-web-bridge\runtime\requests\<requestId>\` に `request.json` と `prompt.md`（`prompts/*.md` のテンプレートから。**先頭に requestId、回答にも書かせる**）、添付ファイルを置く
   ```json
   { "schemaVersion": "1.2", "requestId": "<id>", "promptFile": "prompt.md",
     "attachments": ["context.md"], "preset": "high", "model": "current",
     "newChat": true, "timeoutMs": 900000, "responseFormat": "markdown" }
   ```
   - `preset`: レビュー / 調査 `high`（1 ファイル規模なら `medium` で同品質）、定型変換 `instant`、`pro` は最後の手段（週次上限）
   - 本文は 20,000 文字まで。長い材料は `attachments`
   - 追記したいときは `"newChat": false, "conversationUrl": "<前回の result.json の conversationUrl>"`
   - リポジトリ専用の ChatGPT Project にまとめたいときは `newChat: true` のまま `"project": "<Project ホーム URL>"`（サイドバーの鉛筆アイコン「プロジェクトのホームを開く」から取得、`https://chatgpt.com/g/g-p-.../project`）。以後その会話に追記する場合の `conversationUrl` は `https://chatgpt.com/g/g-p-.../c/<id>`（通常の `/c/<id>` とは別形式）になる
4. **実行**: `chatgpt-bridge run --request <path> --json`（30〜120 s）。`chatgpt-bridge daemon start` 済みなら常駐ブラウザ（最小化）を使い回すので毎回の開閉が無く、無い場合は毎回ブラウザを開閉する。いずれも**触らない**
5. **判定**（`exitCode`）:
   - `0` → `response.md` を読む。`images[]` があれば `images/` に生成画像
   - `3` → **人間に知らせて止まる**（ログイン / CAPTCHA / 上限）。自動再試行しない
   - `4`（`ALREADY_RUNNING` / `PROFILE_IN_USE`）→ 別の誰か（人間の手動ログイン含む）が同じプロファイルを使っている可能性が高い。**すぐ再試行しない**。数十秒〜数分待ってから同じ request を再実行する。何度も `4` が続くなら `chatgpt-bridge doctor` の `lock` / `profile.*` を見て、それでも不明なら人間に聞く
   - `1` で `submitted: "unknown"` → 同じ requestId を再実行しない。`conversationUrl` を人間が確認
   - `1`/`2` で `submitted: "no"` → `error.cause` を直して、`result.json` を消してから再実行
6. **知見化**: 残す価値があれば `S:\Projects\chatgpt-web-bridge\knowledge\INDEX.md` に 1 行追加（要約と requestId のみ。原文は写さない）

## 複数件を流す

`<queue>/pending/<requestId>/` に request 一式を置き、`chatgpt-bridge worker --queue <queue> --drain`。結果は `done/`、人間待ちは `blocked/`（そこでキューは止まる）。

## 守ること

- 秘密情報（`.env`、鍵、トークン、Cookie）を含むファイルや本文を渡さない。ブリッジは拒否するが、拒否されたら **消して通さず** 対象から外す
- 送信状態が不明な request を再送しない
- ブリッジの実行中にブラウザを操作しない
- 「ChatGPT の回答」は一次情報ではない。URL や数値は確認してから採用する
- **プロファイル・ブラウザ・ログインセッションは同時に 1 つしか無い専有リソース**。他のセッション（別の Claude Code / Codex / 人間の手動操作）が同時に使っている可能性を常に想定する。`chatgpt-bridge login` を「動作確認のため」だけの目的で試しに実行しない — 人間が手動ログイン中のブラウザと衝突してクラッシュや認証切れを引き起こし得る。`doctor` の `login` が NG のときだけ、人間に断ってから使う
- daemon 稼働中にブラウザで手動ログインし直す必要があるときは、先に `chatgpt-bridge daemon stop`（プロファイルは 1 つの Chrome しか持てない）→ 手動ログイン → `chatgpt-bridge daemon start` の順で
- **このリポジトリフォルダ自体を複数ホスト（Win/Mac 等）で共有マウントしない**（`node_modules` のネイティブバイナリが OS/アーキテクチャ依存のため壊れる。実際に Mac 側の `npm install` が Windows 側のバイナリを上書きした事故が発生済み）。各ホストは git 経由（pull/push）でのみ同期する別クローンを使う。どうしても共有せざるを得ない場合は、`CHATGPT_BRIDGE_RUNTIME_DIR` を各ホスト固有のローカルパスに設定すること（`runtime/`＝profile・lock・daemon.json も分離される。未設定だと `doctor` の `runtime.location` が warn を出す）
- Cloudflare の「私はロボットではありません」チェックが出ることがある（特に新しいプロファイルで頻発。ホストによって差が出て構わない）。**ブリッジは自動で突破しない** — 可視ブラウザに出ているので人間がその場でクリックして通過する。何度か通過するとプロファイルに信頼履歴が付き頻度が下がる

## dot MVP

`run --request <path> --json` accepts the PO's persistent dot thread:

```json
{ "schemaVersion": "1.2", "requestId": "20261001T120000Z-a1b2c3d4", "target": "dot",
  "promptFile": "prompt.md", "completionMarker": "以上で完了",
  "timeoutMs": 900000, "responseFormat": "markdown" }
```

Dot performs real actions, including GitHub access and Codex tasks. When appropriate, write
「Codex タスクは起動しない・読み取りのみ・外部操作はしない」 in the prompt. This is the PO's
persistent thread: use one request at a time and avoid concurrent manual input. The bridge adds an
automatic-send/requestId prefix. Ask for the exact completionMarker at the end of the final reply;
otherwise completion uses 25 seconds of quiet plus 3 seconds without typing. Attachments are not
supported. Dot results use schema 1.3, replyCount and files[]. On timeout/unknown submission, never
resend: use collect as described below.
Live verification of this implementation by the managing session is pending.


For dot long tasks, always set completionMarker: dot can remain silent for minutes, so the
25-second fallback without a marker is unreliable. A marker requires 3 seconds without typing
and a 5-second thread settle. Never resend after timeout: `collect <requestId> [--json]` checks
progress without sending; `--save` retrieves replies/files under `collected/<UTC>/`, preserving
original outputs. Exit 6 means in_progress/unknown and is retryable; explicit URL recovery is refused.

Dot automatically appends a unique completion token (`完了: <requestId>`) unless the request sets `completionMarker`. `collect <requestId>` also works after completion without submit.marker; older requests without a recorded marker return `unknown`.

### dot is a shared thread: only attributed replies are collected (A-200)

The dot thread is shared with the PO's manual use. `run` and `collect <requestId>` (with and
without `--save`) never take "every reply after the own row". A dot row after the own row is
collected only when its text contains this requestId, or contains the completion marker
(`completionMarker`, default `完了: <requestId>`) before the next self (PO or other request) row;
a row naming a different requestId is never collected. Files are retrieved only from chips on
collected rows. All other rows (replies to the PO's manual messages, untagged continuations,
attachment-only rows) are excluded from response.md, files/, replyCount, files and the
complete/in_progress decision, and are reported only as counts:
`dot_unrelated_rows_excluded: N rows, M files`. The subset that sits after this request's first
collected row and before the next self row (possibly this request's untagged continuation or
attachment) is additionally counted as `dot_untagged_rows_after_own_reply: N rows, M files`;
check those manually in the thread. No excluded text or file name is ever written.

The automatic instructions appended to every dot prompt are now, in order:
「この依頼への返信はすべて、先頭の行に「requestId: <requestId>」と書いてください（添付を付ける返信にも）。」
(omitted when prompt.md already contains `先頭の行に「requestId: <requestId>」`) and the existing
final-line completion-token instruction (omitted when the prompt already contains the marker).
A generic custom completionMarker (for example 以上で完了) only counts before the next self row;
prefer the default unique token. If only unrelated replies exist, replyCount is 0 and the state
is never complete. Live behaviour of this filter is not yet verified.

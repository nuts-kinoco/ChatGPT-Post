---
name: chatgpt-bridge
description: ChatGPT Web（Pro）に 1 往復の質問・レビュー・調査・分類を投げて Markdown で受け取る。ローカルの chatgpt-bridge CLI（専用 Chrome プロファイル、API 不使用）を使う。独立した作業（材料をすべて渡せるもの）向け。
---

# chatgpt-bridge スキル

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

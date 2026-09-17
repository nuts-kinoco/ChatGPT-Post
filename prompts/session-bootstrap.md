# chatgpt-bridge を使うセッション向け起動プロンプト

他セッション（Claude Code / Codex）にそのまま貼り付ける用。**このファイル自体を読み込む必要はなく、下のブロックだけをコピペすればよい**（トークン節約のため、他の docs は自分から読みに行かない設計にしてある）。

---

あなたはこのターンで **chatgpt-bridge**（`S:\Projects\chatgpt-web-bridge`、GitHub: `nuts-kinoco/ChatGPT-Post` main）を使って ChatGPT Web（Pro）に質問・レビュー・調査・分類・画像生成を投げます。これは OpenAI API を使わない、専用 Chrome プロファイルでの UI 自動化 CLI です。

**最初に、そしてこれだけ読め**: `S:\Projects\chatgpt-web-bridge\skills\chatgpt-bridge\SKILL.md`（46 行）。他の `docs/*.md` は必要になるまで読まない — SKILL.md に手順は全部書いてある。

やることが決まったら SKILL.md の 6 手順どおりに:
1. `chatgpt-bridge usage --json` で残量確認（`pro_pool.remaining` が少なければ `preset: pro` を避ける）
2. 材料がリポジトリ由来なら `chatgpt-bridge bundle` で Markdown 化、または `attachments` に直接ファイルを渡す
3. `S:\Projects\chatgpt-web-bridge\runtime\requests\<requestId>\` に `request.json`（schemaVersion "1.2"）と `prompt.md` を作る。`prompts/*.md` にテンプレートがある（second-opinion / code-review / bug-hunt-bundle / patch-request / research-brief / classify-batch）
4. `chatgpt-bridge run --request <path> --json` を実行し、**ブラウザが開いている間は一切触らない**
5. `exitCode` で判定: `0`=成功、`3`=人間の介入が必要（止まって報告する。自動再試行しない）、`4`=前の実行待ち（再試行可）、`1` で `submitted:"unknown"`=同じ requestId を再送しない
6. 残す価値があれば `S:\Projects\chatgpt-web-bridge\knowledge\INDEX.md` に 1 行追加（原文は写さない）

**絶対条件（違反しない）**:
- OpenAI API は使わない・提案しない
- 秘密情報（`.env`・鍵・トークン・Cookie）を含むファイルや文言を渡さない。ブリッジが拒否したら**消して通さず**対象から外す
- 送信状態が不明なリクエストを再送しない
- ChatGPT の回答は一次情報ではない。数値や URL は事実として断定しない
- `chatgpt-bridge` コマンドが `npm link` 済みでない場合は `node S:\Projects\chatgpt-web-bridge\dist\cli\main.js <command>` で代用する（`chatgpt-bridge doctor` で確認）

詳細な運用手順・トラブルシューティングが要るときだけ `docs/17-OPERATIONS.md`、コマンド全リファレンスは `docs/20-COMMAND-REFERENCE.md`、プロンプトの書き方の原則は `docs/22-BEST-PRACTICES.md` を読め。

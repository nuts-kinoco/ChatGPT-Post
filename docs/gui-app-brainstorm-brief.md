# GUI化 壁打ち用ブリーフ (2026-09-25)

このドキュメントは実装依頼ではなく、**壁打ち（アイデア出し・要件洗い出し）専用**の資料です。
別LLMセッションに「リポジトリを読む」「このmdを読む」「機能案をブレストする」を依頼するために書いています。
このセッションでは何も実装しないでください。

## 背景

`chatgpt-bridge` は ChatGPT Web の画面操作を自動化するCLIツール（OpenAI APIは使わない）。
現状は以下の課題がある：

- すべてCLI経由のため、**進捗・送信内容・ハンドシェイクの状態がユーザから見えない**
- ブラウザの起動/終了、Cookie再ログインなどの操作を都度、人間が管理LLM（Claude等）に依頼している
- 複数クライアント（人間の手動操作、複数のLLMセッション）が同じプロファイル/ブラウザ/ログインセッションを奪い合う専用リソースであり、「今誰が何をしているか」が一覧できない

そこで、CLI/daemonの状態を可視化し、一部の安全な操作をボタン化する**軽量GUIアプリ**を検討している。

## 現状のアーキテクチャ（壁打ちの前提として読んでおくべき箇所）

- リポジトリ: `S:\Projects\chatgpt-web-bridge`（GitHub: `nuts-kinoco/ChatGPT-Post`, main）
- 使い方の一次情報: [`skills/chatgpt-bridge/SKILL.md`](../skills/chatgpt-bridge/SKILL.md)（46行、まずここ）
- 運用: [`docs/17-OPERATIONS.md`](17-OPERATIONS.md)
- コマンド全リファレンス: [`docs/20-COMMAND-REFERENCE.md`](20-COMMAND-REFERENCE.md)
- アーキテクチャ: [`docs/10-ARCHITECTURE.md`](10-ARCHITECTURE.md)、状態機械: [`docs/11-STATE-MACHINE.md`](11-STATE-MACHINE.md)
- 変更履歴と設計判断の理由: [`docs/DECISION-LOG.md`](DECISION-LOG.md)（A-1〜A-162、末尾が最新）
- CLIエントリポイント群: `src/cli/main.ts`, `submit.ts`, `collect.ts`, `run-watchdog.ts`, `worker.ts`, `adapters.ts`

### 現在CLIで持っている状態・情報源（GUIのバッキングデータ候補）

- `chatgpt-bridge doctor` — daemon/lock/profile/login状態、heartbeat age、abandoned-lock状態、`temp.artifacts`の残留警告などをJSONで返す
- `chatgpt-bridge unlock --stale` — デッドプロセスや再利用PIDによる不整合ロックの解除（生きているオーナーのロックには手を出さない）
- `chatgpt-bridge collect <requestId>` — 送信済みだが結果を取りこぼしたリクエストを、再送せずに会話から回収する
- ロック/ハートビート機構（PID + プロセス開始時刻で本人性確認、定期ハートビート書き込み、`reclaimable`フラグでデッドPIDによる停滞と生きてるが無応答な停滞を区別）
- `runtime/` 以下にリクエストごとの `result.json`、トレース(Playwright trace)、ログが残る

### 安全上の制約（GUI設計でも必ず守ること）

- **1プロセス・1プロファイル・1ブラウザ・1ログインセッションの専用リソース**。GUIから「起動」「停止」「Cookie更新」のような操作系ボタンを作る場合も、既存CLIコマンド・既存のfail-closedなロック機構を必ず経由すること。GUI自身が新しい二重起動・競合の抜け道になってはいけない
- 表示系（一覧・ログ・タイミング）は既存の `doctor`/`runtime/`配下の情報を読むだけなので低リスク
- 操作系（起動/停止/Cookie更新）は既存CLIを裏で呼ぶだけに徹するのが安全側の設計方針
- 秘密情報（Cookie、セッション情報そのもの）をGUI上に表示しない

## ユーザが今回挙げている欲しい機能（たたき台、優先度未定）

- ブラウザを立ち上げる（今まではLLMに「立ち上げて」と依頼していた）
- ブラウザを閉じる
- Cookieを更新する（再ログイン導線）
- ログを確認する
- 完了通知を出す
- 使用中セッション・リクエストID・内容を一覧化する
- 停止（実行中リクエストのキャンセル）
- 送受信時間・完了時間の表示

## 壁打ちで出してほしいアウトプット

1. 上記のたたき台に対する評価（必須/あったら嬉しい/不要・危険の分類）
2. 上記以外で「あったらいい機能」の追加案（リポジトリの実装・ドキュメントを読んだ上での提案）
3. 表示専用機能 と 操作系機能 の切り分け案（安全性の観点で）
4. 技術選定の論点（例: Electron / Tauri / ローカルWebUI(Node+静的ページ) など）とそれぞれのトレードオフ
5. GUIが読むべきデータソース（`doctor`出力、`runtime/`配下のファイル、ロックファイルなど）の具体的なマッピング案

**この段階では実装はしないこと。あくまでアイデア・要件の壁打ちに留めること。**

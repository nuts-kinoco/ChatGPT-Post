# 00 — Product Brief: ChatGPT Web Bridge

| 項目 | 値 |
|---|---|
| 文書版 | 1.0 (Phase 1 draft) |
| 作成日 | 2026-09-14 |
| 状態 | Phase 1 成果物。Phase 3 で設計 Freeze 時に再確認する |
| Source of Truth | PO から渡されたマスタープロンプト（2026-09-14 版）。本書はそれを要約・構造化したもの |

## 1. 一文定義

> ログイン済みの専用ブラウザプロファイルを使って ChatGPT Web へ単発プロンプトを送信し、生成完了後の回答を Markdown と機械可読な結果 JSON として返す、Windows 優先・ローカル専用・直列実行型の CLI ブリッジ。

## 2. 背景と動機

PO は Claude Code Max、Codex Pro、および ChatGPT の契約（高性能な Chat モデルを Web UI で利用可能）を持っている。

- OpenAI API の従量課金は使わない。**追加 API 費用ゼロが絶対条件**。
- Codex の利用枠を節約したい。
- Claude Code / Codex が設計・実装・原因調査で詰まったとき、ChatGPT Web を「外部アドバイザー」として使いたい。
- 現状は PO が質問と回答を手動でコピー＆ペーストしており、PO が「伝書鳩」になっている。
- ローカルのオーケストレータ（主に Claude Code）が質問を送り、回答をファイルとして受け取り、そのまま作業を継続できるようにしたい。

## 3. 目標とする利用フロー

```text
Claude Code / ローカルオーケストレータ
    ↓ request.json + prompt.md
ChatGPT Web Bridge（本プロダクト）
    ↓ 可視ブラウザで ChatGPT Web を通常操作
ChatGPT が回答
    ↓ 生成完了を検出し回答を抽出
response.md + result.json
    ↓
Claude Code が回答を読み、元の作業を継続
```

## 4. 利用者とユースケース

| 利用者 | 役割 |
|---|---|
| PO（人間） | 初回ログイン、CAPTCHA・再ログイン等の手動介入、運用判断 |
| Claude Code | 主な呼び出し元。request.json を書き、result.json / response.md を読む |
| Codex（将来） | 同上の呼び出し元候補。MVP では対象外 |

代表ユースケース:

1. Claude Code が実装で詰まり、設計案の比較を ChatGPT に相談する。
2. 難しいバグの独立した原因仮説を ChatGPT から得る。
3. 長文の技術資料のレビューを依頼する。

いずれも **低頻度・単発・直列** の利用である。高頻度・大量・並列の利用は目的外。

## 5. MVP の境界

### 5.1 MVP に含む

- Windows 10/11 優先、Node.js LTS、TypeScript strict、Playwright
- 専用永続ブラウザプロファイル（通常 Chrome プロファイルは使わない）
- `login` / `doctor` / `run` / `inspect-ui` の CLI
- 新規チャット作成、Markdown プロンプト投入、UI プリセット（effort）の選択と検証
- 生成開始・終了・安定化の多信号検出
- 最新 assistant 回答の抽出（コピー操作 → DOM→Markdown 変換 → innerText の順のフォールバック）
- `response.md` と `result.json` のアトミック書き出し
- タイムアウト、エラー分類、失敗時のスクリーンショットと Playwright trace
- 二重送信防止と 1 プロセス / 1 リクエストの排他制御
- 終了コード、`doctor` による環境診断、README と運用手順

### 5.2 MVP に含めない（Won't for MVP — 将来の再検討は可）

添付ファイル、画像入出力、音声、既存会話の継続、プロジェクト指定、Custom GPT、複数アカウント、複数ブラウザ並列、サーバー常駐化、HTTP REST API、Redis/DB/メッセージブローカー、Linux/macOS の完全対応。

### 5.2a 恒久的に行わない（絶対条件 8・11、FR-094 / FR-095。MVP 後も再検討しない）

ChatGPT 内部通信の解析・再送、非公開 API の直接呼び出し、自動ログイン、CAPTCHA 回避、bot 検知回避、stealth / UA / fingerprint 偽装、Cookie / トークン / HAR の抽出。

### 5.3 MVP 後の候補

ファイルキュー監視、会話継続、一時チャット対応、添付ファイル、Chrome 拡張 + Native Messaging 方式の再評価、複数呼び出し元向けローカル RPC。

**MVP 外の機能を「将来必要そう」という理由で先回り実装しない。**

## 6. 絶対条件（PO 決定。変更不可）

1. OpenAI API を使わない。無料枠・試用枠・API キー・従量課金を代替案として提示しない。
2. ChatGPT Web を使う。
3. 返答の回収まで行う。送信だけの半自動ツールでは不十分。
4. ユーザーの通常 Chrome プロファイルを直接自動化しない。専用プロファイルを使う。
5. 可視ブラウザを基本とする。MVP で headless を優先しない。
6. 単一リクエストを直列処理する。並列化しない。
7. モデル / effort が確認できない場合は fail closed する。勝手に別プリセットへフォールバックしない。
8. 内部 API を再現しない。DOM・アクセシビリティ・通常 UI 操作のみを基本とする。
9. OCR を使わない。DOM またはクリップボードから回答を取得する。
10. 秘密情報をログ・Git・成果物へ残さない。
11. CAPTCHA、再ログイン、利用上限等は手動介入ステータスで停止する。
12. 実装前に仕様を固め、各フェーズにゲートを設ける。

## 7. 成功の定義（プロダクトレベル）

- Claude Code が人間のコピー＆ペーストなしに ChatGPT Web の回答をファイルとして受け取れる。
- 失敗時に「何が起きたか」「再送されたか否か」「人間が何をすべきか」が `result.json` から一意に分かる。
- ChatGPT UI が変わったとき、誤操作せず `DOM_CHANGED` で停止し、修正すべき箇所（selector 集約点）が明確である。
- 認証情報がリポジトリ・ログ・成果物に混入しない。

失敗の定義: 上記のいずれかを満たさない。特に **失敗を成功と報告すること**、**送信済みか不明な状態での自動再送**、**モデル選択の暗黙フォールバック** は重大な失敗である。

## 8. PO が介入する場面（想定）

| 場面 | PO の操作 |
|---|---|
| 初回セットアップ | `chatgpt-bridge login` で開いた専用ブラウザで手動ログイン |
| セッション失効 | 同上で再ログイン |
| CAPTCHA / Cloudflare / Turnstile 等のチャレンジ | 専用ブラウザで手動対応。ブリッジは `manual_intervention_required` で停止済み |
| 利用上限到達 | 待機または上位プランの判断。ブリッジは自動待機・再送しない |
| ChatGPT UI 変更で `DOM_CHANGED` | `inspect-ui` の出力を基に selector 更新（Claude Code が主担当） |
| 規約・アカウントリスクの再評価 | PO の事業判断 |

## 9. 明示的に扱う残存リスク

本プロダクトには OpenAI 利用規約上のリスクおよびアカウントリスクが存在する（詳細は `03-RISK-REGISTER.md` R-001）。本プロジェクトは法的評価を断定しない。**このリスクの記載は以降のフェーズでも削除しない。**

## 10. 関連文書

- `01-RESEARCH-AND-DECISION.md` — 調査結果と方式決定の根拠
- `02-REQUIREMENTS.md` — 要件（FR / NFR / SEC / OPS）と MoSCoW
- `03-RISK-REGISTER.md` — リスク登録簿
- `04-ACCEPTANCE-CRITERIA.md` — 受入条件
- `05-PHASE-PLAN.md` — フェーズ計画とゲート
- `PROJECT_STATUS.md` — 現在の状態
- `DECISION-LOG.md` — 軽微な仮定・判断の記録

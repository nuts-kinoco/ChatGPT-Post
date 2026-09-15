# Independent Architecture Review Request

あなたは独立した敵対的アーキテクチャレビュー担当です。
コードや文書を変更してはいけません。レビューだけを行ってください（サンドボックスは read-only です）。

対象は、ChatGPT Web の通常 UI を Playwright で操作し、プロンプト送信から回答回収まで行うローカルブリッジ「ChatGPT Web Bridge」の **MVP 設計（Phase 2 完了時点、実装前）** です。
OpenAI API、非公開 backend API、HAR / Cookie 抽出、ネットワーク傍受、CAPTCHA 回避、bot 回避、stealth / UA 偽装、OCR は使用しません。可視ブラウザ、専用永続プロファイル、単一リクエスト直列実行、モデル / effort が確認できなければ fail closed、送信境界以降は絶対に再送しない、が設計の前提です。

## 読むべきファイル（リポジトリルートからの相対パス。すべて読んでください）

要件（Phase 1、確定）:
- `docs/00-PRODUCT-BRIEF.md`
- `docs/02-REQUIREMENTS.md`（要件 ID: CON / FR / NFR / SEC / OPS、§7 エラーコード表）
- `docs/03-RISK-REGISTER.md`
- `docs/04-ACCEPTANCE-CRITERIA.md`

設計（Phase 2、本レビューの対象）:
- `docs/10-ARCHITECTURE.md`
- `docs/11-STATE-MACHINE.md`
- `docs/12-IO-CONTRACT.md`
- `docs/13-ERROR-MODEL.md`
- `docs/14-SELECTOR-STRATEGY.md`
- `docs/15-SECURITY-AND-PRIVACY.md`
- `docs/16-TEST-STRATEGY.md`
- `docs/17-OPERATIONS.md`
- `docs/adr/001-playwright-ui-automation.md` 〜 `005-single-flight.md`
- `schemas/request.schema.json`, `schemas/result.schema.json`

参考（自己検証の記録。既に反映済みの指摘を再報告しないための参照）:
- `reviews/phase2-self-review.md`
- `docs/DECISION-LOG.md`

## 重点的に探してほしいこと

1. 二重送信につながる race condition（ロック、marker、stale 回収、同一 requestId の二重起動、プロセス kill 後の再実行）
2. 送信済みか不明な状態での危険な retry
3. 古い DOM 参照、SPA 再描画、stale locator
4. 生成完了の早期誤検出・永久待機（思考中の一時停止、後描画、出力打ち切り、複数回答、Canvas）
5. モデル／effort の誤選択と暗黙フォールバック（`preset: current` を含む）
6. 認証切れ、CAPTCHA、利用上限、ブラウザクラッシュ
7. プロファイル競合とロック不備（Windows のファイルロック、PID 再利用、`lockfile` 排他）
8. Markdown 抽出の欠落・破損、失敗が `completed` として報告される経路
9. trace / log / screenshot / fixture による認証情報・個人情報の漏洩
10. Windows 固有のパス、プロセス、ファイルロック、エンコーディング（PowerShell 5.1）問題
11. テスト不能な密結合、fixture で再現できない判定
12. MVP の過剰設計または不足（要件 FR-090〜096 の Won't に対する先回り、逆に Must を満たさない箇所）

## 出力形式

- Executive summary（3〜6 文）
- Findings table: `ID | Severity (Critical/High/Medium/Low) | File §section | Evidence（対象文書の文言を引用） | Impact | Recommendation`
- Missing acceptance tests
- Architecture alternatives worth reconsidering
- Ship / Do not ship verdict for proceeding to vertical slice（Phase 4）

根拠のない一般論ではなく、対象文書のファイル名と節を引用して指摘してください。設計文書間の矛盾は両側の文言を引用してください。日本語で書いてください。

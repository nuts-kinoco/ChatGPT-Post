# 最終実装レビュー依頼（Codex, High）

対象: リポジトリ全体（`src/**`, `schemas/**`, `tests/**`, `skills/**`, `prompts/**`）。設計は `docs/10`〜`17`、`20`〜`22`、決定は `docs/DECISION-LOG.md` A-001〜A-098、Live 結果は `docs/live-results/`。過去のレビューと裁定は `reviews/phase{3,4,5,6}-*`。読み取り専用。

これは MVP 最終レビューです。**PO の絶対条件と禁止事項**（`docs/02-REQUIREMENTS.md` CON-*、SEC-*、`docs/00-PRODUCT-BRIEF.md`）に対する違反・逸脱を最優先で探してください。

## 観点
1. **禁止事項の網羅確認**: OpenAI API 不使用、内部 API 不使用（`fetch(img.src)` は A-069 で PO が許容した範囲か、`backend-api` を直接叩く経路が無いか）、Cookie / Token / HAR の抽出なし、ステルス・UA 偽装なし、CAPTCHA 回避なし、送信不明状態からの再送なし、失敗を成功として扱わない、ヘッドレス不使用（fixture テストの headless は ChatGPT に接続しないので許容と判断している。妥当か）
2. **送信境界**: 全経路（run / worker / newChat:false / 添付あり / 画像ビューア opt-in）で「送信前に marker を書く」「送信は 1 回」「不明なら unknown」が保たれているか
3. **秘密情報**: ログ・result.json・trace・bundle・添付ガード・`usage`・`knowledge/` の規約に漏れ経路が無いか
4. **状態機械と controller の一致**: `11-STATE-MACHINE.md` §4 と `machine.ts` の乖離、controller で機械を迂回している箇所（`CLOSE_BROWSER` 内の restoreEffort、`EXTRACT_LATEST` 内の画像取得は設計上の追加として妥当か）
5. **worker**: 直列性、孤立回復、requestId 検証、無限ループ
6. **テスト**: 132 件で足りていない重要分岐（特に page.ts の実ブラウザ依存部分の fixture 化余地）
7. **SKILL.md / prompts / 22**: 他 PJ の Claude Code / Codex がこの手順に従ったとき、絶対条件を破る誘導が無いか

## 出力形式
Markdown。`[Critical|High|Medium|Low] <ファイル:行> — 内容 — 根拠 — 提案`。Critical/High は再現条件付き。最後に「絶対条件チェックリスト（各条件: 準拠 / 要注意 / 違反 と根拠）」「設計との乖離一覧」「良い点」「MVP として出荷可能かの所見」。

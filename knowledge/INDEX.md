# knowledge INDEX

1 行 1 件。`日付 | 種別 | タイトル | 要点 1 文 | requestId | 状態`。規約は `docs/22-BEST-PRACTICES.md` §5。

| 日付 | 種別 | タイトル | 要点 | requestId | 状態 |
|---|---|---|---|---|---|
| 2026-09-15 | research | Pro プランの利用上限（ChatGPT 自身の回答） | Thinking は段階で消費差なし、Pro 系は週次上限、添付 80 件/3 h。公式未確認 | 20260915T063230Z-14314bf9 | adopted（参考値として R-012） |
| 2026-09-15 | review | inventory.ts のレビュー（CX-01） | 仕込んだ 3 件を 3/3、誤検出 0。レビュー用途で Codex 代替の見込み | 20260915T071252Z-7a60f691 | adopted（評価根拠） |
| 2026-09-15 | review | CX-05 修正パッチ生成 | unified diff が git apply 通過、3 バグ解消 | 20260915T072656Z-675ae863 | adopted（評価根拠） |
| 2026-09-15 | review | CX-06 思考量比較 | medium と extra_high で同品質（3/3）、時間は 50 s vs 91 s | 20260915T080200Z-91453910 / 20260915T080105Z-e9b5b24d | adopted（22 §2 の原則 7 に反映） |
| 2026-09-15 | classify | EX-08 Danbooru 風タグ付け 30 件 | 30/30 有効な JSON Lines、4〜8 タグ、70 s | 20260915T075931Z-3d1ae5d3 | adopted（えまきのこ / たぐきのこの方式として） |
| 2026-09-15 | other | MM-02 画像生成の受け取り | ビューア「保存」は Chrome クラッシュ、ページ内 fetch で取得 | 20260915T074954Z-9fe9699e | adopted（A-092） |
| 2026-09-15 | review | PixivVault discovery_tab.py 画像サイズ仕様書レビュー | 原因特定は妥当だが修正案(keep_image=True)が#48-B型の罠を再現する懸念を指摘。plan変化時のみ再構築へ設計変更が必要 | 20260915T105935Z-01c8798c | adopted（仕様書改訂へ反映予定） |
| 2026-09-17 | research | hunkヘッダ行数不一致の原因調査 | ヘッダ先行フォーマット+自由テキスト生成が原因と推定(トークナイザのバグではない)。対策は3段: (1)old/new countの計算式を明文化する注意書き (2)bridge側でhunk-count validatorを機械検証 (3)長期的にはLLMにOLD/NEW編集指示だけ書かせgit diffでヘッダ生成 | 20260917T030032Z-59d11c90 | adopted（bridge側validator追加は未実装・提案） |

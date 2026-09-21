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
| 2026-09-17 | second-opinion | EMAKINOCO 生成キューの TAGKINOCO ワンショット拡張 | 案 B（GenerateIntent → コーディネータ → 既存キュー）。quality_key の実体化、client_request_id、pause は pending のみ | 20260916T145407Z-4f6ada5b | adopted（Windows 版 Phase 9） |
| 2026-09-17 | second-opinion | 監視フォルダ／一括 img2txt | 1 秒ポーリング + settle 判定（size/mtime 安定 → full decode → stat 一致）。.txt は同名 sidecar、既存はスキップ既定 | 20260916T145409Z-ea04eb63 | adopted |
| 2026-09-17 | research | Flet 0.24 → 1.0 移行 | ft.run、単一イベントループ（最重要）、FilePicker は await、Ref/label_style/on_secondary_tap 存続、ネイティブ D&D は core に無い、flet pack 可 | 20260917T040610Z-250e9290 | adopted（Windows 版 Phase 0/1） |
| 2026-09-17 | second-opinion | UI 応答性 13 フェーズの取捨 | 10（実機計測）を先に、11〜13 は後回し。render の single-flight 化と lock 内 I/O 分離を追加提案 | 20260916T145411Z-6fe9aa79 | pending（Mac 版は保守のみ） |
| 2026-09-17 | second-opinion | center_panel.py 分割手順 | characterization test を先に固定し、葉（設定プリセット）から抽出。Ref は返さずコールバック注入 | 20260916T145412Z-3dbac23b | adopted（Windows 版 Phase 3） |
- 20260920T200837Z-9b60f1ef | EMAKINOCO-Win: WAI-Illustrious v17 配布元推奨（steps15-30/CFG5-7/Euler a/Hires1.5x 20steps Anime6B denoise.35-.5）、18vs20 steps は根拠なし、Tiled VAE は OOM fallback。~~ブリッジは送信成功を失敗と誤報+下書き残留で composer_not_empty（要修正）~~ → 両方修正済み（A-139: 下書き残留、A-143: 送信成功の誤報。根本原因はProseMirrorの改行ブロックレンダリングと`innerText()`読み戻しのズレ）

## レビュー結果

Critical / High: 指摘なし。

[Medium] `src/state/controller.ts:445-475` — `result.json` を書いた後に `CLOSE_BROWSER` 内で `restoreEffort()` を実行するため、復元失敗時に追加する `warnings[].restore_effort_failed` は既存の `result.json` に反映されません。`docs/11-STATE-MACHINE.md:93` と `docs/12-IO-CONTRACT.md:143` の契約にも反します。— 復元を `WRITE_RESULT` 前に完了させるよう effect 順序／設計を改めるか、復元失敗を結果へ確実に反映できる終端処理にしてください。`tests/unit/controller.test.ts` に復元失敗時の `result.json.warnings` を検証する回帰テストも必要です。

[Medium] `src/state/controller.ts:395-414` — `captureImages()` と120秒タイムアウトを `Promise.race()` しており、タイムアウト側が勝っても画像取得 Promise はキャンセルされず、`result.json` 確定・ブラウザ close 後も継続します。後から `images/` に書けても `result.json.images` や `response.md` には載らず、画像のみの回答では失敗結果の後に画像ファイルだけ残り得ます。— `AbortSignal` 等で取得を停止・待機するか、画像取得を result 確定前に必ず完結させてください。

[Low] `docs/21-CAPABILITY-EXPLORATION.md:73,137` — `fetch(img.src)` を「PO 判断待ち」「viewer download が第一案」と記載していますが、A-069/A-092、`src/chatgpt/page.ts:865-875`、Live 結果では page-side fetch を明示許容済みの主経路としています。— Phase 6 の決定済み状態・fetch-primary・viewer opt-in を反映し、OQ-010 を解決済みに更新してください。

## 絶対条件チェックリスト

| 条件 | 判定 | 根拠 |
|---|---|---|
| OpenAI API 不使用 | 準拠 | 製品コードに OpenAI SDK/API 呼出しなし。 |
| ChatGPT Web UI のみ | 準拠 | Playwright の通常 DOM/UI 操作のみ。 |
| 回答回収 | 準拠 | copy → DOM → innerText の抽出と `response.md` 出力あり。 |
| 専用プロファイル | 準拠 | profile guard が通常プロファイル・symlink/junction を拒否。 |
| 可視ブラウザ | 準拠 | 製品起動は `headless: false`。fixture のみ headless。 |
| 単一・直列送信 | 準拠 | プロセス lock と worker の逐次処理あり。 |
| preset/model の fail-closed | 準拠 | UI 再観測・不一致時 abort、暗黙フォールバックなし。 |
| 内部 API・HAR・Cookie・UA 偽装なし | 準拠 | 禁止 API の静的ガードあり。`fetch(img.src)` は A-069/A-092 の明示許容範囲で、任意の `backend-api` 経路を構成・直接呼出ししていません。 |
| OCR・座標回収なし | 準拠 | 回答抽出は DOM/copy capture のみ。 |
| CAPTCHA・ログイン・上限の自動回避なし | 準拠 | manual intervention へ停止。 |
| 送信前 marker・一回送信・unknown | 準拠 | `VERIFY_LOCK → WRITE_SUBMIT_MARKER → DISPATCH_SUBMIT` が一意。worker/newChat:false/添付も同一 controller を通る。 |
| 秘密情報の成果物混入防止 | 要注意 | redaction、trace sanitizer、添付 guard は妥当。ただし画像取得 timeout 後の非同期書込みは成果物の確定境界を曖昧にします。 |

## 設計との乖離一覧

- `CLOSE_BROWSER` の best-effort 失敗を `result.json.warnings` に残すという設計が、現在の result 書込み順では実現不能。
- 画像取得 timeout 後も処理が生存し、状態機械の effect 逐次完結という説明と実際の副作用時点が一致しない。
- `docs/21-CAPABILITY-EXPLORATION.md` の画像取得方針が、A-069/A-092 と実装から遅れている。

## 良い点

- 送信境界の marker、lock 再検証、click 直前 preset 再確認は堅いです。
- `newChat:false` は origin・URL・既存 turn・空 composer・非生成中を確認しており、既存会話への誤送信を防いでいます。
- worker の orphan recovery と marker による再送防止は適切です。
- 過去レビューで指摘された URL redaction、trace resource allow-list、添付 secret guard、画像パス制約は反映済みです。

## テスト

132 件という件数自体は十分性の証明にはなりません。今回の Medium 2 件、特に「復元失敗が結果へ記録されること」と「画像取得 timeout 後に非同期副作用が残らないこと」の回帰テストが不足しています。

この環境では `npm.cmd test` が Vite の一時設定ファイルを `node_modules/.vite-temp/` に作成できず、`EPERM` で起動前に停止しました。そのため今回、テスト成功・typecheck・lint の実行結果は確認できていません。

## MVP として出荷可能か

現状のままの出荷は見送りが妥当です。送信安全性・禁止事項には Critical/High の逸脱は見つかりませんでしたが、永続 effort 設定の復元失敗を利用者が検知できない点と、画像成果物の確定性が崩れる点は修正・回帰テスト追加後に再判定すべきです。
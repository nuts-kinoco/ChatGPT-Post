# daemon 自己復旧（A-110）— Codex レビュー裁定

日付: 2026-09-17 / 対象: A-110 差分 / 入力: `reviews/daemon-selfheal-codex.md`（Codex, gpt-5.6-terra, high, read-only）

Codex の結論は「Block 推奨」。High 4件はいずれも実害のある見落としで、全て採用した。

| # | 重要度 | 内容 | 裁定 | 対応 |
|---|---|---|---|---|
| R-1 | High | keepalive のロック確認が tick 開始時の1回のみで、`goto()`/`page.close()` を排他しない。実行中クライアントのページを daemon が閉じ得る | **採用** | `goto()` 失敗直後、ページを閉じて張り替える前にもう一度 `isLockHeld()` を確認し、held ならこの tick は何も触らず中断。完全な排他ではないが（daemon 自身がロックを取得するプロトコルには未参加）、実害の窓を大きく狭めた |
| R-2 | High | `context.newPage()` の成功だけで「復旧成功」とみなし、壊れたページでも `ok:true`／failure count リセットしていた | **採用** | 新規ページも `evaluate(() => true)` で応答確認してから採用。`browser/launch.ts` の `getUsablePage()` 側も同様に新規ページを検証してから返す |
| R-3 | High | `evaluate()` にタイムアウトが無く、CDP が半死状態だと無期限にハングし、lock を握ったまま停止し得る | **採用** | `browser/timeout.ts` に共通の `withTimeout()` ヘルパーを新設し、daemon-worker・launch.ts 双方の `evaluate()`/`goto()`/`context.close()` に適用 |
| R-4 | High | `shutdown()` が `context.close()` より先に state ファイルを消しており、close がハング・失敗すると実際には残っている daemon を「不在」と誤報し得る | **採用** | `close()`（bounded, 10s）を先に実行し、その後で state ファイルを削除する順序に変更 |
| R-5 | Medium | evaluate 失敗した壊れたページが放置され、attach のたびにタブが増え得る | **採用** | `getUsablePage()` は使えない候補ページを見つけたら再利用前に `close()` する |
| R-6 | Medium | `setInterval` に多重実行防止が無く、間隔を短く設定すると tick 同士が競合し得る | **採用** | `tickInFlight` フラグで多重実行を防止 |
| R-7 | Medium | `attach()` が失敗したとき、既に確立した CDP 接続（`browser`）を明示的に閉じておらず、接続がリークし得る | **採用** | `browser` を try の外で保持し、catch で必ず `browser.close()` |
| R-8 | Low | A-110 の直接テストが無い | **見送り（既存方針どおり）** | `browser/launch.ts`・`daemon-worker.ts` は実ブラウザ/CDP 依存で、A-102 以来 "実ブラウザ依存の CLI グルーコードは unit test 化にはより大きなリファクタが要る" として明記済みの既知のギャップ。今回も同じ扱いとし、実機検証で代替 |

## 修正後の検証

- `npm run typecheck` / `npm run lint` / `npm run build`: OK
- `npm test`: **152 passed**（回帰なし）
- Live: 「tracked page だけ close、context は生存」を再現 → `doctor`/`run` が daemon 再起動を待たず即座に復旧することを再確認（reworked 後のコードで再検証、daemon の pid 変わらず）。実際の `run` も正常完走を確認
- 連続失敗による自己終了・ロック競合時の中断（R-1, R-4）は経路をコードレビューで確認、安全に再現する手段が無いため実機での長時間再現待ち（Mac 側フォローアップ）

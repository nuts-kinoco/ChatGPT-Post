結論: **Block 推奨**です。OpenAI API 利用・認証自動入力・CAPTCHA 回避・headless 化は差分中に見当たりませんが、A-110 の fail-closed と並行安全性には重大な穴があります。

- **High — lock の TOCTOU により、実行中クライアントのページを daemon が閉じ得る。**  
  `src/browser/daemon-worker.ts:100-103` はロックの有無を確認するだけで、`107-140` の `goto()`・`newPage()`・`page.close()` を排他しません。確認直後にクライアントがロックを取得し（`src/cli/main.ts:66-95`、`src/state/controller.ts:245-267`）、同じページへ attach した場合、daemon が失敗回復時に `page.close()`（`daemon-worker.ts:126`）して実行中の request を壊せます。既報の `page closed`／submitted 後失敗を再発させ得ます。同じ lock を daemon 側でも非ブロッキングに取得し、回復処理全体を覆う必要があります。

- **High — `newPage()` 成功だけを復旧成功とみなし、壊れたページを `ok:true` として返す。**  
  daemon は `src/browser/daemon-worker.ts:125-130` で `fresh` の `isClosed()`／応答性を確認せず failure count を 0 に戻します。直後に close されたページや CDP 応答不能ページなら、以後も「`goto` 失敗 → `newPage` は形式上成功 → counter reset」を繰り返し、自己終了しません。  
  同じ問題が client 側の `src/browser/launch.ts:84` にあり、`context.newPage()` の戻りを未検証で attach 成功にします。これは「使えるページを得られなければ attach 失敗」という fail-closed 要件から外れます。

- **High — `evaluate()` に待ち時間の上限がなく、attach と bridge lock を無期限停止できる。**  
  `src/browser/launch.ts:78` の `candidate.evaluate(() => true)` はタイムアウトを設定していません。導入済み Playwright の `Page.evaluate` 型も timeout option を持ちません（`node_modules/playwright-core/types/types.d.ts:190`）。半死状態の CDP が応答を返さなければ attach が戻らず、保持済み lock により keepalive は `skipped: lock held` のままです。今回直したい「running のまま分かりにくく停止」の再発経路になります。外側に明示的な短い期限と、期限超過時の CDP detach／失敗処理が必要です。

- **High — state を browser の終了確認より先に消すため、実際には残った daemon を “不在” と誤報し得る。**  
  `src/browser/daemon-worker.ts:60-66` は `unlink(statePath)` を `context.close()` より先に実行し、close の失敗も握り潰して `process.exit(0)` します。close がハング・失敗して Chrome が profile lock を保持すれば、次の CLI は daemon 不在と判断して launch を試み、profile contention になります。state は context／プロセスの終了を確認してから削除し、確認不能なら state を残して fail closed にすべきです。

- **Medium — 壊れた candidate が残り、短時間の複数 attach でタブが蓄積する。**  
  `src/browser/launch.ts:75-85` は evaluate 失敗した non-closed page を残したまま新規タブを返します。次の attach も `find()` が同じ壊れた先頭 page を選べば、keepalive の次 tick まで attach ごとに新タブを作ります。daemon 側も tracked page しか後で閉じないため（`daemon-worker.ts:107-109, 125-127`）、client が作った page を一貫して管理できません。

- **Medium — keepalive 自身も多重実行でき、共有 `page` と failure counter が競合する。**  
  `src/browser/daemon-worker.ts:164` の `setInterval(() => void keepAliveTick(), ...)` に in-flight guard がありません。環境変数で短い間隔を指定でき（`src/browser/daemon.ts:283-285`）、`goto` の 30 秒 timeout や `page.close()` の遅延と重なると、二つの tick が互いの replacement page を閉じたり、`consecutiveFailures` を不正に reset／加算します。

- **Medium — attach 失敗時に既接続 CDP を明示的に閉じない。**  
  `src/browser/launch.ts:116-142` では `connectOverCDP()` 後の `getUsablePage()`／handler 設定が失敗しても、catch は参照を null にするだけです。`browser.close()` が呼ばれず、CDP 接続・listener が残ります。A-110 によりこの失敗経路が通常の回復条件になったため、漏れが顕在化します。

- **Low — A-110 の直接テストがない。**  
  `tests/` に `BrowserSession`、`getUsablePage()`、keepalive replacement を検証するテストがありません。少なくとも「evaluate hang」「new page が即 close」「replacement 失敗2回」「lock 取得直後の keepalive race」「連続 attach の tab 数上限」を fixture／mock で固定すべきです。

特に最初の4件を直さずに受理すると、「死んだ単一 page を直す」変更が、別の request を閉じる・無期限 lock・daemon 不在の誤報へ置き換わる危険があります。
結論: このままはマージ不可です。特に daemon の「生存判定」と CDP 接続は、fail-closed を崩し得ます。

| 重要度 | 指摘 |
|---|---|
| High | 固定・無認証の CDP ポートにより、ローカルプロセスがセッションを乗っ取り得る |
| High | stale/reused/不正 PID を `stop` が終了させ得る |
| High | `daemon start` が通常プロファイル拒否と実行中コマンドとの排他を迂回する |
| Medium | daemon の死・ポート競合・状態ファイル競合を「正常」と誤認し得る |
| Medium | attach の接続を明示的に detach しておらず、trace エラーも握り潰す |

- **High — CDP は loopback でも強い能力を持つ無認証の制御口です。**  
  [src/browser/daemon-worker.ts:34-35](S:\Projects\chatgpt-web-bridge\src\browser\daemon-worker.ts:34) が固定の `9876` を `127.0.0.1` に開き、[src/cli/adapters.ts:117-128](S:\Projects\chatgpt-web-bridge\src\cli\adapters.ts:117) は PID 生存だけでそのポートへ接続します。別のローカルプロセスが先にポートを確保する、または稼働中 daemon 後に取得すると、bridge は別の CDP サーバー／別 Chrome に接続し得ます。CDP は OS ネイティブの任意コード実行そのものではありませんが、接続先ブラウザ内で任意の DevTools 操作・ページ JavaScript 実行を可能にし、ログイン済み ChatGPT セッションの会話・送信・Cookie 等に影響できます。Chrome も remote debugging が Cookie 抽出に悪用され得ると明示しています。[Chrome の公式説明](https://developer.chrome.com/blog/remote-debugging-port)

  固定ポートを廃止し、少なくともランダムなポート、状態ファイルのユーザー限定 ACL、ランダム capability による daemon 固有のハンドシェイク、CDP endpoint の実接続・期待 identity 検証が必要です。より安全なのは raw CDP を外部公開せず、ユーザー ACL を持つ named pipe 等で worker に限定 RPC を提供する設計です。

- **High — PID 再利用・不正 daemon.json で無関係なプロセスを kill できます。**  
  [src/browser/daemon.ts:33-43](S:\Projects\chatgpt-web-bridge\src\browser\daemon.ts:33) は `pid` を「number」であることしか検証せず、[55-62](S:\Projects\chatgpt-web-bridge\src\browser\daemon.ts:55) は PID 再利用を許容しています。その後 [65-87](S:\Projects\chatgpt-web-bridge\src\browser\daemon.ts:65) が `SIGTERM` / `SIGKILL` を送ります。コメントの「接続に失敗するので fail closed」は `stopDaemon()` には成立しません。特に POSIX では `0` や負の PID がプロセスグループを指し得ます。

  `pid` は正の safe integer、`port` は 1–65535 の整数に限定し、`startedAt` とプロセス作成時刻を `judgeStale()` 相当で照合してください。stop 前には「PID・開始時刻・daemon 固有 nonce・CDP 応答」がすべて一致することを確認し、不一致なら kill せず fail closed にしてください。

- **High — `daemon start` は既存のプロファイル安全境界と bridge 排他ロックを通りません。**  
  通常経路は [src/cli/main.ts:61-96](S:\Projects\chatgpt-web-bridge\src\cli\main.ts:61) および [src/state/controller.ts:239-255](S:\Projects\chatgpt-web-bridge\src\state\controller.ts:239) でプロファイル検証と lock を取得します。一方、[src/cli/main.ts:363-391](S:\Projects\chatgpt-web-bridge\src\cli\main.ts:363) の `cmdDaemon()` は直接 `startDaemon()` / `stopDaemon()` を呼びます。そのため `--profile-dir` で通常 Chrome プロファイルを指定しても `checkProfilePath()` が働かず、常駐自動化＋CDP がそのプロファイルに対して起動できます。

  `daemon start` にも同じ profile-path guard を必須化してください。また start/stop は bridge lock か専用 lifecycle lock を取得し、実行中の `run/login/doctor/inspect-ui` があれば stop は `ALREADY_RUNNING` で終了すべきです。

- **Medium — health/readiness 判定が実体を確認せず、競合時に別 state を採用します。**  
  [src/browser/daemon.ts:96-131](S:\Projects\chatgpt-web-bridge\src\browser\daemon.ts:96) は start 後に「任意の live PID の state」を ready として返します。子プロセス PID、profile、ポート、生成 nonce を照合しません。同時 `daemon start`、古い `daemon.json`、異なる profile の state で誤成功します。[src/cli/adapters.ts:117-119](S:\Projects\chatgpt-web-bridge\src\cli\adapters.ts:117) と [src/diagnostics/doctor.ts:112-146](S:\Projects\chatgpt-web-bridge\src\diagnostics\doctor.ts:112) も、その弱い health を根拠に profile contention を「free/expected」と隠します。

  state は atomic write にし、start ごとの nonce・期待 child PID を持たせ、ready は CDP 接続成功と nonce 検証まで完了して初めて成立させるべきです。ポート競合、daemon 異常死、state 破損は fresh launch に黙って進まず、明示的な `DAEMON_UNHEALTHY` として止める方が fail-closed に合います。

- **Medium — Windows で stop 成功を誤報し、Chrome を孤児化し得ます。**  
  [src/browser/daemon.ts:65-87](S:\Projects\chatgpt-web-bridge\src\browser\daemon.ts:65) は kill 失敗や 5 秒後も PID が残る場合でも state を削除し `ok: true` を返します。detached worker の終了と Chrome 子プロセスの終了は別問題であり、Windows の signal 挙動では graceful handler（[src/browser/daemon-worker.ts:64-66](S:\Projects\chatgpt-web-bridge\src\browser\daemon-worker.ts:64)）が必ず走る保証もありません。残った Chrome が profile lock を保持すると、次回は state がないのに起動できません。

  stop は worker、CDP endpoint、profile lock の消失を確認できるまで成功にせず、失敗時は state を残して原因を報告してください。可能なら signal ではなく認証済み control IPC で worker に `context.close()` を依頼します。

- **Medium — attach は実際には detach しておらず、trace の失敗も誤分類します。**  
  [src/browser/launch.ts:75-103](S:\Projects\chatgpt-web-bridge\src\browser\launch.ts:75) の `browser` がローカル変数のまま捨てられ、[128-141](S:\Projects\chatgpt-web-bridge\src\browser\launch.ts:128) は `Browser.close()` を呼びません。Playwright では接続済み Browser の `close()` は browser server から切断する動作です。[Playwright Browser API](https://playwright.dev/docs/api/class-browser#browser-close)  
  また trace 開始の全エラーを「previous command の trace」として無視しており、次の `stopTrace()` が `tracing not active` で失敗し得ます。

  接続済み `Browser` を session に保持し、daemon attach 時の close でそれだけを close/disconnect してください。trace は「既に実行中」と確認できる場合だけ抑制し、それ以外は起動失敗として伝播させるべきです。Playwright 自身も CDP attach は通常プロトコルより低忠実度と注意しています。[BrowserType.connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)

絶対条件については、差分上は OpenAI API 呼び出し・認証情報の自動入力・CAPTCHA 回避・headless 起動は見当たりません。`headless: false` と `--start-minimized` は可視ブラウザ要件にも適合します。ただし daemon start の profile guard 迂回と、弱い daemon health による profile lock の許可は fail-closed 原則からの逸脱です。

検証結果: `npm.cmd run typecheck` は成功。`npm.cmd run test:unit` は sandbox が `node_modules/.vite-temp` への一時ファイル作成を拒否して未実行でした。daemon 系の unit test 追加も差分にはありません。
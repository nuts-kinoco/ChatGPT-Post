[High] src/cli/main.ts:109 — クラッシュ後も `NOT_READY` として再試行する — `observeAuthWithRetry` は `CrashState` を受け取らず、クラッシュ中の `goto()` 失敗は `NOT_READY` に変換されるため、1.5 秒・3 秒待機後にも死んだページへ再アクセスする — `CrashState`（またはクラッシュ通知 Promise）を渡し、各観測・バックオフをクラッシュ通知と競争させて直ちにクラッシュ結果を返す。

[High] src/cli/main.ts:146 — ポーリング中のクラッシュが明確なクラッシュ終了を迂回する — `await page.currentUrl()` は `.catch(() => null)` の対象外であり、ここで reject すると `poll` が reject、`Promise.race()` 全体も reject する。クラッシュ検査はその前後だけなので、要求されたクラッシュメッセージと exit 1 にならない — `currentUrl` と `observeAuth` を一つの `try/catch` に含め、失敗時に `crash.cause` を確認する。より確実にはクラッシュ通知 Promise とポーリング操作を race させる。

[Medium] src/cli/main.ts:120 — `AUTH_OK` がクラッシュより優先され、成功終了が誤報になり得る — 初回観測の完了時点で `onCrash` が既に `cause` を設定していても、`auth.kind === "AUTH_OK"` を先に評価して 0 を返す。`doctor` は175行目でクラッシュを優先するため挙動も不統一 — `AUTH_OK` 判定の前にクラッシュを確認し、クラッシュは常に失敗として優先する。

[Medium] src/cli/main.ts:338 — `inspect-ui` はクラッシュ検出後も死んだページを操作する — 339行目で通知するだけで、345行目の `inspectUiReport`、348行目の `content` を継続する。結果として例外または不完全な成果物になり、クラッシュ検出を利用できていない — クラッシュを出力したら非ゼロで即時 return し、ページ操作を行わない。

[Medium] src/cli/main.ts:100 — 新しいクラッシュ・リトライ経路に回帰テストがない — 対象コミットにはテスト変更がなく、`NOT_READY` のみ3回試行すること、認証状態を再試行しないこと、待機中・`currentUrl()` 中のクラッシュ終了が検証されていない — 偽のページ／ブラウザポートで各状態とクラッシュ発火タイミングを固定した単体テストを追加する。

この修正で解決する問題

- 通常の一過性 `NOT_READY` を最大3回、1.5秒・3秒のバックオフで再観測する。
- `AUTH_REQUIRED`、`CHALLENGE`、`WRONG_PAGE` を再試行せず、fail closed を維持する。
- ログイン待機ループの待機前後で発生したクラッシュは検出できる。
- `withBrowser` の終了処理は、`BrowserSession.close()` が内部参照を先に無効化し、トレース停止失敗を握りつぶすため、既に閉じたコンテキストでも概ね安全に後始末する。

解決しない・未確認の問題

- 観測実行中、バックオフ中、または `currentUrl()` 実行中のクラッシュを即時・一貫して終了できない。
- `inspect-ui` のクラッシュ後操作。
- クラッシュと `AUTH_OK` が競合した場合の成功誤判定。
- `close()` はタイムアウト後にもう一度 `ctx.close()` を無制限に await するため、コメント上の「bounded close」が完全に保証されるかはこの差分では未解決です。
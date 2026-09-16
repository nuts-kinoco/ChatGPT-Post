# daemon モード（A-103）— Codex レビュー裁定

日付: 2026-09-16 / 対象: 未コミットの daemon モード差分 / 入力: `reviews/daemon-mode-codex.md`（Codex, gpt-5.6-terra, high, read-only）

| # | 重要度 | 内容 | 裁定 | 対応 |
|---|---|---|---|---|
| C-1 | High | 固定・無認証の CDP ポート（127.0.0.1:9876）。ローカルの別プロセスが同ポートを奪う／既存 daemon に相乗りできる | **部分採用** | 固定ポートをやめ、起動のたびに空きポートを OS に選ばせる（`net.createServer().listen(0)`）。完全な認証チャネル（named pipe + ACL）までは今回踏み込まない — 127.0.0.1 バインドのみで留まる残存リスクを DECISION-LOG に明記し、PO 専用 PC という前提（本人以外のログインユーザーがいない）を条件に許容 |
| C-2 | High | `stopDaemon` が PID 再利用や不正な pid を検証せず kill しうる | **採用** | `lock.ts` と同じ PID 再利用ガード（`processStartedAt` と `state.startedAt` の突合）を `checkDaemon`/`stopDaemon` に追加。pid が正の安全な整数でない・port が 1–65535 でない場合も不健全として扱う。不一致なら kill せず fail closed |
| C-3 | High | `daemon start`/`stop` が `checkProfilePath` のプロファイル安全境界と bridge の排他ロックを迂回する | **採用** | `cmdDaemon` の start/stop 冒頭で `checkProfilePath(cfg.profileDir)` を必須化し、start/stop 実行中だけ bridge lock を取得（daemon 稼働中は保持しない）。実行中コマンドがあれば `ALREADY_RUNNING` として拒否 |
| C-4 | Medium | health/readiness が実体確認なしに「PID が生きていれば OK」としており、同時起動や古い state ファイルで誤判定しうる | **部分採用** | state ファイルを一時ファイル + rename でアトミック書き込みに変更。PID 再利用ガード（C-2 と共通）で弱い判定をある程度補強。CDP 接続でのアイデンティティ検証（nonce ハンドシェイク等）までは今回踏み込まず、残存リスクとして明記 |
| C-5 | Medium | `stopDaemon` が kill 失敗・5 秒後も生存でも state を消して `ok:true` を返し、Chrome を孤児化しうる | **採用** | kill 後に実際に死んだか確認し、死んでいなければ state を残したまま `ok:false` を返す（fail closed）。呼び出し側は原因を人間に報告する |
| C-6 | Medium | `attach()` が `connectOverCDP` の `Browser` を保持せず、`close()` で正しく disconnect していない。trace 開始失敗を無条件に握り潰す | **採用** | `Browser` オブジェクトを `BrowserSession` に保持し、detach 時に `browser.close()`（CDP 接続の disconnect であり、daemon 本体は終了しない — Playwright ドキュメント準拠）を呼ぶ。trace 開始失敗はログに残す（握り潰しはそのまま維持するが警告ログを追加） |

## 採用しなかった／範囲を絞った指摘

- C-1・C-4 の完全な認証チャネル化は、単一ユーザー専用 PC という前提の下でのコスト対効果を考え、今回は見送り。残存リスクとして DECISION-LOG A-103 に明記する

## 修正後の検証

- `npm run typecheck` / `npm run lint` / `npm run build`: OK
- `npm test`: **140 passed**（回帰なし）
- Live: `daemon stop`→`daemon start`（ランダムポート割当を確認）→`doctor` を 3 回連続実行して daemon の pid/port が変化しないこと（＝ `Browser.close()` が daemon 本体を落とさず disconnect のみであること）を確認。`run`（本番経路）が daemon 経由で完走することを再確認（`daemon-test-2`）。`daemon stop` が実プロセス終了を待ってから成功を報告し、`daemon status` が `not running` に戻ることを確認

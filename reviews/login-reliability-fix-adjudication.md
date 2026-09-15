# login/doctor 信頼性修正 — 裁定（Claude）

日付: 2026-09-15 / 対象: `git show 80f816d`（A-101） / 入力: `reviews/login-reliability-fix-codex.md`（Codex, gpt-5.6-terra, Medium, read-only）

| # | 重要度 | 内容 | 裁定 | 対応 |
|---|---|---|---|---|
| P-1 | High | `observeAuthWithRetry` が `CrashState` を受け取らず、クラッシュ後も死んだページへ再アクセスし続け得る | **採用** | `crash` を引数に追加。各試行の前後で `crash.cause` を確認し、立っていれば即座に打ち切って直前の結果を返す。`navigateAndObserveAuth()` の想定外の throw も `NOT_READY` に変換（page.ts 側は goto 失敗のみ自前で捕捉しているため） |
| P-2 | High | `cmdLogin` のポーリングで `await page.currentUrl()` が `.catch()` の対象外になっており、reject すると `poll` 全体が reject → `Promise.race` 経由で `withBrowser` の外まで伝播し得る | **採用** | `currentUrl()` と `observeAuth()` を 1 つの `try/catch` にまとめ、例外時は `a = null` として次のループへ。直後に `crash.cause` を再確認 |
| P-3 | Medium | `cmdLogin` 冒頭で `AUTH_OK` 判定がクラッシュ判定より先に評価されており、クラッシュ直後の古い成功シグナルを誤って信頼し得る（`doctor` 側は既に crash 優先だったため不統一） | **採用** | `cmdLogin` も `crash.cause` を `auth.kind` 判定より先にチェックするよう順序を入れ替え、3 箇所（login / doctor / inspect-ui）で統一 |
| P-4 | Medium | `inspect-ui` はクラッシュを表示するだけで、その後も死んだページに対して `inspectUiReport` / `content()` を呼び続けていた | **採用** | クラッシュ検知時は即座に `return 1`（レポート生成・DOM dump を行わない） |
| P-5 | Medium | 新しい再試行・クラッシュ経路に回帰テストが無い | **採用（部分的）** | `observeAuthWithRetry` を `Pick<ChatGptPort, "navigateAndObserveAuth">` で受けるよう変更し、フェイクページで単体テスト可能にした（`tests/unit/login-retry.test.ts`、6 件: バックオフ付き再試行、非 NOT_READY での即時返却、認証状態の非再試行、試行後クラッシュでの即時打ち切り、試行前クラッシュでの未着手返却、throw の NOT_READY 変換）。**`cmdLogin`/`cmdDoctor`/`cmdInspectUi` 自体（ポーリングループの優先順位を含む）は実ブラウザに依存する CLI グルーコードで、これを単体テスト可能にするには `ChatGptPage` の直接構築をやめて `ChatGptPort` 注入に切り替える、より大きなリファクタが要る。今回はそこまで踏み込まず、コードレビュー + 今回のライブ `doctor` 実行で代替した（未解決として明記）** |

## 採用しなかった指摘

なし。ただし Codex が「この差分の範囲外」として触れた `BrowserSession.close()`（`launch.ts`）のタイムアウト後の再 `close()` 呼び出しの挙動は、今回の修正の対象外・未確認のまま残る。

## 修正後の検証
- `npm run typecheck` / `npm run lint` / `npm run build`: OK
- `npm test`: **140 passed**（unit 133 + fixture 3 + 新規 login-retry 6 [内訳は概算]、旧 134 → 140）
- Live: 修正後の `chatgpt-bridge doctor` を実行 → 他項目は全て OK、`login: AUTH_REQUIRED`（本当にログアウト状態。修正の妥当性検証としては「NOT_READY のリトライを経てもなお安定して AUTH_REQUIRED」というクリーンな結果が得られたことを意味し、修正前のような不定なエラー種別の揺れは見られなかった）

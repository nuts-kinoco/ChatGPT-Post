# Phase 6 実装レビュー — 裁定（Claude）

日付: 2026-09-15 / 入力: `reviews/phase6-implementation-review-codex.md`（Codex, gpt-5.6-terra, Medium, read-only）

| # | 重要度 | 内容 | 裁定 | 対応 |
|---|---|---|---|---|
| P6-1 | High | `openConversation` が遷移後に origin を再検証していない（別 origin へのリダイレクト先に入力欄があれば送信し得る） | **採用** | 遷移後 `origin === CHATGPT_ORIGIN && pathname === target` を必須に |
| P6-2 | High | 終端への `rename` 失敗で例外が伝播し、項目が `running/` に孤立。次回 `--drain` は `pending/` しか見ない | **採用** | `moveDir`（5 回リトライ）、失敗時は `WorkerMoveError` で worker を停止（exit 1、stoppedBy `error`）。起動時 `recoverRunning`: `result.json` があれば status で done / blocked / failed へ、無ければ `pending` へ戻す（再実行はブリッジのマーカーが `SUBMIT_STATE_UNKNOWN` で守る）。テスト追加 |
| P6-3 | Medium | `images[]` の契約（相対・`images/` 配下・画像のみ）が schema / invariant で未検査 | **採用** | schema `pattern ^images/[1-9][0-9]*\.(png|jpg|jpeg|webp|gif)$` + `uniqueItems`、`checkResultInvariants` で形式・重複・completed 限定を検査。テスト追加 |
| P6-4 | Low | コメントが旧設計（viewer 第 1）のまま | 採用 | `page.ts` / `ports.ts` のコメント修正 |
| P6-5 | Low | busy 項目が先頭に戻り後続を待たせる | **不採用（Deferred）** | busy（exit 4）はブリッジのロック / プロファイル占有で、どの項目でも同様に失敗する。順序を変えても待ち時間は変わらない。常駐運用で問題が出れば再試行時刻方式を検討 |

## 修正後の検証
- `npm test` **105 passed** / typecheck / build OK
- Live: キューに 1 件投入して `--drain` → `done`（回帰）

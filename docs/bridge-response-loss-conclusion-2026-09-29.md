# 回答の取りこぼし対策: 結論（2026-09-29）

EMAKINOCO-Windows オーケストレータからの相談（BRIDGE_code_loss_discussion_2026-09-29.md と、途中切れ報告 20260929T021238Z-24e4eb66）への回答。コード読解に基づく（live 試験は未実施、bridge は使っていない）。

## 結論（先に）
- **A（抽出の修正＋欠落検知）は必須、かつ「字下げ消失・1 行化」の分は A だけで解決する。** B（ChatGPT 生成ファイルの取得）は今は要らない。
- 途中切れ（20260929T021238Z）は原因未確定。A の欠落検知で「気づける」ようにするのが先で、原因究明は証拠の保存（後述 A5）が前提。
- プロンプト側（C）は今日から使える安価な独立検証として併用する。**行数・チェックサム表**は有効。「.md/.txt 添付で返させる」は B が前提なので今は使えない。
- 運用 D（コードは Sol に書かせる）は引き続き最も安全。

## 原因（コード上で確認できたもの）
1. **dom 変換の検証が構造を見ない。** `src/extraction/verify.ts` の `verifyCandidate` は「単語の袋」の一致率（0.85 以上）で判定し、空白・改行・字下げ・Markdown 記号は無視する。字下げが消えても、1 行に潰れても、`\_` とエスケープされても合格する。
2. **dom は常に quality "full"。** `page.ts` の `extractLatest` は dom 変換が検証を通れば無条件に "full"。
3. **検証の基準（innerText）自体が同じ DOM 由来。** DOM 側が欠けている（遅延描画・仮想化で未描画）と、基準も欠けているため、欠落を検出できない。
4. **copy 抽出が失敗した理由が残らない。** copy が null/不合格/例外のとき `opts.log` に出るだけで、result.json にも warnings にも残らない。だから「なぜ copy でなく dom か」が後から分からない。copy クリック後の待ちは固定 300 ms のため、長い回答で書き込みが間に合わず null になる疑いがある（未確認）。
5. **完了・完全性の兆候を見ていない。** 末尾が文の途中／コードフェンス未閉鎖でも警告しない。「続きを生成」ボタン（`continueButton`）の有無だけを見ている。
6. **証拠が残らない。** 長い会話では `seal_trace_failed: trace exceeds 16777216 byte compressed cap` でトレースが保存されず、artifacts も空。途中切れの原因を後から追えない。


## 2026-09-29 pm-quality-tags-0929: blank pane after new-chat send (analysis only)

The submit marker recorded a `local-chatgpt:` temporary `/c/` identifier after `dispatchSubmit` accepted the URL-move signal. That is intentionally enough to avoid a duplicate send, but it is not a durable conversation identity: the sidebar was already showing a spinner while the main pane had no user turn or stop-button evidence. The later result contained the real `/c/<uuid>` URL.

`dispatchSubmit` currently treats any changed ChatGPT `/c/` path as `movedToConversation` and returns `dispatched`; the controller stores that URL in `conversationUrl`, updates the marker, and the state machine starts observation in `WAITING_FOR_RESPONSE` / `STABILIZING`. If the temporary route has an empty pane, the observation cannot establish the normal user-turn, generation, or response evidence and eventually becomes `SUBMIT_STATE_UNKNOWN`. This is a route-resolution/render gap, not evidence that the send was absent.

Safe recovery proposal (not implemented): recognize `local-chatgpt:` route IDs as temporary and preserve the marker as submitted/unknown rather than retrying the send. During the existing read-only observation/recovery path, watch the sidebar for the newly created conversation's durable `/c/<uuid>` link, then navigate/reload to that exact link and resume observation only after route equality is confirmed. Never re-enter or re-dispatch the prompt; if no durable route is found within the existing bounded deadline, retain the marker and report an inconclusive recovery outcome with the temporary URL and human inspection guidance.
## 対策案と工数（目安）
| # | 内容 | 工数 | live 試験 |
|---|---|---|---|
| A1 | dom 変換で `<pre><code>` の textContent をそのままフェンスに入れる（字下げ・改行・`_`/`=` のエスケープ無し） | 小 | 不要（fixture で可） |
| A2 | 検証に構造チェックを追加: コードブロックの行数・字下げの保持、`\_` 等の過剰エスケープ、フェンス閉鎖。失敗時は quality を "degraded" にして warning | 小〜中 | 不要 |
| A3 | copy 失敗の理由を warnings/result.json に残す。書き込み待ちを固定 300 ms から「変化が止まるまで（上限付き）」へ | 小 | 要（長い回答） |
| A4 | 完全性の警告: 末尾が文の途中、フェンス未閉鎖、生成完了直後にテキスト長がまだ増えている場合は "full" を出さず warning | 小 | 一部要 |
| A5 | トレース上限超過時も最小限の診断（最終 DOM のスナップショット・turn 数・最終テキスト長の推移）を保存 | 小〜中 | 不要 |
| B | ChatGPT 生成ファイル（ZIP/patch/txt/md）のダウンロード | 中〜大 | 要（ダウンロード仕様の調査を含む） |

- A1〜A5 の合計はおよそ 1〜2 日規模（試験の待ち時間を除く）。B は A のあとに独立の機能として検討する。
- 画像用に `page.waitForEvent("download")` の実績はあるが、ファイルは img ではなくリンク/ボタンなので別調査が要る。

## 優先順位（追記バグとの比較）
1. **A1・A2・A4**（静かな破損は最悪で、かつ低コスト）
2. **追記バグ（SUBMIT_STATE_UNKNOWN）**: 30 秒の受理判定が長い会話で間に合わない疑いが最有力（別紙: 下記）。実測が要るので lock の調整が必要。
3. A3・A5、その後に B の要否を再評価。

## 追記バグの切り分け結果（9/25・9/28 の SUBMIT_STATE_UNKNOWN）
- 受理判定 `dispatchSubmit` は最大 30 秒、(1) ユーザーターン数が baseline+1 に厳密一致かつ本文一致、(2) 停止ボタン出現、(3) URL 変化（**newChat のときだけ**）のいずれかを待つ。追記は (3) が無効。
- 9/25 の失敗時スクリーンショットは「送信済み・生成中（Thinking、停止ボタンあり）」。実際は送れているので、検知の遅れによる誤判定（偽陰性）。
- 共通点は「直前の会話が長い回答 1 つ」と、STOP_TRACE の 16 MB 超過警告（＝ページが巨大）。長いスレッドで DOM 更新や描画が重く、30 秒以内に (1)(2) が観測できていない疑い。原因はまだ実測していない。
- 次の実測案（lock 調整後）: 長い回答 1 つの会話に対し、受理判定のポーリング中の userTurn 数・停止ボタン有無・経過時間を記録するだけの診断実行（送信は 1 回、newChat:false）。

## 途中切れ（20260929T021238Z-24e4eb66）についての現時点の見立て
- response.md は 9930 バイトで文の途中で終わり、status=completed / "full"。result.json に error なし、トレース・artifacts なし。
- 考えられる原因（未確定）: (a) 生成完了の判定が早い、(b) ChatGPT 側が途中で止まった、(c) DOM 上で後半が未描画（仮想化）。A4（完全性警告）と A5（診断保存）が入れば次回以降は切り分けられる。

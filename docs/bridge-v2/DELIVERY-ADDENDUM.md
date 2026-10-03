# Bridge v2 通常の ChatGPT Chat を残す配送設計

調査日 2026年10月3日

## 結論

**通常の ChatGPT Chat を維持する第一候補は、GitHub 共通置場と、GitHub の対応イベントで既存 Chat 内の処理を動かす仕組みを組み合わせること。** Work/dot の MCP Events を通常 Chat の機能と言い換えない。

公式資料には、Chat での task 作成、対象 plan の web/mobile における GitHub PR イベント起動、既存 chat の context を使う実行が説明されている。一方、任意の file push だけで指定 Chat を起こし、回答を回収する一往復は、本環境ではまだ確認していない。[Scheduled tasks](https://learn.chatgpt.com/docs/automations)

推奨は **任意 LLM → GitHub の共通 inbox → 対応 PR イベント → 通常 Chat → 許可済みの結果書戻し → 共通 outbox → 元の LLM** という構成を小さく実証すること。CLI route も同じ共通置場へ接続して残す。API への全面移行や、役に立っている通常 Chat の廃止を先に決める必要はない。

これは設計の追補である。配布済み6ファイルは変更していない。今回、購読作成、権限追加、認証、Windows 操作、モデルや CLI の実行は行っていない。

## 1 読めること 起こせること 回答を戻せることを分ける

| 対象 | 公式資料で確認できた範囲 | 今回まだ確認していない範囲 |
| --- | --- | --- |
| 通常 Chat の plugin | Chat/Work で利用でき、接続先の対応能力と権限に応じて読取り・操作が可能 | 対象の通常 Chat で、予定する GitHub 読取りと書戻しが使えるか |
| 通常 Chat の app event task | 対象 plan の web/mobile。GitHub は PR 活動が対象。既存 chat を使う設定も説明されている | この account と対象 Chat での作成、到着先、実際に使う model、結果回収 |
| 独自 MCP Events | Work chat の web、desktop Cloud、dots に対応 | 通常 Chat で同じ機能が使えるという根拠はない |
| GitHub の一般 webhook | GitHub 自体は push 等を提供 | 現接続の ChatGPT GitHub event が任意 file push に対応するか |

出典: [Plugin controls](https://learn.chatgpt.com/docs/enterprise/apps-and-connectors) / [App event tasks](https://learn.chatgpt.com/docs/automations#trigger-tasks-from-app-events) / [MCP Events](https://developers.openai.com/plugins/build/mcp-events) / [GitHub webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#push)

現在 GitHub が event source の候補にあることは確認されている。ただし、通常 Chat の実行環境でも同じ接続と必要な権限が使えるとは推定しない。書込みが可能か、無人実行で許可されるかも別々に確認する。今回、event 定義の実環境 discovery や購読作成は行っていない。

## 2 通常 Chat 向けの具体案

以下は設計提案であり、完成済みの操作手順ではない。

1. **原本を共通化する** — 許可済み送信元が GitHub inbox へ TaskSpec、MD、hash、固定 revision を保存する。Claude、Codex、その他の LLM で入口を変えない
2. **対応する通知に変換する** — 専用 PR の comment または commit 更新を、依頼到着を知らせる手段として使う候補を検証する。任意 file push がそのまま trigger になるとは扱わない。本文は request ID/hash/revision と通知方向に絞る
3. **目的の通常 Chat で受ける** — 対象 repo/PR に限定した event task を、その Chat の context を使う設定で作れるか確認する。別の standalone chat や Work に到着した場合は、今回の要件を満たしたことにしない
4. **原本を取得する** — Chat は接続ツールで固定 revision の依頼を読み、hash と現在の台帳を確認する。通知文や PR 作者の名前だけを実行承認にしない
5. **結果を書き戻す** — Chat から許可済みの GitHub 操作、または専用の結果受付ツールへ構造化結果を渡す。server 側で検査して outbox と台帳に保存する。通常の成功条件を DOM の回答抽出に依存させない
6. **元の LLM が回収する** — 元の送信者は結果 ID/hash を取得・検証して resultACK を返す。Chat には要約と参照を残し、外部側の機械処理には構造化結果を使う

PR は通知の入口であって承認 record ではない。専用 repo/branch/PR の選択と、その範囲の継続読取り・結果書戻しには明示的な設定と承認が必要である。

### 自分の結果で起動し続けないようにする

inbox の通知と outbox の保存を異なる ref/経路に分ける案を優先する。出力の書込みで同じ PR event が発生する構成では、request/result/ack の方向と既処理 ID を検査し、新しい依頼がなければ何も書き込まず終了する。event がまとめられても、最新の1件だけでなく対象となる未処理 request 全件を台帳で照合する。誰かの comment の自然言語を命令として無条件に採用しない。

## 3 ブラウザはどこまで残すか

既存ブラウザから通常 Chat へ request ID/hash/revision だけを送る方式は、移行中の予備 route として残せる。大きな本文や添付を毎回画面経由で送らずに済むため、取り違えや再送の負担は減らせる。

ただし、**短い通知にしても ChatGPT の browser 認証や Cloudflare の停止原因はなくならない。** UI を通る以上、完全な無人運転を約束しない。未確認の非公開 API や認証回避を設計の前提にしない。

`blocked_auth` になった browser route だけを保留し、依頼を共通 queue に残す。独立した認証済み CLI route は継続できるようにする。ただし、同じ repo lock、依存 job、実行状態 unknown の対象には既存の停止条件を適用する。無断で別 model・別 chat・別請求先へ切り替えない。

## 4 代替経路は別物として比較する

| 経路 | 位置づけと注意 |
| --- | --- |
| 通常 Chat の GitHub app event task | 本件の第一検証候補。対応イベントと既存 Chat への到着、結果書戻しの3点を実証する |
| Work/dot の独自 MCP Events | 将来、利用者が別 surface を選ぶなら有力。通常 Chat の代用品として勝手に置き換えない |
| 通常の Responses API | 独立 adapter。background/完了 webhook の設計が可能だが、既存 Chat の context とは別で、通常 API の料金は別管理 |
| ChatGPT plan usage の認可済み headless | 適格な OSS/locally hosted app 向け候補。契約枠を使える場合があるが、既存 Chat 会話へのアクセスは付与されない |
| Workspace Agents API | 公開された workspace agent を外部起動する別機能。response 本文を API で取得できないため、書戻しの検証は必要 |

出典: [Background mode](https://developers.openai.com/api/docs/guides/background) / [API webhooks](https://developers.openai.com/api/docs/guides/webhooks) / [請求管理](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform) / [ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source) / [Workspace Agent triggers](https://developers.openai.com/workspace-agents/trigger-runs)

契約枠の headless 経路も無料・無制限とは言わない。現 preview では stream が必要で、background や persistent conversation 等に制限がある。自前の context と途切れた結果の管理が必要であり、通常 Chat を維持する解決策とは分ける。[Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

## 5 最小検証の順番と合格条件

### A 通常 Chat の手動1往復を確認する

目的の Chat で、固定 revision の依頼を plugin から読み、許可した結果だけを outbox へ戻せるか確認する。まずデータの往復と利用 model を確認し、event を先に大量設定しない。

### B 同じ Chat の対応イベントで1往復を確認する

作成を明示的に依頼された段階で、実接続の event 定義・対象 plan・権限を確認し、専用 repo/PR の最小範囲で1件を試す。通常 Chat への到着、原本取得、結果書戻し、resultACK が揃ったことを合格条件にする。event の HTTP 受信や task の開始だけでは合格にしない。

### C 障害時にも手操作を増やさないことを確認する

重複、順序逆転、通知不足、認証失敗、権限取消、停止指示、複数 job の到着を確認する。ACK が不足したら、同じ ID/hash/run の台帳を照会して配送だけを再試行する。job を自動再実行しない。無人化の対象範囲と回数・時間・費用上限を固定する。

この3段階が通るまで、現行 browser route を廃止せず、通常 Chat の完全自動往復が可能とも断定しない。GitHub の対応 event が合わなければ、保存だけを共通化して通知は保留し、利用者の判断なしに別 surface へ移さない。

## 6 配布済み v2 との接続

既存の issued、receiptACK、startReceipt、terminalResult、resultACK と、request ID/TaskSpec hash/run ID の対応を維持する。「通知された」「実行された」「依頼者が受理した」「merge した」を分ける。

配布済み Result schema は、開始済み実行の終端に実 process identity を要求する。hosted Chat が PID 等を公開しない場合、架空の値で適合させてはならない。最初は Chat への通知・読取り・結果書戻しを独立した配送能力として検証し、必要な hosted-response 証拠は別版の adapter 契約としてレビューする。

**現時点の判断:** 通常 Chat を残した公式機能ベースの候補はある。まだ足りないのは、目的の Chat・model・権限でのイベント起動と結果書戻しをつないだ実証である。GitHub に置けること、event source が存在すること、Work/dot で使えることだけで、この要件が解決したとはしない。

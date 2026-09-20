# 23. durable job 基盤への段階移行計画(フェーズ分離)

- 起点: `reviews/chatgpt-pro-redesign-review.md`(ChatGPT Pro、2026-09-18、独立シニアアーキテクトとしての再設計レビュー。補助検証込み)
- 併読: `reviews/chatgpt-pro-self-review.md`(ChatGPT Pro、fail-closedの一貫性レビュー、独立general-purpose agentによる実コード照合済み)
- 対象読者: 各フェーズを実装する別セッションの Codex(`gpt-5.6-terra`、以下「Terra」)
- この文書自体はDECISION-LOG A-115として記録する

## Terraセッションへの進め方(必読)

1. **1フェーズ1セッション**を原則とする。先のフェーズを終える前に後のフェーズへ手を出さない。
2. 着手前に必ず読む: この文書の該当フェーズの節、`reviews/chatgpt-pro-redesign-review.md`の該当節(§番号を各タスクに記載)、`reviews/chatgpt-pro-self-review.md`の該当項目(#番号)、`docs/10-ARCHITECTURE.md`・`docs/11-STATE-MACHINE.md`・`docs/13-ERROR-MODEL.md`。
3. **既存のstate名・型名・`requestId`/`conversationUrl`/`project`/`profileId`等の既存名称を無意味に変更しない**(両レビューの共通の強い指摘)。名前を変えるならDECISION-LOGに理由を書く。
4. 実装後は独立レビュー(Codex/AGY等、本人以外)を経てからmainへ入れる。このプロジェクトの既存の慣習(`git show`/`git diff`で差分を直接読む、自己申告のテスト結果を鵜呑みにしない、ライブ再現スクリプトで直す前に壊れることを証明する)に従う。
5. 各タスクにはfake ports/純関数レベルのユニットテストに加え、**実際の`fileContracts()`・実schema・実一時ディレクトリを使う契約統合テスト**を必ず含める(再設計レビュー§10.2で名指しされた、A-112を見逃した原因への対策)。
6. 修正が終わったらDECISION-LOGに新しいA-番号で追記し、影響docs(10/11/13/17等)の同期も同じコミットで行う。
7. `--no-verify`等のフック無効化、`git push --force`は行わない。

---

## Phase 0: 既存の危険窓を縮小する(durable化の土台を作る前に、今の穴を塞ぐ)

再設計レビュー§9.1のPhase 0の範囲に、fail-closedレビューで確認済みの13件の穴を統合したもの。durable化(Phase 1以降)より前に必ず終える。項目は独立に着手・レビューしてよい(依存関係が明記されているものを除く)。

### 0-A. [最優先・実証済み] 会話束縛の検証がなく、別チャットの回答を誤って完了扱いできる

- 出典: 再設計レビュー §3.1・§6.2(フェイクポートでの補助検証により**実際にCOMPLETEDまで進み、result.schema.jsonの検証も通過**することを確認済み)
- 対象: `src/state/controller.ts`(observeLoop相当)、`src/chatgpt/page.ts`(`extractLatest()`等)
- 問題: 現在のURLがChatGPT会話形式であれば`conversationUrl`を無条件で上書きし、完了判定はassistant件数としか照合しない。依頼IDや対応するuserターンを検証しない
- 修正方針: 送信直後に確定した「期待する会話」を不変として保持し、以後の観測URLは別フィールド(観測値)として扱う。回収直前に期待する会話・userターン・対象assistantターンの対応を検証し、証明できなければ`COMPLETED`へ進めない(fail-closed)。再設計レビュー§6.2の「送信前/送信後/回収時」の三段階照合を参照
- 受け入れ条件: 会話Aへ送信中にPageが同じturn数の会話Bへ遷移するケースを契約統合テストで再現し、Bの回答がAのcompletedとして保存されないことを確認する

### 0-B. 所有権・ロック・プロセス生存性の統一(再設計レビュー§3.2, §3.6, §3.7 / self-review #5, #6, #7, #8, #11)

- **0-B-1**: `recoverRunning()`(`src/cli/worker.ts`)が所有者確認なしに`running/`を`pending`へ戻す。同時起動した別workerの処理中jobを誤って回収しうることを補助検証で再現済み(再設計レビュー§3.2)。最低限queue単一管理者を運用で保証しつつ、所有者トークン記録を追加する
- **0-B-2**: `getOrCreateProfileId()`(`src/browser/daemon.ts`)が既存ID読み取り・新規作成のいずれにも失敗した場合、非永続なランダムIDを返す(fail-open)。同一プロファイルへの連続呼び出しで異なるIDが返ることを補助検証で再現済み(再設計レビュー§3.7)。全て失敗したらプロファイル利用自体を停止する
- **0-B-3**: `src/state/lock.ts`のstale lock recoveryが、判定時と異なるlockだった場合の`rename(stalePath, this.path)`による復元で、その間に別プロセスが取得した正当な新lockを無条件上書きしうる(self-review #7)。rename前にdestinationの存在・内容を再確認するか、atomic compare-and-replaceへ
- **0-B-4**: daemon keepalive(`src/browser/daemon-worker.ts` `keepAliveTick`)がlock取得でなく`isLockHeld()`の存在確認のみで行動し、TOCTOU競合がある(コード自身のコメントも認めている, self-review #6)。keepaliveも同じlock protocolの参加者にする
- **0-B-5**: `BrowserSession.close()`(`src/browser/launch.ts`)がtimeout後の2回目`ctx.close()`を無期限で待ち、「bounded close, then kill」というコメントと実装が一致しない。`ctx.tracing.stop()`も無期限(self-review #8)。2回目もboundedにし、超過時はdetach/prosess-killへ
- **0-B-6**: macOSで`processStartedAt()`が常にnullを返し、`verifyOwnedProcess()`がPID生存のみで所有daemonと判定する。PID再利用を排除できない(self-review #11)。「生存確認」と「kill可の所有権証明」を分離する

### 0-C. fail-closed検知の精度(self-review #1, #2, #10, #14, #15)

- **0-C-1**: `continueButton`/`sidePanel`/`challengeFrame`のselector候補に`verifiedOn`が無く、既定の`verifiedOnly=true`では常に「無し」判定になる(`src/chatgpt/selectors.ts`)。実画面で検証してverifiedOnを付与するか、`present/absent/unknown`の3値化を行う
- **0-C-2**: `selectors.ts`の`resolve()`/`probe()`が`countVisible()===1`を確認していながら、返すのは`loc.first()`(DOM順先頭)であり、可視要素と不一致になりうる。可視要素そのものを探索して返す
- **0-C-3**: `page.ts`の画像fetchで`AbortSignal`がpage内`fetch()`に渡っておらず、ハング時にabortできない。signalをpage.evaluateへ渡すか、evaluate自体をwithTimeoutでboundする
- **0-C-4**: `src/contracts/attachments.ts`のsecret scanが2MiB超かつ非テキスト拡張子のファイルを内容検査せずに通す。スキャン不能ファイルを拒否するか、保証範囲をドキュメントで明示する
- **0-C-5**: `src/browser/trace-sanitizer.ts`が未知entry typeをそのまま通す(blocklist方式)。allowlist化する

### 0-D. 入出力の忠実性(self-review #3, #4)

- **0-D-1**: `normalisePrompt()`(`src/chatgpt/page.ts`)が全空白を除去し、`print("a b")`と`print("ab")`、インデント違いのコードを同一視する。CRLF/NBSP正規化に限定し、文字列内空白・インデントは保持する
- **0-D-2**: `src/extraction/verify.ts`のcoverage判定(記号除去・小文字化・順序無視・85%閾値)が緩く、演算子変更(`!=`→`==`)やインデント変更、末尾15%欠落でも`quality: "full"`を通す。コードブロックは改行・インデント・演算子・文字列・token順序を保持した比較にし、曖昧な場合は`degraded`へ落とす

### 0-E. 結果確定の網羅性(再設計レビュー§3.5)

- 正常完了経路(`WRITING_RESULT`、非terminal状態)での`writeResult`失敗はA-113/A-114のemergency fallbackを通らない(`controller.ts`の`WRITE_RESULT`効果ハンドラの`if (!this.state.terminal) return {type:"WRITE_FAILED",...}`分岐)。補助検証で、書込試行1回・`RunOutcome.result`がnullのまま終わることを確認済み。fallbackを増やす対症療法ではなく、「MDは存在するが結果確定だけ失敗した状態を次回起動時に正しく確定できる」経路を設計する(Phase 1のjob管理層と合わせて設計してよいが、最低限「正常完了時にresult.json書込が失敗したら何も分からず終わる」状態は0の時点で解消する)

### 0-F. queueの結果分類(self-review #13)

- `src/cli/worker.ts`のexit code→キュー移動先マッピングが、exit 4の複数の異なる原因(`ALREADY_PROCESSED`/`ALREADY_RUNNING`/`PROFILE_IN_USE`/`BROWSER_LAUNCH_FAILED`)を一括りにする。また`GENERATION_TIMEOUT_ACTIVE`(exit 1)はエラーメッセージ自身が「同じプロファイルへ即座に再送するな」と警告しているのに、workerは通常failedとして次jobへ進む。構造化結果(`errorCode`別の分類)へ

---

## Phase 1: 単一マシン・並列数1のdurable化

出典: 再設計レビュー §4, §5, §7, §9.1(Phase 1)。**Phase 0完了が前提**。

範囲: 入力スナップショット(受付時にprompt・添付を管理領域へ固定)、軽量DB(SQLite)によるジョブ受付・status/result取得、CLIの寿命とChatGPT上のジョブ寿命の分離(`timeoutMs`をCLI待機時間として無告知で流用しない)、生成完了後の本文即時退避(画像処理を待たせない)、成果物commit手順(§7.4のクラッシュ位置別復旧表に従う)。

次へ進む条件: CLI切断・長時間生成・管理サービス再起動後に同じrequestIdで結果を再送なしに取得できること。

**実装状況(A-132/A-133)**: MVP版として`submit`/`status`/`wait`/`result`コマンドを追加済み(既存`run`は無変更)。`node:sqlite`（Node 22.13+）でjob台帳(`runtime/jobs.db`)を実装。**制約**: `runtime/`がSMB等の共有ドライブ上にある場合、WAL modeが正しく動作しない可能性がある(A-108参照)。`CHATGPT_BRIDGE_RUNTIME_DIR`を各ホストローカルに設定すること(実行時の自動検知は未実装)。daemon側での観測引き継ぎ(CLIタイムアウト後もdaemonが監視を継続する部分)は未実装のまま — 現状は「submitしたCLI自身の寿命からは独立するが、生成の実際の監視・タイムアウト判定は引き続き検出された`run`子プロセス自身が行う」に留まる。

## Phase 2: 送信後の回復

出典: §5.3, §6.4。読み取り専用のrecovery経路(`openConversation()`の送信用厳格条件をそのまま復旧に流用しない)、会話・ターンの永続束縛、marker/manifest/DB照合。

次へ進む条件: 各送信・保存境界で落としても、再送せず回復するか明確にblockedとして保留できること。

**実装状況(A-134/A-135)**: MVP範囲を「死んだプロセス・result.json無し」の際の誤分類防止に絞った。既存の`submit.marker`(write-ahead、ADR-005)の**存在の有無だけ**を見て、markerが無ければ`BROWSER_CRASHED`(未送信・再送安全)、markerが在れば(中身のフィールドは問わない)`SUBMIT_STATE_UNKNOWN`(送信済みの可能性、再送禁止)を返す。**未実装のまま残るもの**: 読み取り専用のDOM再接続・観測再開(会話/userターン/assistantターンの束縛照合を含む)は実DOM検証が必要で今回のスコープ外。§6.4のlease/所有権の完全な仕組み(古い担当のUI操作を確実に止める)も未着手。「回収専用の読み取り専用open」も未実装 — 現状は「検知して安全側に倒す(blocked相当)」までで、「実際に回復する」動作はしない
## Phase 3: 同一マシンの並列化

出典: §3.8, §6.1, §6.4。Page割当、複数caller session、会話排他、生成枠/Page枠/browser枠の分離、思考量等アカウント共有設定の排他制御、trace管理。**§3.8で指摘された「思考量の復元が並列時に競合する」問題はここで直接効いてくるため、Phase 0で先送りにした場合はここで必ず対処する**。

次へ進む条件: タブ入替・タブ消失・担当失効が起きても誤配送しないこと。

**実装状況(A-136)**: POの判断で「生成枠 = Page枠」とみなす最小スコープを選択(§6.1が推す生成枠・Page枠・browser枠の3分離は不採用)。着手前にdaemon(`login`でattach)を使ったライブ検証を行い、(1)同一プロファイル内の複数タブでの並行生成は問題なし(2)思考量(effort)設定はタブごとに完全に独立、の2点を実機で確認済み(§3.8が懸念した「並列化で顕在化する共有設定の競合」は解消と判断)。実装: `CHATGPT_BRIDGE_MAX_CONCURRENCY`(既定1、上限8。無効値は1、超過値は8へ警告付きで安全側に丸める)をNに設定すると、`state/slot-lock.ts`が既存`ProcessLock`をそのままN個の独立ロックファイル(`bridge.lock.slot0`..`slot{N-1}`)として再利用する生成枠プールへ切り替わる。`run`(`cli/main.ts cmdRun`)のみが対象で、`login`/`doctor`/`inspect-ui`は常に従来どおり`bridge.lock`単一排他のまま(`adapters.ts buildPorts`の`pooled`引数で分岐)。daemon接続時、プール有効時は`BrowserSession`が`getUsablePage()`(「使えるページを何でも再利用」)ではなく必ず新規タブを開き(`createDedicatedPage`)、detach時に閉じる(`close()`)ため、複数`run`プロセスが同じタブを取り合う競合を構造的に排除。各jobは必ず新規チャットを開く前提のため、会話の使い回し・会話排他制御はスコープ外のまま(§6.1のフル対応はPhase 4以降または追加フェーズへ)。daemonのkeepalive(`daemon-worker.ts`)も、自分のページが死んだ際の復旧を「`context.pages()`から適当な生存ページを拾う」から「常に新規ページを開く」へ変更(並列下では他jobの実行中タブを誤って触るリスクがあったため)。**未実装のまま残るもの**: 生成枠・Page枠・browser枠の分離、会話の同時利用時の排他制御(§6.4のlease/所有権)、daemonなし(フレッシュlaunch)でのプール利用時の安全側フォールバック以上の対応(Windowsの2件目以降はbrowser起動前のプロファイル確認で`PROFILE_IN_USE`。他プラットフォームではbrowser launch failureとなる場合がある)

**A-137(Opus独立レビューと修正)**: A-136初版に対しフェーズの区切りとしてOpusレビューを実施、High 2件・Medium 5件を修正(Low 2件は見送り、詳細はDECISION-LOG参照)。要旨: (1) pooled `run`が`bridge.lock`自体を触らなくなったことで`login`/`doctor`/`inspect-ui`・daemon keepaliveが並行中のpooled生成と排他されなくなっていた穴を、`state/slot-lock.ts`の`acquireAllSlots`(全slot一括取得のbarrier)で塞いだ。daemonの実際のpool sizeは`daemon.json`(`DaemonState.maxConcurrency`)へ`daemon start`時に焼き込まれ、`run`側の設定値と食い違えば`launch()`が拒否する。(2) Playwright tracingがBrowserContext単位(複数pooled jobで共有)なため、dedicated-page(プール)モードでは`context.tracing.start()`自体を呼ばないよう変更(trace無しはresult.json.warningsへ安全に降格)。(3) `doctor`をプール対応(`checkLock`が全slotを走査)。(4) `submitJob()`が既存行`BROWSER_CRASHED`(送信未達が証明済み)限定で同一requestIdの再送を許可(読み取り専用busy pre-checkと実際のlock取得のレースで負けた側が永久にrequestIdを焼き潰す問題への対処)。(5) dedicated pageのdetach時close処理が、`status!=="completed"`の危険な曖昧状態でも証拠のタブを保持するよう変更。実機での並列submit再検証はA-137時点では未実施

## Phase 4: 複数マシンと配送強化

出典: §8, §9.2。中央管理サービス+各マシンagent構成(共有ドライブへのSQLite直接配置は不採用)、端末登録、全体並列枠、ACK(`ACK <id>`程度の軽量ハンドシェイク、LLMに文章生成させない)。

次へ進む条件: 端末間切断・再接続、同一ID同時submit、旧担当復帰を通過すること。

---

## 明示的に不採用と判定された安易な拡張(再設計レビュー「最終判断」)

Terraセッションはこれらを提案・実装しないこと。

- `bridge.lock`を外して既存`run`をそのまま並列起動する
- `GENERATION_TIMEOUT_ACTIVE`のtimeoutをさらに長くするだけで回答喪失対策とする
- `conversationUrl`とrequestId echoを保存するだけで対応関係を証明したとする
- SQLiteを共有ドライブ(SMB等)へ置いて複数マシンから直接操作する

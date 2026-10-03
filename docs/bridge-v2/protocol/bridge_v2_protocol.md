# Bridge v2 実行前承認と結果確認の設計

版 2.0 設計案 2026年10月3日

## 1 この文書で決めること

この設計は、依頼本文の受け渡しと、承認された処理の実行を分離する。TaskSpec は変更しない依頼データ、承認はそれと別の信頼できる記録、Result は実行の証拠を検査した結果とする。メッセージを送信できたこと、応答を回収できたこと、作業が成功したことは別々に判定する。

本書と同梱5ファイルは設計成果物であり、実装、実行指示、環境接続、権限付与ではない。Windows をタスク作成なしで操作する経路は未検証である。エージェントの CLI、引数、起動方法は推測しない。将来の実装では確認済みの adapter を登録し、その能力を試験してから有効化する。

本書の「必須」は実装が満たす条件、「禁止」は実装が拒否する条件を表す。不明な条件を許可へ読み替えてはならない。能力不足、検証不能、信頼元不明の場合は開始せず、明確な拒否または `unknown` として扱う。

### 成果物

| ファイル | 役割 |
| --- | --- |
| `bridge_v2_protocol.md` | 承認、状態遷移、分離、配送、取消、復旧、受入条件 |
| `task.schema.json` | TaskSpec と分離した承認 envelope の構造 |
| `result.schema.json` | 状態 snapshot、実行記録、最終 receipt の構造 |
| `task_example.md` | 実行を許可しない説明用本文 |
| `task_example.json` | 上の本文をハッシュで束縛する非実行 fixture |
| `result_example.json` | fixture が実行入口で拒否された場合の合成結果 |

例の agent、model、repo、commit、時刻、結果は架空である。本文と JSON の SHA-256 だけは同梱ファイルの実バイトから計算した。実際の承認、処理開始、リポジトリ変更、実行試験の成功を示すものではない。

## 2 既存 ChatGPT-Post との境界

確認対象は `nuts-kinoco/ChatGPT-Post` の main にある commit `611aa90c4f577bedd9f089d6f7a3d4df0d4eab2e`。以下はこの commit の読み取りに基づく。将来の実装時には再確認する。

1. 既存 `request.json` と `result.json` の schema は余分なフィールドを拒否する。v2 TaskSpec や job Result をそこへ追加してはならない。外側の新しい契約、独立した保管領域、明示的な変換境界を用いる。既存 request は 1.0–1.3、result は 1.2/1.3 を扱い、dot の result は `target: dot` を持つ。[request schema](https://github.com/nuts-kinoco/ChatGPT-Post/blob/611aa90c4f577bedd9f089d6f7a3d4df0d4eab2e/schemas/request.schema.json) [result schema](https://github.com/nuts-kinoco/ChatGPT-Post/blob/611aa90c4f577bedd9f089d6f7a3d4df0d4eab2e/schemas/result.schema.json)
2. 外側の `request_id` は本書の job identity とする。外側の配送台帳で、これを独立した `transport_request_id` と対応づける。同じ TaskSpec に複数の配送記録ができても、実行枠は増えない。dot 側の送受信行の prefix、requestId、完了 marker は DOM 上の帰属判定であり、本人確認や実行承認ではない。返答は現在の transport ID に一意に帰属させ、別の requestId 表記を応答本文へ混在させない。[帰属判定](https://github.com/nuts-kinoco/ChatGPT-Post/blob/611aa90c4f577bedd9f089d6f7a3d4df0d4eab2e/src/dot/completion.ts#L29-L154)
3. dot transport は入力添付を受け付けず、読み込む prompt は最大20,000文字。TaskSpec と MD の原本は信頼できる外側の保管域へ保持する。既存 prompt に載せる要約、内容参照、本文の写しは権限にも原本にもならない。安全な原本取得経路がない場合は実行連携を開始しない。[request 契約](https://github.com/nuts-kinoco/ChatGPT-Post/blob/611aa90c4f577bedd9f089d6f7a3d4df0d4eab2e/src/contracts/request.ts#L8-L111)
4. 既存 result の `completed` は輸送・応答抽出の完了を表す。ファイル回収の失敗が warning にとどまる場合もあり、ファイル名・path・bytes は v2 の checksum、schema、receipt の検証を代替しない。既存の response、result、collect-result は保存したまま、v2 の検証結果を別の名前空間へ記録する。[回収と出力](https://github.com/nuts-kinoco/ChatGPT-Post/blob/611aa90c4f577bedd9f089d6f7a3d4df0d4eab2e/src/dot/controller.ts#L265-L283) [ファイル回収](https://github.com/nuts-kinoco/ChatGPT-Post/blob/611aa90c4f577bedd9f089d6f7a3d4df0d4eab2e/src/dot/controller.ts#L358-L397) [collect](https://github.com/nuts-kinoco/ChatGPT-Post/blob/611aa90c4f577bedd9f089d6f7a3d4df0d4eab2e/src/cli/collect.ts#L336-L443)
5. 既存の送信 marker はクリック前に記録される。存在だけで未送信とは言えず、`submitted=yes` も自分の UI 行の観測であって実行証拠ではない。既存 durable submit の選択項目に対する SHA-1 は輸送重複の判定用であり、TaskSpec の SHA-256 や承認 binding に流用してはならない。[marker の扱い](https://github.com/nuts-kinoco/ChatGPT-Post/blob/611aa90c4f577bedd9f089d6f7a3d4df0d4eab2e/src/dot/controller.ts#L184-L243) [marker record](https://github.com/nuts-kinoco/ChatGPT-Post/blob/611aa90c4f577bedd9f089d6f7a3d4df0d4eab2e/src/state/marker.ts#L19-L45) [既存 hash](https://github.com/nuts-kinoco/ChatGPT-Post/blob/611aa90c4f577bedd9f089d6f7a3d4df0d4eab2e/src/cli/submit.ts#L58-L88)

この節は連携設計の制約であり、既存コードに v2 機能が備わっているという主張ではない。

### 共通 inbox と outbox と接続先の分離

共通の GitHub inbox/outbox は候補の保管・配送 adapter として扱い、既存 ChatGPT browser chat、Claude CLI、Codex CLI などの宛先は registry で選ぶ設計とする。これらは候補 profile の名称であり、既に接続済み、実行済み、無認証で利用できるという意味ではない。既存 browser chat route を置換せず、配送 adapter と実行 adapter の interface と能力を分離する。

TaskSpec に自由な route や CLI 引数を追加しない。`agent` と不変 `policy_snapshot_sha256` が、許可された実行 profile、配送先、必要な能力を解決する。別宛先への変更は agent または snapshot と T の変更であり、古い grant を使い回さない。接続先の schema/identity/capability に適合しない job は、その route だけを開始不能にする。

GitHub へファイルを置けることは、同じ会話へ通知を push できることや、待機中の agent を起こせることを証明しない。任意の file push から既存 chat を再開する event 経路は未確立として扱う。認証済みイベント source、受信 handler、dedupe、Result 検証、ack のすべてを別途設定・検証しなければならない。inbox/outbox は改ざん可能な入力/出力の候補置場であり、Git commit、PR、branch 名だけを approval や実行 receipt として信頼しない。保管先に credentials を書き込まない。

GitHub の配送 metadata と原本は一つの検証可能な tree revision にまとめ、競合する更新は ref/revision の compare-and-swap で拒否する。これを承認消費・process 起動・repo lock 全体の transaction と混同しない。第7節の永続台帳、fencing、unknown の扱いは別途必要である。

adapter 自身の接続状態には `ready`、`blocked_auth`、`unavailable` などを持たせ、job の9状態とは別に管理する。browser の sign-in/CAPTCHA/認証切れで blocked_auth になっても、独立した認証済み CLI route、別 session、競合しない repo lock まで停止しない。ただし、その route の既存 job が実際に開始したか不明なら、その job/session は unknown として保留する。承認なしの別宛先 fallback は行わない。

運用の既存接続や Cloudflare 等を撤去したという主張はしない。接続先ごとの認証と料金条件を確認する。ChatGPT と API platform の請求は別管理であり、ChatGPT の契約から API 利用分の支払い済みを推定してはならない。[OpenAI の請求管理説明](https://help.openai.com/en/articles/9039756-managing-billing-settings-on-chatgpt-web-and-platform)

## 3 役割と信頼境界

- 依頼者は TaskSpec と MD を提出する。MD、JSON 内の説明文、リポジトリ内の指示は、すべて未信頼の作業データとして扱う
- 承認者は、表示した原本の bytes、対象 repo・agent・model、許可範囲、期限を確認して、認証済みの承認サービスへ決定を記録する
- 承認サービスは TaskSpec を書き換えず、不変の分離記録と取消履歴を保持する。信頼できる認証・認可、改ざん検出、監査、時刻管理がない場合、承認サービスとして使ってはならない
- dispatcher は承認を照合し、永続台帳に開始枠を確保する。自由文、メッセージの送信者名、ファイル名、`approval_id` 単独を承認として扱ってはならない
- executor は登録済み adapter と隔離環境だけで処理し、すべての file access・command・子プロセスを強制境界に通す
- verifier は executor の自己申告をそのまま信頼せず、台帳、プロセス、成果物、差分、commit、承認との一致を確認する

repo、agent、model、executable、evaluator は、受信データが指定する任意 URL や実行パスではなく、管理者が許可した registry の ID である。registry の解決結果、adapter version、実行 binary hash、隔離能力、環境変数、許可済み control-plane 接続先、repo の実体をまとめた不変 snapshot を `policy_snapshot_sha256` で束縛する。設定を変更したら snapshot が変わり、TaskSpec と承認を作り直す。

## 4 TaskSpec の固定と生バイトの hash

### 受理する表現

TaskSpec は UTF-8、BOM なしの JSON object。重複 key、不正 UTF-8、末尾の別 JSON、過大な本文、未知フィールドを拒否する。UTF-8 として正しい JSON でも、escape を解いた key/value の全文字列に対をなさない surrogate code point があれば拒否する。置換文字への変換や正規化で補修せず、argv hash も整形式の Unicode scalar 文字列だけを入力にする。TaskSpec は最大256 KiB、MD は最大1 MiB。JSON 数値は schema の範囲内に限る。整数は最大9007199254740991とし、より小さい上限がある項目はその上限を使う。丸めて別の counter/revision に変換してはならない。JSON Schema へ渡す前の byte/parse 段階でもこの検査を行う。

原本の JSON を `T`、MD ファイルを `M` とする。

- `H_T = SHA-256(T のすべての生バイト)`
- `H_M = SHA-256(M のすべての生バイト)`
- `TaskSpec.task_file_hash = H_M`
- 分離承認の `task_spec_sha256 = H_T`

改行、字下げ、key 順序、末尾改行、空白、Unicode 表現の違いも byte の変更である。parse→再serialize、改行変換、Unicode 正規化をした結果で hash を取り直して「同じ承認」とみなしてはならない。保存した T と M から parse し、その同じ保存 bytes を実行前にも再検証する。実行系が別の JSON を組み立て直して渡す設計は禁止する。

`task_file` は一緒に封印する本文 blob の相対名であり、作業 repo から可変ファイルを読み直す場所ではない。MD も UTF-8、BOM なし。不正な表現は hash 検査以前に拒否する。内容の読み替えや添付の取り違えを防ぐため、原本、byte length、hash、schema version を一体で保管する。

同じ `request_id` と同じ H_T・H_M の再配送は既存状態の照会である。同じ ID で異なる bytes、本文または hash を届けた場合は `request_conflict` で拒否する。既存原本、承認、結果を上書きしない。変更版には新しい `request_id` と再承認が必要である。

### 必須フィールド

| 項目 | 意味と実行前検査 |
| --- | --- |
| `request_id` | 小文字 UUID。台帳で一意な依頼 identity |
| `agent`, `requested_model` | snapshot に存在する完全一致 ID。別 agent/model への自動 fallback 禁止 |
| `repo`, `base_commit` | 登録 repo と正確な40/64桁 object ID。ref 名や branch 名のその時点の解決で代替しない |
| `mode` | `design_fixture`、`read_only`、`edit`。fixture は常に起動禁止 |
| `policy_snapshot_sha256` | 実行条件を固定する registry snapshot の SHA-256 |
| `allowed_paths` | 相対 path、exact/subtree、read/write の有限集合。空は何も許可しない |
| `allowed_commands` | binary ID/hash、完全一致 argv、cwd、回数上限、受理できる exit code の有限集合 |
| `task_file`, `task_file_hash` | 不変本文 blob の名前と SHA-256 |
| `approval` | manual/automatic/bypass の UI 方針、事前承認 policy の固定参照、hash binding、寿命、開始数 |
| `timeout` | 実行時間上限と停止猶予。秒数は固定 |
| `success_criteria` | criterion ID、説明、登録済み evaluator ID。説明文は権限を拡張しない |
| `task_network`, `environment` | 作業側 network は deny、任意の環境変数はなし |
| `retry_policy` | `no-automatic-reexecution`。通信再試行と処理の再実行を分離 |

実行モードではゼロだけの commit/snapshot hash を拒否する。repo が object を保有し、対象 commit の完全な内容を確認できることが必要。隔離 worktree はその commit から新規に作り、利用者の作業中の tree、dirty な共有 checkout、未検査 submodule、未追跡の入力、任意 Git hook を引き継がない。read_only は書込みを許可しない。edit でも許可 path の外は書込み禁止である。

## 5 承認の自己参照を避ける

TaskSpec 内の `approval` は、承認を要求する固定の方針である。承認者、承認時刻、grant、署名、`approved: true` を TaskSpec に追記してはならない。追記すると T が変わり、以前の H_T の承認は無効になる。

実際の決定は独立した approval envelope に置く。構造は `task.schema.json#/$defs/approvalEnvelope` に定義する。分離記録には H_T、H_M、policy snapshot、承認者、対象 bridge/executor、発行/有効期限、nonce、decision、開始上限を必須とする。TaskSpec が envelope を内包せず、envelope が自分自身の hash を持たないため、hash の自己参照は起きない。

envelope の JSON を持っているだけでは許可にならない。dispatcher は認証済みの承認サービスで同じ不変記録を照合し、現在の取消状態と消費状態も確認する。外部ファイルを信頼記録へそのまま登録することは禁止。offline の署名だけで承認を受理する手順はこの版では定義しない。承認サービスへ安全に照会できなければ開始しない。

開始条件は次のすべてである。

1. `decision=approved`、`max_starts=1`。認証済みの承認者がこの対象と範囲を承認できる
2. envelope の request ID、H_T、H_M、snapshot、bridge/executor audience が完全一致する
3. 信頼できるサーバー時刻で issued_at ≤ 現在 < expires_at。期限差は TaskSpec の max_age_seconds 以下。未来発行、逆転、時刻不明を拒否する
4. nonce と approval ID が未消費で、承認が取り消されていない。start intent の永続化と消費を同一の直列化可能な transaction で行う
5. TaskSpec の全フィールドと原本 MD を再検証し、registry と隔離能力の事前試験が合格している
6. `mode` が実行可能であり、すべての拒否条件を通過している

承認は一度だけ開始枠を使う許可である。実行中の期限切れだけで実行結果を巻き戻さない。実行を止めるには認証済み取消を台帳に記録する。開始前の取消は grant を失効させ、開始後の取消は後述の停止手順に進む。

### 手動 自動 UI 省略の3段階

wire 上の `approval.tier` は `manual`、`automatic`、`bypass` とする。実装内部で automatic を autoapprove と呼ぶ場合は明示的に対応づける。3段階とも `approval.required=true`、原本 hash、許可リスト、期限、使用量、台帳、receipt、結果検査を省略しない。

| tier | 利用者の操作 | 残る強制条件 |
| --- | --- | --- |
| manual | 依頼ごとに原本を確認して承認する | 完全な通常検査 |
| automatic | 既に明示承認された限定 policy の範囲ならサービスが自動判定する | policy の範囲、版、失効、使用量を検査し、各依頼の分離 grant を生成 |
| bypass | 同じ限定 policy に基づき、依頼ごとの承認画面を省く | automatic と同等の権限検査と各依頼の分離 grant。警告や法定・必須確認は省略しない |

bypass は「権限を無視する」意味ではない。自動承認 policy の有効化・範囲拡大には利用者の明確な承認が必要で、本設計の作成や UI の既定値選択は継続アクセス権を与えない。初期状態では有効な policy、grant、開始許可を一つも作らない。特に credentials、新規の継続アクセス、不可逆削除、機密送信、金融など、上位の安全規則が行為時の確認や本人操作を要求する操作を product policy で免除してはならない。

manual の `preauthorization` は null。automatic/bypass は不変の `policy_id`、`policy_version`、`policy_sha256`、`session_id` を TaskSpec に必須とし、分離 envelope にも同じ参照を入れる。自動承認の `approver_id` は policy により権限を与えられた承認サービスの ID とする。元の人の承認記録は policy 側に保持する。approved envelope は `usage_reservation_id` を持ち、予約された開始数・予算との対応を照合する。

事前承認 policy は認証済みの別 registry に保管し、少なくとも次の machine-readable な限界を持たせる。自由文だけの「いつでも全部許可」は受理しない。

- policy ID、単調増加する版、全 policy bytes の SHA-256、承認者と承認証拠、発行時刻、有効期限、取消状態
- 対象 repo、agent/model の完全一致 ID、read_only/edit の許可 mode、初期 base commit と後続 base の許可規則
- 許可 path、read/write、固定 command/argv/cwd/binary hash、回数、evaluator、1 job の timeout 上限
- 対象 session、最大開始 job 数、session deadline、累積実行時間上限、必要な場合は金額上限・通貨・予約と精算の規則
- 必須の個別確認を要する操作種別、停止責任者、結果配送先、policy/usage の改ざん・競合を防ぐ保存条件

後続 base を許す場合も同一 session の直前の verified resulting commit からの連続性を確認する。別 branch の変化、手動変更、unknown の成果物を自動で取り込まない。計上不能な費用がある場合は有料処理を開始せず、予算不明を無制限へ変換しない。job 数、時間、必要な金額の各上限を独立に守る。

自動承認でも、原本 T/M の変更、policy の変更、session の変更があれば古い grant は失効する。新しい原本の H_T/H_M を計算し直し、固定 policy の現在の有効性・残量・範囲をもう一度評価して、新しい envelope を発行する。以前に似た作業が許可されたことから承認を引き継がない。範囲外は開始を拒否し、必要な手動判断へ戻す。

### 権限を与えない分離記録の例

以下は同梱 fixture に対する架空の拒否記録で、承認サービスに存在せず、実行権限を与えない。decision は denied、max_starts は0である。

```json
{
  "protocol_version": "2.0",
  "approval_id": "00000000-0000-4000-8000-000000000002",
  "request_id": "00000000-0000-4000-8000-000000000001",
  "tier": "manual",
  "preauthorization": null,
  "usage_reservation_id": null,
  "decision": "denied",
  "task_spec_sha256": "3ae9588585512866a92080a9b2d2a1893864a38a9693bb4aa344742b41d2c6fb",
  "task_file_sha256": "31d2cb7854e16ac198c39ca8f0959d43222242b12af2d1e103765098296903b5",
  "policy_snapshot_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "bridge_id": "fixture-bridge",
  "executor_id": "fixture-executor",
  "approver_id": "fixture-reviewer",
  "issued_at": "2026-10-03T00:00:00Z",
  "expires_at": "2026-10-03T00:15:00Z",
  "nonce": "00000000-0000-4000-8000-000000000003",
  "max_starts": 0
}
```

## 6 許可リストを機械的に強制する

許可範囲は「登録 policy ∩ TaskSpec ∩ 承認された原本」の積集合である。空リスト、未知 ID、未知オプション、未知能力は許可にならない。自然言語の「必要なら」「任意に」「全部変更してよい」、repo 内の指示、取得した网页やログを権限源にしてはならない。

### ファイルと repo

- path は schema の保守的な ASCII 相対構文だけを受け付ける。絶対 path、drive、UNC、colon、backslash、`.`/`..` 成分、空成分、末尾の点/空白、glob、NUL を拒否する
- `exact` はその一つの file、`subtree` は解決した directory と境界内の子孫だけ。文字列 prefix の一致だけでは包含を認めない。registry にある repo root の実体 ID と、実際に開いた対象の実体・volume を確認する
- symlink、junction、reparse point、mount などの境界越えと、repo 外へ別名を作る hardlink を拒否する。既存の path だけでなく、新規作成の親、rename 前後、delete 対象も確認する
- case folding、短い別名、device/reserved name、alternate data stream、Unicode alias など OS 固有の名前解決を検査する。構文を通っても同一性に曖昧さがあれば拒否する
- check→open の間に置換できる検査では不十分。handle による解決や同等の OS 強制境界を使い、検査した対象と実際の操作対象の同一性を維持する。安全な file broker、隔離、リンク制限を強制できなければ開始しない
- `.git` 等の管理 metadata、資格情報、home、別 repo、共有 tree へ作業 agent が直接アクセスすることを禁止する。必要な commit/差分作成は明示的に登録した信頼済み broker に限定する。submodule、Git hook、外部 filter、外部 diff driver を自動実行しない

### command と agent

- command は `command_id` に対応する、固定 executable/hash、完全一致 argv 配列、cwd、実行回数の組である。binary basename や command の先頭文字列だけの照合は禁止。binary は PATH 検索、alias、file association で選ばない
- registry が解決した実体 binary を hash で検査して起動し、検査後の差替えも防ぐ。検査不能なら拒否する。agent adapter と evaluator 自身の binary/依存物も snapshot に固定する
- shell を介さず argv を個々の引数として渡す。shell script、評価モード、コマンド置換、引数の再解釈、未検査 response file、任意 plugin など汎用実行を生む形は registry が禁止する。Windows の引数表現も検証済み adapter の責任とし、文字列をつなげて shell command を作らない
- allowlist は任意の許可 binary を無制限に使える意味ではない。test runner、package manager、interpreter は repo の code や subprocess を起動できるため、子孫も同じ file/network/process 制約下に置く。能力を仲介できない agent・tool・子プロセスの route は無効にする
- `max_runs` は全 worker と復旧を通じた台帳上の上限。command 起動 intent と max_runs の回数予約を同じ atomic transaction で確定してから起動する。起動したか不明な command の予約は消費済みとして保持し、自動でやり直さない
- actual agent/model は開始後にも確認し、TaskSpec と不一致なら成功にしない。model の正確な identity を観測できない adapter は実行開始前の能力検査で拒否する
- 作業プロセスの network、勝手な upload/push、対外 message、追加環境変数、利用者の ambient credentials は与えない。必要な agent control-plane は snapshot にある接続先だけを信頼 broker で提供する。TaskSpec、MD、argv、environment、ログ、diff、result、receipt に password、token、API key などを埋め込まない。検出時は送信前に隔離し、安全な error とする

終了後の diff 検査だけでは防止策にならない。実行中の読み取り、書込み、process creation、network を強制することが前提である。

## 7 配送台帳と同時実行

台帳の一意 key は request ID、固定内容は H_T/H_M/snapshot。配送 ID、job state、state revision、approval ID/nonce の消費、run ID、repo lock、単調増加する fencing token、start intent、process identity、command intents、cancel record、receipt reference を永続化する。

### 受信から開始まで

1. T と M を staging に保存して size、encoding、重複 key、decoded 文字列、schema、必須 identity と hash を検証する。構造不正はここで ingress 拒否とし、job を作らない。合格した原本を不変 blob として耐障害保存する
2. 必要な blob が利用可能であることを確認して、台帳への request 登録と原本参照を一つの atomic transaction で commit する。永続化前に受信 ack を返さない
3. 登録済み job の registry/運用上の意味検査後に `awaiting_approval`。承認が検証できたら `approved`。この時点では process を起動しない
4. request revision を compare-and-swap し、repo の排他 lock、run ID、fencing token、start intent、grant 消費を同じ transaction で確定する。単一 request の二重 worker、別 request の同一 repo 実行も排除する
5. token を渡した supervisor でのみ起動する。実体 process の host/boot/PID/creation time/binary hash/process group を確かめて記録してから `running` とする。開始時刻は supervisor が観測した起動時刻で、起動 intent の時刻と別に台帳へ保持する

blob staging と台帳をまたぐ未完了データは見せない。同一 filesystem の rename だけで、台帳・承認消費・lock 全体の atomicity が得られると仮定してはならない。共有する強整合な transaction 境界か同等の実証済み手段が必須である。

開始 intent を commit した直後から process identity の記録までには障害の窓がある。この窓で落ちたら、実行したかもしれない。証拠が揃うまでは `unknown` とし、再起動して埋め合わせない。台帳 transaction だけで OS の process creation や外部効果を exactly-once にできるとは主張しない。

### lock と fencing

lease の期限や heartbeat の途絶だけを根拠に lock を消して新しい worker を動かしてはならない。token は repo ごとに単調増加し、file/command broker、成果物公開、状態更新、receipt 確定は現在の token だけを受理する。古い worker の遅延応答も拒否する。

旧 worker が直接共有 tree へ書ける設計は禁止。run ごとに隔離された worktree を使い、共有先への反映は token を検査する broker だけが行う。token の失効が既に走る process を自動停止するとは仮定しない。旧 process の停止または効果の隔離を証明できなければ repo を保留し、lock を強制奪取して並行実行しない。

## 8 状態と遷移

`status` は検証済み snapshot。通常の実行状態は台帳に保持する。`unknown` は証拠を失った観測側の状態であり、台帳の古い確定値を失敗へ書き換える命令ではない。`last_confirmed_status` と最新の observation sequence を一緒に保存する。

| 状態 | 意味 | 許される次の状態 |
| --- | --- | --- |
| `received` | 原本を耐障害保存した | awaiting_approval、failed、cancelled、unknown |
| `awaiting_approval` | 有効な grant を待っている | approved、failed、cancelled、unknown |
| `approved` | grant を検証済み、まだ開始を確認していない | running、failed、cancelled、unknown |
| `running` | 特定した process の開始を確認した | cancel_requested、succeeded、failed、unknown |
| `cancel_requested` | 停止要求を台帳に確定し、停止確認を待っている | cancelled、failed、unknown |
| `cancelled` | 取消が先に確定し、未開始または全子孫の停止を確認した | 同じ最終状態の再取得のみ |
| `succeeded` | 停止、全成功条件、成果物、receipt を検証した | 同じ最終状態の再取得のみ |
| `failed` | 拒否または失敗が確定し、未開始または全子孫の停止を確認した | 同じ最終状態の再取得のみ |
| `unknown` | 開始・継続・停止・結果のいずれかを断定できない | 証拠で復元できた状態だけ |

承認の拒否、失効、scope 不一致、能力不足は開始前の `failed` にできる。schema/JSON として受理できない入力は job を作らず ingress の拒否記録を返す。Result schema は schema-valid な TaskSpec に対する snapshot を定義するため、壊れた request から架空の ID/commit を補って Result を作ってはならない。

`received`、`awaiting_approval`、`approved` は started_at/finished_at/actual agent/model を null とする。running/cancel_requested は開始証拠を必須にする。最終3状態は finished_at と outcome_known=true を持つ。`unknown` は finished_at=null、outcome_known=false とし、error に理由を残す。unknown の started_at=null は「開始していない」の証拠ではない。

`observation_seq` は verifier が request ごとに単調増加させ、同じ sequence の内容を変えない。古い snapshot を新しいものに上書きしない。通常状態の last_confirmed_status は null または同じ status とし、unknown のときだけ直前に検証済みの別状態を保持する。receipt の ledger sequence と observation sequence は別の系列である。

## 9 取消と timeout

取消は認証済みの依頼者/承認者が、request ID と H_T と対象 run ID を指定して記録する。開始 intent 前の取消対象 run ID は null とする。開始 intent で run ID を割り当てた後は、OS process の開始前でもその ID と token を保持して取消・復旧する。単なるチャット本文の「cancel」や期限切れを取消命令として解釈しない。

- 開始 intent 前なら、取消と開始が同じ台帳 transaction 境界で競争する。取消が先なら未開始 receipt を作って cancelled。開始が先なら process の所在を確認して停止手順へ進む。所在不明なら unknown
- running 中は cancel_requested を永続化してから supervisor が停止を試みる。新しい command の許可を停止し、既にいるすべての子孫に停止を要求する
- 猶予後も残る場合は隔離境界で強制停止する。process group に収容できない子孫がいる、終了を証明できない、host に連絡できない場合は cancelled とせず unknown
- 取消の永続化と成功 receipt の確定は同じ状態 revision への compare-and-swap で順序を決める。成功が先なら succeeded を保持し「完了後の取消」と記録する。取消が先なら後から成功条件が満たされても succeeded へ変更しない。停止後は cancelled、または証明された停止失敗等の failed とする
- 取消は rollback ではない。作成済みファイル、commit、部分的な効果を列挙する。自動で共有 branch を戻したり、証拠を削除したりしない

run_seconds は start intent 確定時からの単調時計による上限で、起動にかかった時間も含む。再接続・再起動で予算をリセットしない。supervisor が継続時間を信頼できなくなった場合は、許可時間を増やすのではなく停止を要求する。cancel_grace_seconds は上限到達後の停止猶予で、作業継続の追加予算ではない。

実行 timeout は取消と同じ停止手順を使い、全停止を検証した後に `failed` と `error.code=run_timeout` を確定する。停止証拠がなければ unknown。輸送・poll・UI の timeout は process 終了の証拠ではないため、job を failed や cancelled にしない。明示取消と timeout が競合する場合も最初に台帳へ確定した停止理由を保持する。

## 10 unknown からの復旧

通信断、収集失敗、壊れた marker、host restart、開始直後の crash、receipt 消失は自動再実行の理由にならない。まず同じ request に対して読み取りによる照合を行う。

1. 原本 H_T/H_M、最新台帳 revision、grant 消費、開始 intent、run ID、lock と token を読む
2. 保存した host ID・boot ID・PID・creation time・binary hash・process group と、生存 process の同一性を照合する。PID 番号だけで旧 process と断定したり、kill したりしない
3. command intent、supervisor の開始/終了記録、隔離 worktree、commit、artifact hash、最終 receipt を確認する
4. 最新 token の信頼できる最終 receipt と全証拠が一致すれば既存結果を復元する。実行継続が証明できれば running または cancel_requested を復元して監視を続ける
5. supervisor/台帳に未開始を証明する記録があれば未開始の failed/cancelled を確定できる。単に process が今見つからないことや、exit code がないことは未開始の証明にならない
6. いずれも証明できなければ unknown を保持し、repo を隔離・保留する。人の調査が必要であることと不足証拠を報告する

同じ request の内容を再送しても新しい start intent を作らない。再実行が必要なら、先行 run と部分効果を確認し、旧 run が終わったか隔離されたことを証明してから、新しい request ID、必要なら新しい base commit、別 grant を得る。operator が「たぶん失敗」と判断しただけで unknown を failed に変更してはいけない。

### 上限付きの自律 session

session は同じ不変 policy の下で複数 job を順に扱う管理単位である。policy と session の ID を TaskSpec の hash 内へ固定する。session の controller は開始前に job 数、deadline、累積時間、必要な費用を原子的に予約し、grant 消費と start intent に結びつける。予約と残量を別 worker が同時に使ってはならない。期限切れなどで開始しなかった予約を戻す場合も、開始 intent がないことを証明して transaction で処理する。unknown な予約は解放しない。

次のいずれかで新しい job の開始を停止する。これは認証済みの controller の要件であり、チャット側が自動で目覚める仕組みを主張するものではない。

- 上限 job 数、session deadline、実行時間/金額 budget のいずれかに到達した
- policy が失効、取消、変更された。または信頼できる policy/usage store を読めない
- 実行、終了、receipt、成果物のいずれかが unknown、矛盾、改ざん検知となった
- 利用者または権限を持つ管理者が緊急停止した。あるいは必須確認を要する操作が出た

緊急停止は新規 grant と開始を原子的に禁止し、未使用 grant を失効させ、実行中 job には認証済み取消を記録する。policy 取消も同様に新規開始を止め、当該 policy の実行中 job に取消を要求する。停止要求と全停止の確認は別であり、確認できるまで paused/unknown の状態を保持する。単に UI を閉じる操作は緊急停止の代わりにならない。

unknown が解消しても自動再開しない。信頼できる evidence を復元し、元 policy が有効で残量と deadline に余裕があることを確認し、認証済み controller の明示的な resume を記録する。policy を拡大する resume には新しい利用者承認が必要。先行 job と receipt が完全に確定した後だけ、許可済みの次の job を作れる。

### 結果配送と ack

job 完了と結果の配送完了を分ける。最終 receipt transaction と同時に永続 outbox event を作り、`event_id`、request ID、H_T、run ID、receipt ID/ledger sequence、Result bytes の SHA-256、認可済み宛先を固定する。外部配送用 event は資格情報を含めない。event の重複配信があり得ることを前提とする。

受信側は event ID と payload hash で重複を排除し、Result と artifact/receipt を検証してから、同じ event ID/hash と受信主体を認証した ack を返す。同じ ID の異なる payload は競合として隔離する。ack を永続化した後だけ配送済みとする。既存 transport の completed、画面上の marker、通知送信の成功をこの ack と同一視しない。

ack がない場合は結果配送だけを再試行し、job を再実行しない。automatic/bypass の配送の再試行期限・回数・宛先は事前承認された session policy に固定し、期限後は delivery_pending と不足理由を記録して人へ戻す。manual で preauthorization=null の job は、既定では認証済みの元の照会 channel に結果を保持し、poll と明示的な resultACK で受け渡す。外部 push や継続 session を manual grant から暗黙に作らない。manual でも外部配送が必要なら、宛先・期限・回数を snapshot に固定して依頼単位で明示承認する。job の succeeded/failed/cancelled は変えない。未依頼の別宛先への通知へ切り替えない。session は必要な ack を得るか、配送保留を明示して停止したときに閉じる。この節の event/ack の adapter は将来の連携要件であり、本書単独で外部通知や自動起床が実装されるわけではない。

### 発行から結果受理までの handshake

接続 adapter は次の5種類の記録を区別する。これらは外側の配送 envelope であり、既存 transport schema や TaskSpec/Result へ未定義の属性を注入しない。

1. `issued`: 依頼者が不変 T/M を発行した記録。実行許可ではない
2. `receiptACK`: 受信側が原本と hash を耐障害保存したことの応答。承認や開始の証拠ではない
3. `startReceipt`: supervisor が特定の process 開始を確認した記録。run ID/token/process identity と start intent revision を持つ。起動しなかった依頼では発行しない
4. `terminalResult`: 真正な最終 receipt に基づく succeeded/failed/cancelled。unknown は最終完了ではない
5. `resultACK`: 認可された依頼者側の検証器が該当 Result と証拠を検証・保存した応答。人による成果物の採用を自動で意味しない

各 envelope は `event_id`、event kind、request ID、H_T、対象 run ID、送信 actor ID/role、根拠となる authoritative state revision、関連する前段 event ID、payload hash を固定する。開始前の run ID は null、割当後の記録は割当済み run ID に束縛する。開始前の ACK が後から別 run を承認する意味にはならない。actor は認証済みの登録主体に限り、MD/LLM が自称した role を受理しない。

同じ event ID/hash の重複は同じ応答を返す。同じ ID で異なる内容、別 request/hash/run の ACK、古い revision の上書き、複数 worker の claim は競合として隔離する。順序の逆転した ACK は保存しても、その前提 event と台帳を照合するまで状態を進めない。ACK 不足時は、まず権威ある台帳と receipt を照会し、不足している同じ配送 event だけを再送する。ACK から process の存在や終了を推定したり、欠落した startReceipt を作って辻褄を合わせたりしない。

LLM に提示する pending/completed の一覧も、この台帳と検証済み receipt から組み立てる。一覧に request ID、hash、既知の run ID、state revision、verification、配送/ACK の状態を付ける。unknown、未承認、配送待ちを隠さず、会話上の「完了」という文だけで completed に移動しない。古い一覧への LLM の応答から開始枠や権限を復活させない。

「実行済み」「依頼者側で結果を受理済み」「人が採用を承認済み」「共有 branch へ merge 済み」は別の記録とする。terminalResult は merge 許可ではない。merge は対象の固定 commit、確認した試験/レビュー、権限を別途確認する行為であり、Result の succeeded を根拠に自動で行わない。

## 11 Result と receipt の確認

### 必須の結果データ

Result は task ID と2種類の hash、status、観測時刻/sequence、開始/終了時刻、actual agent/model、base/resulting commit、commands_run、tests、exit_codes、changed_files、diff、stdout/stderr の参照、error を必須にする。run ID、fencing token、process identity、receipt、verification も含める。取得できない値は schema が許す null として示し、架空の値で埋めない。failed/cancelled では actual agent/model の確認自体に失敗した場合は null とできるが、error と evidence へ理由を残す。開始済みの最終結果は process identity、run ID/token、全子孫停止の receipt が必須である。未開始を証明した場合も、start intent で割当済みの run ID/token は消さない。割当前の拒否なら null/0、割当後なら UUID/正の token とし、root と receipt を一致させる。

- `commands_run` は実際の invocation ID、対応する command ID、解決 binary hash、argv hash、cwd、開始/終了、exit code、終了方法、ログ参照を持つ。argv hash は JSON の曖昧さを避け、承認済み argv 配列を UTF-8 の各要素の byte length と bytes の列で符号化したものとする。length は符号なし64 bit big-endian、先頭に要素数を同じ形式で置く
- `exit_codes` は全 command invocation の1対1の一覧。同一 invocation に異なる値を載せない。未観測は null。OS 固有の code を隠して0に変換しない。強制停止で OS の code を得られない場合も null とし、termination=killed の証拠を残す
- `tests` は criterion/evaluator の検証記録。passed は確認できたものだけ。skipped、unknown、未実施は合格ではない。各 success criterion が漏れなく登録 evaluator の証拠で満たされた場合だけ succeeded にできる
- `changed_files` は登録 repo に相対の file path と before/after SHA-256。rename は delete+add として表す。untracked、削除、binary、mode 変更も差分確認対象にする。mode 変更だけの file も modified として記録し、同じ内容 hash を許す
- `diff.kind=git_binary_patch` は binary/mode 変更を含む完全な差分 artifact。`none` は参照を持たない。`complete=false` は差分未確定を示し、空の changed_files と併用されても「変更なし」を意味しない
- read_only 成功時、変更はなく resulting_commit=base_commit。edit 成功時は検証した隔離 tree の commit、変更なしなら base と同じ commit。失敗時の resulting_commit=null は巻戻しや無変更を意味しない
- stdout/stderr は本文に丸ごと埋め込まず artifact 参照にする。null は artifact を持たない意味で、無出力を検証した証拠ではない。空ログを証明するなら size=0 とその実 hash の参照を作る

artifact 参照は固定保管域にある artifact ID、SHA-256、size、media type を持つ。任意 URL、path traversal、別ユーザーの object を参照できない resolver に限定する。artifact は不変で、サイズ・hash・アクセス境界を再確認する。欠落、置換、危険な binary を自動起動する手順は禁止する。機密が混入した artifact は利用者向け回収から隔離し、必要な範囲だけの安全な記録へ置き換える。元 bytes の hash と redaction 後の hash を混同しない。

### receipt が証明すること

receipt は executor が書いた「終わった」という文ではない。信頼台帳に確定した最終記録で、request ID、H_T、run ID、token、ledger sequence、最終 status、未開始または全停止、記録時刻、詳細証拠 artifact を含む。receipt 参照の存在や digest だけでは真正性を証明しない。verifier が認証済み台帳から同じ記録を読み、最新 token/revision と突き合わせることが必須である。

evidence artifact は少なくとも、原本 hash、使用した承認 record と消費 revision、cancel/timeout の順序、process birth/exit と全子孫終了、command intents/exit、実際の agent/model、base/tree/commit、file/diff/log hashes、criterion の検査内容を持つ。未開始の場合は start intent/grant 消費の有無と未開始を証明する supervisor/台帳記録を含む。参照だけがあり内容を確認できない場合は verified ではない。

最終 receipt と成果物は先に耐障害保存し、その参照と最終状態を一つの atomic transaction で確定する。その後に Result の snapshot と ack を公開する。receipt 確定後、応答送信前に crash しても同じ receipt を再取得できるようにする。receipt 内容と最終状態は後から上書きせず、訂正が必要なら別の監査記録として残す。

### verifier の受入手順

1. 受け取った Result のサイズ上限、JSON、schema、未知フィールドを検査し、`synthetic=true` は運用結果から必ず除外する
2. request ID、H_T/H_M、base commit、run ID、token、process identity を不変原本と台帳へ照合する。actual agent/model と snapshot の一致を検査する
3. receipt の真正性、最新性、最終 status、process state と Result の整合性を確認する。古い token/sequence の結果や別 run の receipt を拒否する
4. command と回数、argv/cwd/binary、exit_codes、tests、全 success criteria を照合する。成功条件の自己申告や説明文の keyword 一致で代替しない
5. 全 artifact を size/hash で検査し、changed_files/diff/tree/resulting commit を照合する。許可外の読書きや command があれば成功にしない
6. 時系列、null の意味、終了順、cancel/timeout の勝敗を確認する。状態が確定できたものだけ verification=verified とする

succeeded は、開始と全停止、全条件合格、完全な差分、commit、真正な receipt が揃った場合だけ。失敗が確定し停止も確認できれば failed にできるが、部分的な差分・ログの未回収は明示する。receipt 不足、改ざん、矛盾で実際の終了状態を確定できない場合は raw claim を隔離し、信頼できる観測 Result を unknown として作る。受信 payload の `verification=verified` という文字を信じてはならない。

## 12 Schema と意味検査の責任分担

2つの schema は JSON Schema Draft 2020-12 を用いる。unknown property を拒否し、必須値、型、enum、上限、hash/path の形、状態ごとの null/必須条件を検査する。承認 envelope は TaskSpec と別 instance として `$defs/approvalEnvelope` で検査する。`example.invalid` の schema ID は識別子であり、network 取得先ではない。schema は検査済みのローカル版を固定し、外部 `$ref` の任意取得を許可しない。[JSON Schema Core](https://json-schema.org/draft/2020-12/json-schema-core) [Validation](https://json-schema.org/draft/2020-12/json-schema-validation)

`format` は validator により注釈だけの場合があるため、UUID/date-time の実検査を有効化する。schema の pattern に加えて暦上存在する UTC 時刻を検査する。以下は schema 合格だけでは保証できず、専用の意味検査が必須である。

- raw JSON の重複 key/byte length/encoding、実バイトの hash、認証と承認の失効/消費、時刻差と期限
- request/command/criterion/invocation/path ID の一意性、command と exit/test の相互参照、max_runs の消費
- allowed_paths の OS 上の包含性、case/alias、symlink/reparse/hardlink、TOCTOU、実際の repo/object の存在
- 実プロセスの同一性、子孫停止、fencing、状態遷移、再起動をまたぐ時間予算
- started_at ≤ process creation time ≤ finished_at/observed_at、command が run の時間内にあること、finished_at ≤ receipt recorded_at ≤ verification checked_at ≤ observed_at などの順序、同じ sequence の不変性
- TaskSpec と Result の repo/base/model/agent/mode、receipt と Result の request/hash/run/token/status の完全一致
- 全 success criteria の網羅、実 file/diff/commit/ログとの一致、秘密情報の除外

schema 検査器を実行して例が通ることと、実行 adapter の安全性試験を通ることは別である。本成果物では前者だけを検査対象とする。

## 13 障害と復旧の受入チェックリスト

将来実装する際は、通常系だけでなく各故障点で crash・再配送・競合を注入して確認する。以下は未実施の受入条件であり、テスト成功の記録ではない。

| 故障または攻撃 | 必須の期待結果 |
| --- | --- |
| 同じ request と同じ原本を2 worker が同時受信 | 台帳は1件。start intent/grant 消費は高々1枠。状態照会に収束 |
| 同じ ID で JSON の空白だけ変更 | H_T 不一致で request_conflict。以前の承認を使わない |
| MD の改行、1 byte、ファイル名の指す原本を変更 | H_M/H_T を照合して拒否。本文を取得し直して実行しない |
| approval 方針、allowed_paths、command、model、timeout を変更 | TaskSpec 全体の H_T が変わり再承認が必要 |
| 認証のない approved envelope、失効/期限切れ/replay | 起動前に拒否。ID/nonce だけでは通らない |
| 指示文や repo 内文書に許可拡大を書き込む | data として扱い、機械的な権限は変わらない |
| binary 差替え、PATH/alias 誘導、argv 内 shell 記法 | 固定実体検査または完全一致規則で拒否。shell を開かない |
| ../、絶対 path、case/short-name alias、link/reparse/hardlink 置換 | 操作前・操作時の境界で拒否。能力不足なら開始しない |
| 許可 test から別 process/network/許可外 file access | 子孫を含め強制拒否。事後 diff だけで合格にしない |
| blob 保存前/台帳 commit 前の crash | ack なし。半端な依頼や未封印本文を runnable にしない |
| start intent 後、PID 記録前の crash | unknown。PID 不在や空ログから未開始を推定しない |
| process 実行中に transport または host が切断 | unknown。失敗判定、自動再実行、lock 奪取をしない |
| 再接続時に同じ PID が別 process に再利用 | boot/creation/binary/group の不一致を検知。誤って停止しない |
| 古い worker が lease 切れ後に書込み/結果公開 | 旧 token を broker が拒否。隔離を確認するまで次を走らせない |
| process 終了後、receipt commit 前の crash | 終了証拠を照合。receipt を捏造せず、不足時は unknown |
| receipt commit 後、Result/ack 前の crash | 同じ receipt と結果を回収。作業を再実行しない |
| cancel と成功確定が同時 | 台帳 CAS の先勝ち。cancel 先なら後発 succeeded を拒否 |
| cancel 猶予後に子 process が残る | cancelled にしない。停止不能を調査し unknown を保持 |
| run timeout と輸送 timeout | 前者は停止確認後 failed/run_timeout、後者は unknown |
| completed transport で result 添付だけ欠落 | job を succeeded にしない。既存 run/receipt を読む |
| 別 job の Result、改ざん artifact、不完全 diff | 対応関係と hash で拒否。必要なら unknown と隔離 |
| actual agent/model 不明、登録外へ自動 fallback | 能力検査で開始拒否。開始後に判明したら成功扱いしない |
| test skipped/unknown、exit code 不明、成功条件の漏れ | succeeded を拒否 |
| bypass で scope 外 command または必須個別確認の操作 | 画面省略と権限免除を分離し、開始拒否または手動確認 |
| policy 改版、expiry、job/time/cost 上限、緊急停止 | 予約/消費と競合させず新規開始を停止。実行中は取消の証拠を確認 |
| 1 job が unknown のまま session の次を開始 | session を pause し、残予算を解放せず開始拒否 |
| outbox event の再配送、ack 消失、同じ ID の改ざん | 結果だけを重複排除/再配送。job 再実行禁止。異なる hash は隔離 |
| synthetic fixture を運用 queue に投入 | mode/synthetic gate で拒否。承認や実行の証拠に使わない |
| 原本/ログに credential が混入 | 実行・回収・外部送信を停止し、秘密を含まない error を返す |

## 14 同梱例の照合値と未決定事項

配布時点の生バイトを次の値へ照合する。

- `task_example.md` の SHA-256: `31d2cb7854e16ac198c39ca8f0959d43222242b12af2d1e103765098296903b5`
- `task_example.json` の SHA-256: `3ae9588585512866a92080a9b2d2a1893864a38a9693bb4aa344742b41d2c6fb`

`task_example.json` の task_file_hash、上の拒否 envelope、`result_example.json` の2つの hash はこの原本に一致する。JSON を formatter で保存し直しただけでも H_T は変わる。MD を書き換えた場合は MD hash、TaskSpec bytes、H_T、例の Result/拒否記録を作り直す。

運用開始前に決めて証明する必要があるものは、承認者/権限 registry、承認サービスの認証と取消、耐障害 transaction store、OS ごとの file/process/network 隔離、adapter と model identity の観測法、artifact 保管と保持期間、独立 verifier、監査と復旧の担当である。これらが未確定のまま、この文書を根拠に agent 起動や環境接続を開始してはならない。

## 15 診断 事前見積り job の依存関係

この版の6ファイルへ未定義の root field を追加せず、次の拡張は版を固定した registry/snapshot と外側の workflow 台帳で扱う。実行可否、対象、権限、順序、上限へ影響する metadata は、実行前に不変の policy snapshot へ含め、その hash を TaskSpec の H_T 内へ束縛する。単なる UI annotation、可変の sidecar、LLM の説明だけで実行条件を変えない。snapshot を変更したら T と承認を再生成する。実装が認識しない拡張のある job は開始しない。

診断は registry、認証済み台帳、OS が観測した process、hash 検証済み artifact など、事実の出所と観測時刻を添える。capability を ready/blocked/unknown と区別し、推測を測定済みとして出さない。前回の成功から今回の認証・binary・隔離能力を推定しない。blocked_auth の影響範囲は該当 adapter、依存 job、共有 resource に限定し、独立 route の診断を混同しない。

preflight は開始前に、原本と許可範囲、repo/base、adapter 能力、時間予算、必要な費用・容量の予約可能性を検査する。見積りには値の幅、前提、データの出所、unknown の項目を示す。見積りは課金額や完了時刻の保証ではない。費用・能力・上限を確実に守れない場合は開始拒否とし、推定値で許可を拡張しない。診断のために未承認の CLI や作業 command を起動しない。

workflow は bounded な job 集合、固定 request ID、依存 edge、依存が満たされたとする条件を持つ。受理時に参照欠落、自己依存、循環を検出して拒否する。依存先が verified terminal success など所定条件を満たし、期待する hash/commit と一致するまで下流 job を開始しない。unknown、失敗、取消、未受理結果を勝手に成功とみなさない。実行済みと依頼者受理済みを依存条件に使う場合はどちらかを明示する。

依存 graph と repo lock は別の条件である。依存のない job でも同一 repo の排他 lock は共有し、別 repo の job はそれぞれ独立した lock と fencing token を持つ。複数 repo を同時に要求する拡張では、固定順序による取得または atomic reservation で deadlock を避け、1つでも不明なら開始しない。依存関係のある graph 全体を1つの緩い lock で置き換えない。新しい job や edge を追加する場合も、session 上限と固定 snapshot の再評価が必要である。


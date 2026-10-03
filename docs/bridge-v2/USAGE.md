# 使い方手順書: Bridge v2

## 0 先に確認すること

対象は `nuts-kinoco/ChatGPT-Post`。必ず引継ぎで指定された **固定コミット**を checkout する。
PR1 はコア、PR2 は初期 UI、PR3 は配送アダプター。後続には compact A UI、archive/materializer、operations/lifecycle と、別枝の Antigravity があります。
PR 番号順に無条件で merge せず、対象 PR 本文の exact parent/head と依存順を確認する。
同じ checkout の capabilities、[UI-OPERATIONS-USAGE.md](UI-OPERATIONS-USAGE.md)、
[ARCHIVE-USAGE.md](ARCHIVE-USAGE.md)、[PLATFORM-GAPS.md](PLATFORM-GAPS.md) を合わせて確認する。
古い PR の実装説明を、後続の配線まで検証済みという意味で使わない。

現段階では、通常 Chat のブラウザ配送コードと GitHub の一往復コードは存在する。
Claude/Codex の **安全な OS 実行 supervisor は未完成**。マージだけで安全な CLI 実行が
可能になるとは扱わない。[PLATFORM-GAPS.md](PLATFORM-GAPS.md) の実装不足と実機試験を分ける。
自動 merge、認証追加、鍵作成、Windows 操作、モデル起動の許可はこの手順からは発生しない。

## 1 モデルも外部サービスも起動しない初回確認

Node.js 22.13 以上を使用。既存 lockfile を変更しない。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run lint
npm run build
node dist/cli/main.js task capabilities
node dist/cli/bus.js capabilities
node dist/cli/bus.js help
```

`task capabilities` は元の検証 CLI の能力、`bus capabilities` は追加アダプターの状態を表示する。
`liveActivated:false` が既定。`broker_implemented_os_supervisor_required` は実装不足を意味する。

UI の安全な体験:

```sh
node dist/cli/main.js ui --profile demo
```

表示された localhost URL は本人用 capability を含む。許可されたローカルブラウザで開き、共有しない。合成タスク作成 → 内容確認 → 承認 → 開始 →
合成成功/失敗/不明 → 受領 ACK を試す。実プロセスやモデルは起動しない。
終了は Ctrl+C。現在の画面・再開手順は [UI-OPERATIONS-USAGE.md](UI-OPERATIONS-USAGE.md)。
旧 [UI-USAGE.md](UI-USAGE.md) は PR2 の履歴資料として読む。

通常の台帳確認は `--profile production`。未設定の実行/承認は無効のまま。
デスクトップ GUI は同じ product UI を使い、従来のブラウザチャットはトレイの専用項目に残る。

## 2 配置設定を準備する担当者向け

これは現在許可された接続を利用するホスト設定であり、タスクから設定を読み込ませない。
既存の認証済みサービスが提供する認証/署名 callback を使用し、token/key をリポジトリや
タスク本文に保存しない。未接続なら別途必要範囲の承認を得る。

必要な設定:

1. 既存 GitHub repository/branch と専用 namespace。必要な読取り/書込み権限の範囲。登録 repo ID → product slug の対応（公開用の例: product-a / product-b）。保存先は projects/<product>/requests/<UUID>/。global request index で製品を跨ぐ UUID 再利用を拒否
2. requester/recipient の登録 ID、役割、Ed25519 公開鍵、および既存のホスト署名 provider
3. ホストローカルの TaskStore と TransportJournal。別ホストで SQLite を共有しない
4. exact base commit、登録モデル、path/command、session/timeout/budget、認証済み承認 session
5. quota の対象 limitId、freshness、unknown 時の明示的な限定 fallback の有無
6. CLI は本物の enforcing supervisor が必要。存在しない現在は有効化しない
7. 通常 Chat は既存 conversation URL、model/preset、専用 profile、最大送信数/期限、事前認可された期待出力 policy を固定
8. 受領側 materializer、許可済み content-addressed 保存先/読取範囲、固定された requester output root を設定。必要な実 byte を保存できなければ ACK は無効

ホストの `.mjs` は `openDeployment()` を export する。返り値は `src/cli/bus.ts` の
`BusDeployment`。UI 用には `createBridgeDeployment(...).uiRuntime` を含める。
同じホスト設定から bus/host/browser/uiRuntime を構築する。`close()` を返す場合、起動した
observer/worker と DB の終了処理をその関数が所有する。UI は二重に DB を閉じない。
residentWorker は明示 opt-in で、UI が listen 成功後に start し、終了時は先に drain する。
openDeployment 自体で start しない。catalogue/template も同じ module をロードするためである。
drain 失敗時は DB を保持し、明示 retry する。hide/collapse/tray は終了ではない。

`.mjs` は任意コードを実行できる **信頼済みホスト設定**。入力 JSON から path を取らない。
ファイルと全親 directory を本人/管理者所有・group/other 書込不可にし、import 先も同じ信頼境界に
置く。POSIX loader はこれを検査する。Windows の native ACL verifier は未実装なので
`deployment_windows_acl_verifier_unavailable` で止まる。フラグで迂回しない。

設定済みの production UI を実際に起動する入口:

```sh
node dist/cli/main.js ui --profile production --deployment /trusted/deployment.mjs
```

GUI では同じ絶対 path を `CHATGPT_BRIDGE_DEPLOYMENT_MODULE` に設定して起動する。
設定を作るためにアプリ本体の source を変更する必要はない。demo と deployment の併用は拒否する。
configured UI も core の capability/approval/quota/sandbox gate を通る。

## 3 LLM が準備・発行し、人は監視する

通常は LLM が CLI を操作し、UI は進捗・結果・設定の確認に使う。手動 composer は補助経路。
新しいモデルセッションでは [LLM-QUICKSTART.md](LLM-QUICKSTART.md) の短い導入を読み、
版・capabilities・登録先を確認する。インストール済み CLI/skill は認証・文脈保持の証明ではない。
Claude/Codex/Antigravity の実体や model ID を推測せず、次の読取りから始める:

```sh
node dist/cli/bus.js --deployment /trusted/requester.mjs catalogue
node dist/cli/bus.js --deployment /trusted/requester.mjs template PROJECT_UUID DESTINATION_ID MODEL_ID
node dist/cli/main.js task schema task
```

モデルが複数なら MODEL_ID は必須。template は `templateOnly:true` / `executable:false`。
request_id と task_file_hash は未設定で、モデル/コマンド権限の追加許可ではない。
出力をローカル template.json に保存し、task.md を UTF-8 で作る。次の例を checkout の
prepare-request.mjs として保存すれば、既存 schema/validator を使って新規 JSON を生成できる。
これは新規一件用であり、既存 ID の retry では再実行しない。scope は template のまま維持する。

```js
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadTaskSpec, sha256Bytes } from './dist/contracts/task.js';
import { parseOutputContractV1, validateOutputContractPolicy } from './dist/contracts/output-contract.js';
if (existsSync('task.json') || existsSync('output-contract.json')) throw new Error('existing_request_keep_identity');
const template = JSON.parse(readFileSync('template.json', 'utf8'));
if (template.version !== 'bridge-issuer-template-1' || !template.templateOnly || template.executable !== false) throw new Error('template_required');
const md = readFileSync('task.md');
const task = { ...template.taskSpecTemplate, request_id: randomUUID(), task_file_hash: sha256Bytes(md) };
const raw = Buffer.from(JSON.stringify(task));
if (!loadTaskSpec(raw).valid) throw new Error('task_schema_invalid');
let contractBytes;
if (task.agent === 'chatgpt-browser') {
  if (template.outputPolicy.state !== 'available') throw new Error('output_policy_required');
  const p = template.outputPolicy.value;
  const binding = {
    requestId: task.request_id, taskSpecHash: sha256Bytes(raw), taskFileHash: task.task_file_hash,
    route: 'hosted_delivery', requesterActorId: p.requesterActorId, recipientActorId: p.recipientActorId,
    policySnapshotSha256: task.policy_snapshot_sha256,
    registryRevision: template.registryRevision, registrySnapshotSha256: template.registrySha256,
    projectId: template.projectId, repoId: p.repoId, storageSlug: p.storageSlug, destination: p.destination,
  };
  const contract = { ...binding, schema: 'output-contract-1', mode: p.mode,
    requiredOutputs: p.requiredOutputs, allowAdditionalArtifacts: false,
    maxArtifacts: p.maxArtifacts, maxTotalBytes: p.maxTotalBytes,
    declarationFormat: 'bridge-artifact-declaration-1' };
  contractBytes = Buffer.from(JSON.stringify(contract));
  validateOutputContractPolicy(parseOutputContractV1(contractBytes), p, binding);
}
writeFileSync('task.json', raw, { flag: 'wx', mode: 0o600 });
if (contractBytes) writeFileSync('output-contract.json', contractBytes, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ requestId: task.request_id, taskSpecHash: sha256Bytes(raw), taskFileHash: task.task_file_hash }));
```

```sh
node prepare-request.mjs
node dist/cli/main.js task validate --request task.json --task-file task.md
```

生成例は認可設定を増やさない。受信側は独立した trusted policy を再検証する。
登録や宛先が変わったら、発行前に catalogue/template を読み直し、意図した current revision と
一致するか確認する。UI の pinned preview 発行は保存済み revision/hash の変化も拒否する。
一度発行した後は JSON/MD の改行も変更しない。BEGIN/END と artifact declaration は host が
exact request/hash/attempt/output-contract に基づいて指示する。frame は成功や ACK の代用ではない。

### GitHub 一往復の操作

以下は必要な既存 provider とホスト設定が承認・準備済みの場合だけ実行する。

```sh
# 送信元: exact UTF-8 JSON と MD を一つの Git commit に格納
node dist/cli/bus.js --deployment /trusted/requester.mjs issue task.json task.md recipient cli
# 受信先: 署名/固定 commit/hash/claim を検証して台帳に取り込む
node dist/cli/bus.js --deployment /trusted/recipient.mjs tick
# 受信先: 確認した task hash だけを手動承認
node dist/cli/bus.js --deployment /trusted/recipient.mjs approve REQUEST_UUID TASK_SHA256
# 受信先: 設定された上限/依存条件内で開始または元の run を照合
node dist/cli/bus.js --deployment /trusted/recipient.mjs tick
# 送信元: 読むだけ。受領 ACK はまだしない
node dist/cli/bus.js --deployment /trusted/requester.mjs result REQUEST_UUID
# 送信元: 表示された exact payload hash と result/receipt/必須artifactを検証・保存して受理
node dist/cli/bus.js --deployment /trusted/requester.mjs ack REQUEST_UUID RESULT_PAYLOAD_SHA256
# 受信先: ACK を取り込み、必要なら quota の観測だけを追加
node dist/cli/bus.js --deployment /trusted/recipient.mjs tick
```

`ack` は `BusDeployment.materialize` が必須。これは result/receipt/source/必須 artifact byte を検証し、requester 側に耐久保存してから proof を返す。payload hash の目視だけでは ACK されない。署名付き manifest/proof の不足は delivery_pending として同じ ID を保持する。

CLI 開始は supervisor 未完成の間、拒否が正しい結果。`tick` は一回の bounded reconciliation。
継続 polling は [RESIDENT-WORKER.md](RESIDENT-WORKER.md) の明示設定で有効にする。
CLI と通常 Chat は独立 lane で進み、遅い lane を待って他方の収集を止めない。
未設定なら tick の一回実行だけで、画面を開いたことから自動配送を推測しない。エラー後は同じ UUID/hash/run を照合する。
新 UUID、違うモデル、別課金経路、job 再実行で配送エラーをごまかさない。

## 4 通常 Chat を使う場合

受信側 `BrowserDeliveryService.policyHash` を取得し、その exact policy をタスクに結び付ける。
TaskSpec は `agent:chatgpt-browser`、configured model と同じ requested_model、read_only、
allowed_commands 空、run_seconds >=10、configured policy hash。fixture は送信できない。
会話 URL/model/preset はホスト側固定で、タスク本文から変更できない。

新規の通常 Chat 発行には `output-contract-1` の exact JSON body が必須。登録 project UUID/revision/hash、送信者/受信者、会話、task/MD/policy hash、必要な出力範囲を結び付ける。`bridge-issued-2` と同じ atomic commit に保存する。text_only でも明示契約と返信中の artifact declaration が必要で、DOM にリンクがないことからゼロ件を推測しない。[OUTPUT-CONTRACT-AMENDMENT](OUTPUT-CONTRACT-AMENDMENT.md) を参照。具体的な policy/source-proof2/materializer 配線は後続 archive/operations 実装に含まれる。
設定欠落、artifact の安定 ID/byte 取得未対応、required inventory 不明なら delivery_pending を維持する。
実 DOM の取得成功はまだ実機検証が必要。

```sh
node dist/cli/bus.js --deployment /trusted/requester.mjs issue task.json task.md recipient ordinary_chat_browser output-contract.json
node dist/cli/bus.js --deployment /trusted/recipient.mjs tick
node dist/cli/bus.js --deployment /trusted/recipient.mjs browser-start REQUEST_UUID TASK_SHA256
node dist/cli/bus.js --deployment /trusted/requester.mjs result REQUEST_UUID
node dist/cli/bus.js --deployment /trusted/requester.mjs ack REQUEST_UUID RESULT_PAYLOAD_SHA256
node dist/cli/bus.js --deployment /trusted/recipient.mjs tick
```

`browser-start` は認証済み localAuthority と exact hash による一回の承認/送信。
結果は `hosted-response-1`。ローカルファイル/command scope の強制や v2 TaskSpec 成功証明ではない。
認証ブロックは `blocked_auth`。送ったか不明、途中切断、ページを閉じた場合は再送しない。
必要なら既存の `collect` 手順で元の返信の所有を確認し、同じ記録へ照合する。
ページ閉鎖/停止要求は ChatGPT 側の生成停止証明にはならない。

通常 Chat の PR イベント自動起動は別の未検証候補。今回購読は作成していない。
Work/dot MCP Events へ無断で切り替えない。

## 5 終了、復旧、問い合わせ時の返却物

UI 終了は job の再実行許可ではない。service 再開時は DB/journal/claimant identity を維持する。
unknown の ledger、claim、result、receipt を削除してやり直さない。失われた claim は自動奪取しない。

返す情報は [TESTING.md](TESTING.md) のテンプレートに従う。認証 token、鍵、ブラウザ profile、
全 DB、私的プロンプトは貼らない。公開可の合成試験 ID/commit/hash/エラーコード/ログを返す。

## 6 最終到達点

このPRは中間チェックポイント。最終PR扱いにするのは、通常ChatとCLIの両方で実際に
request→claim/approval→配送/実行→result→ACK が成立した証拠が揃った後。実機担当は
Codexが実装/修正、Claudeが独立監査。ユーザー自身へ手動テスト一式を依頼しない。
本文のBEGIN/ENDはUUID・task hash・attemptに結び付く。framingは成功や承認の代わりではない。

## 7 CLI と通常 Chat の両方へ並列に依頼する

一つの global route を選ぶ構成ではない。独立した child UUID とその TaskSpec/MD を用意し、
同じ署名済み fanout 親へまとめられる。JSON manifest は、その directory 内の相対パスのみ。

```json
{
  "fanoutId": "11111111-1111-4111-8111-111111111111",
  "requests": [
    {"requestFile":"cli/task.json","taskFile":"cli/task.md","recipientId":"cli-recipient","route":"cli"},
    {"requestFile":"chat/task.json","taskFile":"chat/task.md","recipientId":"chat-recipient","route":"ordinary_chat_browser","outputContractFile":"chat/output-contract.json"}
  ]
}
```

UUID は例。実行時は一度生成して保存し、再送で生成し直さない。

```sh
node dist/cli/bus.js --deployment /trusted/requester.mjs fanout-issue fanout.json
node dist/cli/bus.js --deployment /trusted/requester.mjs fanout-result FANOUT_UUID
```

親と全 child のJSON/MD/indexは一つの Git commit で保存する。各受信者は独立してclaim/承認/開始し、
CLI→Chatの順番待ちは不要。`fanout-result` は child ごとの結果/エラー/hashと total / available /
pending / acknowledged を返す。片方の認証ブロックや unknown は、もう片方の収集を止めない。
available は成功件数ではなく取得可能な結果件数。各 child の `outcome` を確認し、`ack CHILD_UUID HASH`
で個別に受理する。fanout は実行承認/並列上限/同repo lock/安全上のsession停止を上書きしない。

## 8 専用ブラウザを保持する既存経路

許可された実機試験で、既存の専用 profile と daemon を使う場合だけ実行する。今回未実行。

```powershell
$env:CHATGPT_BRIDGE_DAEMON_KEEPALIVE = "0"
node dist/cli/main.js daemon start
node dist/cli/main.js daemon status
```

既存 adapter が healthy な同一host daemon に接続する。job終了は接続解除で、daemonのChromeは
残る。最小化の可否/挙動は実機で確認する。終了するなら `daemon stop`。
profileは通常のcontext閉鎖でも削除されないため、「毎回閉じるからcookieが消える」とは断定しない。
保持すればCloudflareが出ないという保証もしない。認証/challengeは本人操作へ引き渡し、元の
UUID/attemptを照合して戻る。periodic refreshを防止策として有効化しない。


## 9 監視・保存先・使用量・通知

- compact A は小さな resident bar で開始。明示 click だけで開き、完了で勝手に前面表示しない。Light/Dark、always-on-top、hide/tray、draft 保持は [UI-OPERATIONS-USAGE](UI-OPERATIONS-USAGE.md) を参照
- GitHub 配送 repo、実作業 repo、ローカル output root、browser profile、通知先は別。projectId / repoId / storageSlug / 表示名も混同しない
- default/per-project root は共通 registry の新しい revision に保存。受付時の pin は不変。後から保存先を変えても古い成果物を移動・削除しない
- sender archive 完成と requester 完全受領は別。manifest、receipt、必要 artifact bytes の検証と durable save 後だけ signed proof+ACK を返す
- Codex quota は provider-bound / dated な観測。Claude/Antigravity/通常 Chat の残量にはしない。manual/unknown は検証済みにせず、明示した bounded fallback だけを適用する
- Pro counter は Bridge 経由の観測のみ。確認済み/送信した可能性を分け、transport retry や ACK で加算しない。上限/期間/timezone は明示設定で、40 等を固定上限としない
- Email/Discord は利用者ごとの宛先 preference が既定 OFF。現段階は sendingImplemented:false、送信 adapter は未完成。Save で送らず、実送信先/秘密情報をコードへ埋め込まない

```sh
node dist/cli/main.js archive help
node dist/cli/main.js archive settings --state-dir /private/runtime
node dist/cli/main.js archive inspect REQUEST_UUID --state-dir /private/runtime
node dist/cli/main.js archive save REQUEST_UUID --deployment /trusted/recipient.mjs
node dist/cli/main.js archive export REQUEST_UUID --deployment /trusted/recipient.mjs --out /private/export/new-diagnostic.json
```

save は既存結果を保存するだけ。export は新しい sanitized JSON 一個を書き、送信しない。
read/probe/configure の差と requester materialization 設定は [ARCHIVE-USAGE.md](ARCHIVE-USAGE.md)。

## 10 現時点で残る作業

この手順書は実装/合成検証済みの操作と未完成 gate を分ける。最終状況は exact head の試験報告で更新する。

- **未実装:** enforcing native supervisor、Windows authenticated IPC/ACL/reparse/durability providers。guard を true に変えて進めない
- **別枝/統合確認:** Antigravity adapter は draft PR5。対象累積 head に含むか capability とソースを確認する。既存インストールを重複してやり直さない
- **共通の未完成部分:** 任意 issuer agent 向け authenticated tool/capability integration、bootstrap ACK extraction/context-continuity の完全配線、Email/Discord 実送信。短い bootstrap と現実の authority を混同しない
- **実機未検証:** 同じ会話/同じ model の通常 Chat、実 CLI、GitHub 実 roundtrip、描画/DPI/Windows/実 IPC。外部購読や dot/Codex task に置き換えない
- **権限が必要:** 本人 identity、既存 account/route、credential/permission setup、実モデル一回試験、外部共有。コードを読んだだけでは許可されない

# Bridge v2 成果物保存・診断出力

このガイドは PR5 の portable 実装です。実行エンジン・既存 TaskSpec/ResultSpec・作業リポジトリ・GitHub 配送ストアを置き換えません。Windows のネイティブ ACL/reparse/durability 実装、実 Chat / モデル CLI roundtrip は別の完了条件です。コードの fixture 成功を実機成功と扱わないでください。

## 1. 設定と保存先

PR3 と同じ ProjectRegistry を使います。projectId / repoId / immutable storageSlug / 表示名 / 登録配送先 / 出力ルートを別の意味として管理し、表示名からパスを作りません。設定更新は新しい registry revision を作り、過去 revision は保持します。

ジョブの開始点は「不変リクエストの受付」です。モデル起動時ではありません。受付前に request/task/MD、route、actor、project/revision/digest、出力契約、実在ルートの device/inode を永続 pin します。別 DB の write-ahead pin が成功してから台帳受付を行います。途中 crash は inert orphan pin を残すだけで、同じ UUID/hash の再送は同じ pin を使います。旧台帳行に pin が無ければ停止し、現在の設定を使って埋め戻しません。

```text
<output root>/ChatGPT-Bridge/projects/<storageSlug>/requests/<requestUUID>/
  archives/<immutable manifest SHA256>/
    instructions/TaskSpec.json
    instructions/task.md
    results/result.json
    artifacts/artifact-<artifact-ID SHA256>.bin
    manifest.json
  materialized/<materialization receipt SHA256>/
    results/result.json
    results/delivery-manifest.json
    results/delivery-manifest.signed.json
    results/materialization-receipt.json
    artifacts/artifact-<artifact-ID SHA256>.bin
```

ローカル実行の出力は実作業 worktree 内を拒否します。既定とプロジェクト別ルートを変更しても、既存 pin、成果物、GitHub 履歴を自動移動・削除しません。S: / M: は利用者環境の候補例であり、このクラウド検証ではアクセスしていません。

## 2. 明示操作の CLI

Node 22.13 以上、既存の所有者専用 state directory と既存の owned output root が必要です。

```sh
npm run build
node dist/cli/main.js archive help
node dist/cli/main.js archive configure --state-dir /private/runtime --revision 0 --default-root /owned/output --repo my-repo --name "My project" --storage-slug my-project
node dist/cli/main.js archive settings --state-dir /private/runtime
node dist/cli/main.js archive probe --root /owned/output
node dist/cli/main.js archive inspect REQUEST_UUID --state-dir /private/runtime
node dist/cli/main.js archive inspect REQUEST_UUID --state-dir /private/runtime --manifest MANIFEST_SHA256
node dist/cli/main.js archive save REQUEST_UUID --deployment /private/trusted-deployment.mjs
node dist/cli/main.js archive export REQUEST_UUID --deployment /private/trusted-deployment.mjs --out /private/export/diagnostic.json
```

configure は共通の project-registry.db を更新し、出力ルートには書き込みません。probe だけが明示操作として一時ファイルを書いて削除します。read-only settings/inspect は DB を作りません。save は既存の結果だけを保存し、モデル実行や承認を行いません。export は新しい一ファイルの診断 JSON を書き、既存ファイルを上書きせず、アップロードもしません。

旧 artifact-archive-1 の読出しは archive legacy-inspect を明示します。旧形式の保存済みバイトの意味を変更せず、v2 へ自動変換しません。新しい設定では第二の v1 プロジェクト登録を使いません。

## 3. ホスト配線

信頼済み deployment module に既存の authority/executor/store/policy を渡す構成を維持します。新規認証、鍵作成、アカウント接続をこのコードで自動実行しません。

```js
const registry = new ProjectRegistry(join(stateDirectory, "project-registry.db"));
const archive = new RouteArtifactArchive({ stateDirectory, registry });
const localArchive = new LocalRouteArchive(archive, store, {
  recipientActorId: policy.bridgeId,
  sessionId: policy.sessionId,
  executorId: executor.executorId,
});
const deployment = createBridgeDeployment({ ...existingTrustedOptions, artifactArchive: localArchive });
const archiveOperations = createArchiveOperations({ archive, local: deployment.controller, hosted });
return { ...deployment, archiveOperations, close: closeAllOwnedResources };
```

上は配線例です。既存の登録・台帳・ホストライフサイクルを再利用し、変数を利用者環境で勝手に捏造しません。UI はこの同じ archiveOperations に exact operation binding を確認した後で接続します。公開 API に任意パス読出しはありません。

- RouteArtifactArchive: reserve / pin / admission / provenance / inspect / readItem
- LocalRouteArchive + TaskController.archiveResult: local route の保存
- BrowserDeliveryService.archiveResult: hosted route の保存
- createArchiveOperations: CLI/UI の inspect / collect / exportDiagnostics / probe

## 4. 完全性と二つの保存主体

artifact-archive-2 は route、admission/pin、registry revision、append-only 観測 provenance、payload hash、required/optional items、各 hash/size/complete または unavailable reason を保存します。欠損・破損・未取得を complete にしません。ファイルとディレクトリを fsync し、同一 filesystem 上の staging を atomic rename して readback を検証します。元の成果物を上書きしません。

sender-local archive が完成しても requester delivery の完成ではありません。DeliveryMaterializerV1 が、認証済み delivery manifest と exact payload、必要な全 evidence/artifact bytes を取得し、各サイズ/ハッシュ/ルート固有 receipt を検証し、requester の pin 先へ durable save します。その後だけ materialization-receipt-1 を返し、署名 proof と ACK を atomic に公開します。payload-only ACK は完了・依存解除に使えません。

manifest body digest と signed envelope の CAS digest は別です。receipt の deliveryManifestSha256 は canonical manifest BODY の SHA-256、取得アドレスは署名 envelope バイトの SHA-256 です。どちらも保存・検証します。

ConfiguredGitDeliveryContentStoreV1 は destination ID、完全な delivery binding、purpose、artifact ID、content hash ごとの明示 read/publish grant を要求します。保存済み local path や filename は remote delivery の証拠ではありません。raw artifact upload を自動で有効にせず、許可の無い bytes は delivery_pending に保ちます。

## 5. 普通の Chat と過去の返答

HostedResponse を local ResultSpec に変換しません。conversation/user-turn/assistant-turn/artifact ID、task/attempt/frame hash を別 provenance に残し、新しい会話ターンがあっても exact old message を選びます。ID が無い・重複・曖昧・未表示なら unavailable にします。latest reply に置換しません。

送信済み/送信不明の途中エラーは非終端観測として保存し、immutable final result や ACK を作りません。同じ attempt の exact source recovery は再送せずに行います。取得時にモデルが分からなければ unknown/null を維持します。

送信前失敗が submitted=no と確認された場合は、失敗 payload と署名済み受付 output contract だけを materialize できます。user/assistant message ID・生成本文・成功宣言は作りません。contract は hosted_admission_evidence として保存し、requester が同じ raw bytes と受付 pin を検証してから失敗結果の ACK を返します。images/files や source proof が混ざれば矛盾として停止します。

bridge-issued-2 の hosted request は署名済み output-contract-1 と、recipient が事前に認めた expected-output policy の両方が必要です。policy → TaskSpec → exact contract body → issued の順で hash を作り、将来の attempt を受付時に捏造しません。

text_only は「DOM にリンクが見えないからゼロ」ではありません。事前承認されたゼロ契約、正しい frame 内の明示ゼロ宣言、exact source、選択メッセージの contradiction check、requester に保存された source/contract proof の全てが必要です。hosted-source-proof-2 の完全性は bound_output_contract に限定し、global DOM enumeration を unknown から既知に昇格させません。余分な添付・不明 widget・不一致・未取得 bytes は停止します。実 DOM の generated artifact bytes は安定 ID による対応が未対応の場合、明確に unsupported のままです。

## 6. 診断ファイル

明示 export は bridge-diagnostic-2 の一ファイル JSON に README と構造化 metadata を含めます。新しい LLM が会話なしで route、版/環境、観測段階、相関用 ID hash、task hash、run/attempt、registry revision、archive 完全性、payload ACK と十分な materialization の違い、不足情報を確認できます。

含む: 許可済み enum/件数/サイズ/時刻/ハッシュ、synthetic/unknown、固定エラーコード、redaction audit。

除く: 生プロンプト、指示本文、Cookie/token/credential、環境変数、絶対 private path、ファイル名、stdout/stderr/diff 本文、argv、任意 error text。ハッシュは相関可能で、匿名性や実行の真正性を保証しません。診断を共有する行為は別途の利用者判断です。

## 新しい LLM の最初の確認

```text
ARCHIVE-USAGE.md / ARCHIVE-TESTING.md / CONSOLIDATED-DESIGN.md と OUTPUT-CONTRACT-AMENDMENT.md を読む。
既存 repo の exact request UUID、raw task/MD hash、route、run/attempt、registry revision を固定する。
native Windows、実 CLI、実 Chat の結果を fake test や SQLite/fsync 成功から推測しない。
pin/seal の無い旧ジョブ・旧 output contract・payload-only ACK を自動移行しない。
保存/取得/ACK の retry を generation retry に変えない。破損や不足なら同じ UUID で調べる。
実機・認証・Codex task・外部共有は、別途必要な利用者の明示許可を確認してから行う。
```

保存先 pin は受付時 registry snapshot とともに封印します。後から設定を変えた場合も、再取得・保存・materialization はその snapshot の root と digest を照合します。破損した pin や古い unsealed 行に現行設定を自動で当て直すことはありません。

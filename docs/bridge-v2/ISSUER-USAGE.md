# 登録済み issuer CLI の使い方（I1）

この追加は、ホストに登録された範囲で LLM が利用できるローカル CLI の入口です。既存の TaskSpec、MD、GitHub bus、fanout、requester materializer を使います。Claude / Codex / Antigravity の任意の起動に自動でツールを挿入する機能や、呼出元が特定モデルであることの認証は含みません。通常の `bus issue` は従来の運用者向け入口として残ります。

## ホスト側で一度接続するもの

信頼済み deployment の `openDeployment()` が返すオブジェクトに `issuer: createIssuerSession(options)` を追加します。実装は `src/adapters/issuer-session.ts`、構造は `IssuerSessionOptions` です。

- `bus` と `operations` は同じ canonical project registry インスタンスを使う
- `recipe` は UI composer / template と同じ純粋な登録済みレシピ。自由な command policy をモデルから受け取らない
- `session()` はホストが認証・許可した requester、固定 session UUID、有効期限、project / destination の許可範囲を返す。同じ prepare → issue の間は同じ session を使う。入力 JSON から作らない
- `currentDestinations()` は operations と同じ現在の登録を同期的に返す
- `capabilities` は recipient 署名器と、現在の **キャッシュ済み** capability 観測を返す同期ポート。既存の認可された署名器を注入する。CLI は鍵の作成・ログイン・quota refresh を行わない
- `materialize` は既存の `createRequesterMaterialization` 等の具体的な検証・durable 保存経路。未設定なら ACK は不可
- `GitObjectStore.appendConditional` が必要。標準 REST / connector store は対応済み。未対応の独自 store では登録 issuer の publish は拒否される

`session.source` は `configured_local_cli`、`providerObservation` は `unverified` です。これを provider の実際のモデルセッション確認に読み替えないでください。署名は発信者と内容を結び付けますが、起動許可そのものではありません。capability の `issue.available` と `start.available` も別です。

観測の最大 age は既定 30 秒、設定可能な上限 60 秒です。再署名しても observedAt は変えません。観測の失効、未来日時、identity / policy / registry / prompt format の変更は新規 issue を止めます。健康確認等によるキャッシュ更新はホストが別途管理します。

## CLI の固定入口

`/trusted/*.mjs` や例の ID / model は入力用 placeholder です。汎用 issuer の ready-made production module は同梱していません。前節のホスト設定がなければ先に未設定を報告し、テスト署名鍵や広い運用者 CLI へ代用しないでください。

ビルド後、ホストが選んだ絶対パスの deployment を使います。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
node dist/cli/bus.js capabilities
node dist/cli/bus.js --deployment /trusted/bridge-deployment.mjs issuer-catalogue
node dist/cli/bus.js --deployment /trusted/bridge-deployment.mjs issuer-template < template-input.json
node dist/cli/bus.js --deployment /trusted/bridge-deployment.mjs issuer-prepare < prepare-input.json > prepared.json
node dist/cli/bus.js --deployment /trusted/bridge-deployment.mjs issuer-issue < issue-input.json
node dist/cli/bus.js --deployment /trusted/bridge-deployment.mjs issuer-result < result-input.json
node dist/cli/bus.js --deployment /trusted/bridge-deployment.mjs issuer-ack < ack-input.json
```

モデルに渡すラッパーは deployment パスと `issuer-*` の有限集合をホスト側で固定してください。上の運用者 CLI 全体や `--deployment` の自由選択をモデルの許可範囲だとみなさないでください。JSON 入力は最大 1 MiB、stdin 待機は最大 5 秒。任意のファイルパス・URL・署名器・grant・環境変数を入力欄で受け取りません。Windows の deployment loader は native ACL verifier 未実装のため現時点で拒否されます。

### 1. 読取り

catalogue は session / 許可された project / recipient の署名付き capability を返します。template は次の入力です。モデルが複数なら `modelId` を指定します。

```json
{"projectId":"00000000-0000-4000-8000-000000000001","destinationId":"destination-a","modelId":"registered-model"}
```

値は実際の catalogue から選びます。この例の ID やモデル名は synthetic placeholder です。template は `templateOnly:true, executable:false` で、TaskSpec の request_id / task_file_hash を省いた準備用情報です。

### 2. 準備

呼出側は preview / request / 必要なら fanout UUID を一度だけ作り、試行中は保存して使い続けます。1 child の fanoutId は null、2–4 child なら共通 fanout UUID を指定します。UUID は互いに重複不可です。

```json
{
  "identities": {
    "previewId":"00000000-0000-4000-8000-000000000002",
    "requestIds":["00000000-0000-4000-8000-000000000003"],
    "fanoutId":null
  },
  "request": {
    "registryRevision":1,
    "projectId":"00000000-0000-4000-8000-000000000001",
    "destinations":[{"destinationId":"destination-a","modelId":"registered-model"}],
    "title":"Synthetic example",
    "instruction":"Return the approved synthetic answer"
  }
}
```

`issuer-prepare` は既存 recipe で正確な JSON / MD を生成・検証し、署名済み preparation とその SHA-256、preview を返します。準備だけでは GitHub に書きません。`prepared.json` は prompt 等を含むため、ホストの私有領域に保存してください。署名器・鍵・認可情報をモデルに渡す必要はありません。

### 3. 発行・収集

issue-input は返された文字列だけです。

```json
{"signedPreparationBase64":"COPY_THE_EXACT_RETURNED_VALUE"}
```

`issuer-issue` は署名完了後に現在の session / scope / capability / policy / registry / prompt format を再検証し、全 child と同じ preparation を一つの atomic Git commit に載せます。別 destination を指す有効な署名があっても、既存 UUID の preparation を差し替えられません。旧来の preparation なし request への後付けも禁止です。

result-input は同じ signedPreparationBase64 と `requestId`。ack-input はさらに、検証して受け取った terminal event の `payloadSha256` を含めます。`issuer-result` の終了 0 でも `state:"pending"` なら未完了です。ACK に使う hash は terminal event の `payloadSha256` で、task / preparation / Git commit の hash ではありません。ACK は result / receipt / required artifacts の検証と requester 側 durable 保存後にだけ署名・発行します。保存途中、署名待ち中に scope が失効した場合は ACK を出さず、元の request を保存して回復します。

発行応答を失った場合、別 UUID を作らず、同じ preparation と UUID で `issuer-result` を確認してください。未確定を再実行する機能はありません。元の署名済み receipt と公開時の binding は履歴として保持されます。capability の観測期限が切れても、現在有効な同じ requester の scoped session から履歴の result / ACK を回復できます。新しい session は同じモデル会話を意味しません。

## まだ別のゲートであるもの

- general CLI の OS supervisor と Windows IPC / ACL 実装・実機確認
- 実プロバイダとの end-to-end 往復、ログイン・追加課金設定・実行許可
- 各 provider が LLM に公開する具体的なツール接続設定。I1 は configured local CLI facade まで
- bootstrap 確認は [SESSION-BOOTSTRAP.md](SESSION-BOOTSTRAP.md) の advisory 状態。artifact 配送 ACK、実行許可、モデルの理解の証明にはならない

テスト手順は [ISSUER-TESTING.md](ISSUER-TESTING.md)。全体の残課題は [COVERAGE.md](COVERAGE.md)。

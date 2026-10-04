# 公式 SDK による固定テキスト往復の使い方

この経路は、既存の GitHub バスと公式 Claude Agent SDK を使う、1件限定の
合成ハンドシェイクです。作業リポジトリの編集、コマンド実行、添付物生成を依頼する
汎用 TaskExecutor とは別です。モデルは `claude-haiku-4-5-20251001`、最大1ターン、
要求出力512トークン、60秒。SDK0.3.287 / CLI2.1.288 は確認対象の固定組合せです。
実際の接続・推論・Git往復は、実装レビューと必要な許可・認証が揃うまで未検証です。

## 1. 無害な確認

```sh
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm run build
npm test
node dist/cli/main.js sdk-text capabilities
node dist/cli/main.js sdk-text help
```

capabilities/help は設定モジュール、SDK query、認証処理を起動しません。
既にある CLI を使います。CLI の再インストール、ログインやトークン作成は行いません。
Windows はこの版の保存先ACL・プローブ実装の対象外です。Linuxの個人用試験経路であり、
Windows側に残る一般実行基盤の実装を完了したことにはなりません。

## 2. 信頼済みホスト設定

`--deployment /絶対パス/host.mjs` は、ホスト所有の保護された `.mjs` を明示的に選びます。
これはローカルコードの実行選択です。外部の Task JSON、モデル出力、HTTP本文からパスを
選ばせないでください。設定の推移的importも信頼対象です。

実装済みの組立て API:
- `GitHubConnectorStore` + `StdioGitHubConnectorHost`、または既存資格情報プロバイダの
  `GitHubGitStore`。秘密情報をアシスタントへ抽出する必要はありません
- `SignedBusCodec` の登録済み requester/recipient 署名者
- 履歴を保持する `ProjectRegistry`。repoId / projectId / storageSlugを区別する
- `GitHubSdkTextBus` を送信者・受信者ごとに用意し、同一の登録履歴を渡す
- `createSdkTextDeployment({ requesterBus, recipientBus, profile, privateRoot, authority })`

profile は `ClaudeSdkHostProfile` の厳密な形です。既存公式バイナリの絶対パス・SHA256、
既存HOME/configDirectory、空の私有cwd、登録済み主体、ポリシーハッシュ、局所改訂番号、
不透明な認証コンテキストIDを指定します。APIキー、OAuthトークンや任意envを入れません。
この版は観測された `claude.ai` / `firstParty` 経路だけを対象とし、API課金へ切り替えません。
`authority` は正確な request ID/hash/承認者/短い期限を照合するホスト側ポートです。
省略すれば承認不可です。タスク本文は権限を発行できません。

`preflight` は同一profileで公式CLIの version/help/auth status を読むだけです。
設定例はアプリケーションのコード/API定義に合わせて作り、存在しない資格情報を
仮定しないでください。署名者を必要としないメタデータ確認用 `.mjs` は、
`openDeployment()` から `preflight: () => probeClaudeSdkHost(profile)` と `close` のみを
返せます。その限定設定では issue/start 等は利用できません。

```sh
node dist/cli/sdk-text.js --deployment /trusted/metadata-only.mjs preflight
```

loggedIn:false、別アカウント経路、未対応バージョン、profile変更は停止条件です。
新規ログイン・永続権限・署名鍵の作成は、このコマンドの暗黙の機能ではありません。
一時的な試験署名鍵を使う場合も、作成する前に明示的な許可が必要です。
既存の資格情報プロバイダを使う通常運用と、一つのプロセス内だけの試験鍵を混同しません。

## 3. 生成・発行・回収

```sh
node dist/cli/sdk-text.js --deployment /trusted/host.mjs generate product-a > generated.json
```

生成結果の `rawRequest` と `markdown` を、そのまま新しい私有ファイルに保存します。
JSONを手で推測し直さず、`parseTextRequest(raw, markdown)` で検証します。
プレビューは承認ではありません。実行する場合は、同じファイルを固定して使います。

```sh
node dist/cli/sdk-text.js --deployment /trusted/host.mjs trial /private/request.json /private/task.md
```

trial は preflight → 発行 → claim → 承認 → 永続intent → SDK query → 私有証拠の
fsync/readback → Git結果 → 受信側保存 → 署名ACK を結びます。既存intentがあれば
queryを再実行しません。再試行のために generate をやり直して別IDを作らないでください。
認証や署名者を含む一回限りのホスト設定は、全工程で同じプロセスを維持してください。
一時秘密鍵を失った後の署名は復元できません。権限未復元なら配送待ちのままで、再推論しません。

分割操作は help に掲載されています。approve/start/reconcile/cancel には正確な
request hash、collect には正確なresult hashが必要です。statusは読み取り専用です。
`StdioGitHubConnectorHost` を使う場合、ホストは `bridge-github-operation-1` の固定
操作を既存の認可済みGitHubコネクタに転送し、同じIDの `bridge-github-response-1`
として実際の結果を返します。操作を手作業で捏造したり、モデル出力を制御JSONとして
実行しません。これはホスト仲介試験であり、無人単独接続の実証ではありません。

## 4. 結果の読み方

`live_handshake_complete` は、実際の公式SDKアダプタの観測と、署名付き結果・保存・ACKが
揃った場合だけです。偽ポートのテストは `synthetic_roundtrip_complete` になります。
完了とはSDKイテレータ完了です。OSプロセス終了は未観測、子孫終了・サーバ側取消は未検証。
HTTP回数や課金明細を推測しません。エラー/unknownでは同じIDを調査し、再推論しません。

私有 messages.ndjson や認証診断をGitへ上げません。公開側は固定の応答・署名・許可リストの
使用量観測だけです。出力ルートは発行前に固定され、設定変更で古い保存先を移動しません。

個人が未改変CLIを自分の既存契約で利用する試験と、第三者向け認証仲介は別です。
公開製品でClaude.aiログインやトークン収集を提供できるとは解釈しません。
[認証・利用条件](https://code.claude.com/docs/en/legal-and-compliance) と
[SDKの条件](https://code.claude.com/docs/en/agent-sdk/overview#license-and-terms) を確認してください。

## 5. 一回限りのコネクタ仲介設定例

`examples/sdk-text-one-shot.mjs` は、既存バス/台帳/APIを実際に組み立てる例です。
importだけでは何もせず、下記の明示的trialだけで開きます。新しい認証や恒久権限は
作りませんが、実行時には2個の一時署名鍵を生成するため、その作成許可が必要です。
環境変数の文字列は許可を記録するための実行ガードです。利用者の確認を代替しません。

既存認証を使う同一profile、私有Git repo/既存branch/namespace、空の私有cwd、
互いに分けたprivateRootとoutputRootを先に確認します。メタデータ以外の認証情報を
読み出しません。例は新しい私有stateに一度だけ使います。

私有JSON設定の厳密なトップレベルは次の5フィールドです:
- `schema`: `sdk-text-one-shot-configuration-1`
- `profile`: この文書の `ClaudeSdkHostProfile` 全フィールド
- `privateRoot`: 存在する所有者専用stateディレクトリの絶対パス
- `requesterId`: recipientと異なる登録用ID
- `registry`: `bridge-project-registry-1`、revision=1、単一project、defaultOutputRoot設定済み。
  projectはprojectId/repoId/storageSlug/displayName/githubDestination/outputRootOverride=null

profileの実際のbinary SHA/version、HOME/configDirectory、認証コンテキスト、policy hashは
運用者が確認したものだけを設定します。ここにはトークン/パスワード/APIキーを入れません。
新規ログインをする場合は、この同じHOME/configDirectoryで利用者が公式フローを完了します。
SDKをインストールしただけではCLIの認証が引き継がれたことにはなりません。

```sh
BRIDGE_SDK_TRIAL_CONFIG=/private/trial-config.json \
BRIDGE_SDK_TRIAL_APPROVAL=one-haiku-query-and-two-ephemeral-signing-keys \
node dist/cli/sdk-text.js --deployment /absolute/checkout/examples/sdk-text-one-shot.mjs \
trial /private/state/trial-input/request.json /private/state/trial-input/task.md
```

この例は、read-only preflight成功後に鍵作成intentを排他的にfsyncし、2鍵をメモリ内に
生成します。公開鍵、固定request、task.mdは私有trial-inputへ保存します。request/hashを
固定したauthorityだけを作り、同じプロセスで発行からACKまで進めます。stdin/stdoutの
実GitHub操作中継には前節の実応答を使い、最後のtrial reportと操作メッセージを区別します。

`trial-key-intent.json` またはregistry/inputが既にある場合は再生成しません。途中で
プロセスが失われると秘密鍵も失われます。例を再実行して鍵やrequest IDを作り直すことは
回復ではありません。元IDの証拠を調査し、必要な署名権限が失われた場合は配送待ちとします。
失敗時にstateを自動削除しません。私有messagesは保持し、Gitへ送るのは固定検証対象だけです。

試験前に [SDKのCommercial Terms](https://www.anthropic.com/legal/commercial-terms) と
上記認証・利用条件を提示して、個人の既存契約を使う今回の限定試験として確認します。
この例の存在やfakeテスト成功は実行許可やlive成功の証拠ではありません。

## 6. PR13との統合・renderer pin

SDK依存とpackage.jsonの追加は、既存browser rendererのビルド指紋も変更します。
`npm run build` が出力する新しいmanifestを、明示的なホスト登録で使用してください。
旧pinを黙って置換しません。古い既受理ジョブは元のrenderer/policy証拠を保持し、
対応する旧buildがないときは既存のunsupported/no-resend動作を維持します。
SDK追加はTaskSpec、普通Chatのmodel選択、renderer policyの意味を変更しません。

## 生成・一回試験・回復の注意

生成した試験 request の有効期限は 5 分です。設定・必要な許可・認証の確認を先に終えてから generate し、未確定 dispatch を別 ID で隠さないでください。

同梱 `sdk-text-one-shot.mjs` は一回の trial 専用で、終了後に同じ module を使って status/reconcile/collect はできません。後続コマンド用の再利用可能な host とは別です。終了後は元の証拠・UUID/hash を保存し、元の署名権限が利用できなければ ACK は pending/blocked のままにします。マーカー削除、鍵再生成、新規 request、追加 query を回復手順にしないでください。通常の再利用可能な認可済み host なら、既存レコードの読取り・再検証・配送だけを行えます。

## Windows候補計画の純粋API

`planWindowsSdkCandidatePolicy` (`src/adapters/claude-sdk-windows-policy.ts`) は、明示した
`executable` / `cwd` / `home` / `configDirectory` / `systemRoot` / `programFiles` の6パスから
不変の候補データを作ります。filesystem、registry、CLI、SDK、ネットワークを使いません。
Windows実行profileとして登録・接続されておらず、既存Windows停止条件はすべて維持します。

パスは大文字driveから始まるbackslash区切りの正規化済みローカル絶対パスに限定し、
drive-relative、UNC/device、ADS、予約名、末尾dot/space、不正文字、1024文字超を拒否します。
executableは `.exe` 候補です。字面の検証はファイルの存在・同一性・信頼を保証しません。
case/8.3 alias、reparse/hardlink、owner/ACL、空cwdは後続の実機検証事項です。

候補環境は固定制御値と明示パスから作り、`SystemRoot` / `WINDIR` / `USERPROFILE` / `HOME` /
`CLAUDE_CONFIG_DIR` を含みます。任意env、秘密入力field、ambient env継承は受け付けず、PATHも
推測しません。実際のCLI/SDKがこの候補環境で動作するかは未検証です。既存Linux環境とhashは
変更していません。

managed設定の確認対象は、明示programFiles配下の `ClaudeCode`、`managed-settings.json`、
`managed-settings.d`、`managed-mcp.json` とHKLM/HKCUの `SOFTWARE\Policies\ClaudeCode` / `Settings`
です。これは観測対象の一覧で、存在や不在を判定した結果ではありません。
[Windows設定仕様](https://code.claude.com/docs/en/settings) と
[managed設定仕様](https://code.claude.com/docs/en/managed-settings) に基づく候補で、固定CLI版との
一致は後続で確認します。`settingSources: []`でもmanaged設定を無効とみなしません。

`claude-sdk-windows-candidate-policy-1` の `policySha256` は固定順のJSON候補データを識別する
hashです。承認・認証・保存完了・実行可否の証拠には使いません。返却データにはhostパスが
含まれるため私有データとして扱い、そのまま公開ログやGitへ送らないでください。
入力不正時のError.messageは固定codeのみで、入力値を含めません。

候補計画だけではWindows Bridgeは開通しません。私有保存/DBのACL・同一性・永続化、信頼済み
deployment読込、Windows probe、固定SDK/CLI互換性、署名付き全往復は別の実装・受入事項です。
固定経路はCLI2.1.288 / SDK0.3.287を維持し、自動更新・fallback・認証変更を導入しません。

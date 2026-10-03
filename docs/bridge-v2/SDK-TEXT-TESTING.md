# SDK固定テキスト経路の試験手順

## LLM担当者へ渡す短い指示

このリポジトリの固定リビジョンを取得し、SDK-TEXT-USAGE.mdと本書を読んでください。
最初は無料のローカル偽ポート試験だけを実施します。既存CLIの再インストール、認証情報の
抽出、トークン作成、API課金への切替、実機/Codexタスク起動、mergeは行いません。
実際のSDK queryは別の明示的許可と、同一文脈での既存認証・署名・私有Git宛先の確認後だけです。
止まった独自native R3の再試行・再レビュー・実行は、このSDK試験に含みません。

## 固定リビジョンとオフライン検査

PR説明の verified head を使用し、ブランチ先端の変化を混ぜないでください。

```sh
git fetch origin <verified-head>
git checkout --detach <verified-head>
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm run build
npm test
node dist/cli/sdk-text.js capabilities
node dist/cli/sdk-text.js help
cd gui
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm run build
npm test
```

スキップは成功に加算しません。既存ブラウザ環境依存ケースは別記し、新しいSDK試験は
すべて偽SDK/偽ネットワークまたは私有一時ディレクトリで実行します。
SDKパッケージのインストールだけではqueryを呼びません。

重点試験:
- `sdk-text-contracts.test.ts`: SDK独自schema/version/固定上限、native終了証拠の混入拒否
- `claude-sdk-text.test.ts`: 固定options、1 query、自然終了/追加出力、timeout/cancel、遅延終了、
  getter/cycle/depth/巨大値をシリアライズ前に拒否、stderrを保持しない
- `sdk-text-service.test.ts`: 署名付き全往復、別hostのclaim拒否、並列start、Git失敗、
  fsyncクラッシュ回復、停止中preflight、未知intentの再実行禁止、profile履歴
- `sdk-text-cli.test.ts`: 読み取りで起動しない、hash照合、処理完了前にDBを閉じない
- `github-connector-store.test.ts` / `github-connector-stdio.test.ts`: 固定宛先、完全なtree/commit
  証拠、既存ファイル保全、実応答のID対応、遅延/重複/切断、無認証fallbackなし

## 実試験の開始条件

1. この固定headの全実行可能検査と独立実装レビューが完了している
2. 未改変の既存CLI2.1.288・登録SHA256、SDK0.3.287、空の私有cwdを確認した
3. 同一profileの公式auth statusが、承認された既存 `claude.ai` / `firstParty` を示す
4. 私有バスrepo/branch/namespace・登録製品・保存ルート・主体が承認内容と一致する
5. 署名者を準備済み。一時Ed25519鍵を使うなら、その一回限りの作成を事前承認済み
6. 正確な固定request.json/task.mdと「合成Haiku1件」の実行許可が揃う

未設定項目を偽値やreadyフラグで通さないでください。認証変更が必要ならそこで止めます。
SDK/CLIのこの固定組合せは実試験で互換性を確認する候補です。先行する実成功が必要という
循環条件はありませんが、未レビューの別バージョンへ自動更新・fallbackしてはいけません。

## 実際に行う順序と期待値

- capabilities/helpを確認。モデル呼出し0件
- preflightを実施。モデル呼出し0件。私有認証詳細は出力・転載しない
- 同一プロセスの信頼済み設定から、固定ファイルで `trial` を1回呼ぶ
- 仲介方式ならBridgeの操作を実コネクタへ正確に転送。手製の結果/ACKは作らない
- 結果は同じrequest/attempt/hash、実際のHaikuモデル、許可されたSDK観測を示す
- Git結果を受信側が署名/全固定ファイルhashで検証し、保存・readback後にACKする
- 再利用可能な trusted deployment では同じ ID/hash で status/reconcile/collect を確認し、追加 query が 0 件であることを確かめる。一回限りの sdk-text-one-shot.mjs は trial 専用で、終了後の status/reconcile/collect には使えない。終了/切断後は元の私有証拠と公開済み ID/hash を保持する。再実行・新規鍵・新規 ID で回復を偽装せず、元の署名権限を使う認可済み回復 host がなければ配送待ち/blocked として返す

異常時は別IDを生成せず、unknownを保存してください。停止要求はSDKへの要求であり、OSの
確実な終了とは報告しません。SDK iteratorが未決なら所有権を保持し、DB closeも失敗を
見える形で返します。結果配送/ACK失敗は同じ記録の回復だけを行います。

## 返すレポート

```json
{
  "releaseHead": "<verified head>",
  "environment": "own-cloud Linux",
  "checks": {"rootPassed": 0, "rootSkipped": 0, "guiPassed": 0},
  "phase": "blocked | synthetic_roundtrip_complete | live_handshake_complete",
  "requestId": "<UUID>",
  "requestSha256": "<hash>",
  "attemptId": "<UUID or null>",
  "requestCommit": "<commit or null>",
  "resultObservedCommit": "<commit or null>",
  "resultSha256": "<hash or null>",
  "ackCommit": "<commit or null>",
  "bundleSha256": "<hash or null>",
  "sdkVersion": "0.3.287",
  "cliVersion": "2.1.288",
  "actualModel": "<observed model or null>",
  "bridgeSdkQueryInvocations": 0,
  "providerHttpRequests": "unknown",
  "osProcessExit": "unobserved",
  "reexecuted": false,
  "blocker": "<exact sanitized code or null>"
}
```

開始・終了時刻、実行コマンド、検査ログの場所を付けてください。Gitには生SDKメッセージ、
stderr、HOMEパス、アカウント表示、秘密情報を添付しません。必要な失敗証拠は私有領域に保持し、
正確なID/hashと許可リスト化したコードだけを報告します。この試験の成功だけで普通Chatの
実往復、Windows一般実行、全体の最終PR受入れを完了扱いにしません。

## Compiled CLI lifecycle regression

`npm run build && npm run test:sdk-cli-lifecycle` executes both compiled entrypoints
against an inert synthetic deployment. It checks pending-drain ownership, SIGINT,
and SIGTERM (six cases). It does not import or invoke a provider SDK. The CLI retains
the same runtime, stop handlers and a keepalive throughout dispatch and drain;
`drain_pending` never recreates the runtime or retries inference. Separate CLI
cancellation is observed by the original owner every 200 ms while its iterator
lease remains active. OS termination/server cancellation remains unverified.

Startup cancellation also spans trusted-module path checks/import/factory invocation.
The SDK CLI supplies an optional host AbortSignal; the loader checks it before import
and before invoking the factory. Legacy callers without the option still call the
factory with zero arguments. The one-shot example checks it before work and after its
initial probe, before any signing-key intent or key creation. In-probe process signals
are observed as well. `deployment-startup.test.ts` and the mocked example tests exercise
these timings without operational keys, login or provider execution.

# Issuer I1 / bootstrap B1 テスト手順

固定 commit は対象 draft PR の verified head を使います。一般用途 native runtime / Windows / 実際の CLI 認証や推論をこのテストの成功条件に含めません。現実の経路を確認する前に、その実行先・モデル・回数・課金・認証について別途承認を得てください。

## 全ローカルチェック

```sh
npm ci
npm run typecheck
npm run lint
npm run build
npm test
node scripts/test-issuer-cli.mjs
npm run test:sdk-cli-lifecycle
cd gui
npm ci
npm run typecheck
npm run lint
npm run build
npm test
```

ビルドは既存の renderer build manifest を作ります。生成物が変わった場合、旧 profile pin と同じものとして自動採用しません。`npm test` の inherited browser/live skip は表示を残し、実行したと報告しないでください。issuer / bootstrap の追加テストには環境依存 skip はありません。

## 重点テスト

```sh
node node_modules/vitest/vitest.mjs run \
  tests/unit/issuer-session.test.ts \
  tests/unit/issuer-cli.test.ts \
  tests/unit/issuer-delivery.test.ts \
  tests/unit/conditional-git-append.test.ts \
  tests/unit/issuer-boundary-regressions.test.ts \
  tests/unit/issuer-usage-composition.test.ts \
  tests/unit/cli-broker.test.ts \
  tests/unit/session-bootstrap.test.ts
```

- recipient 役割の署名、requester と現在の session scope の固定、project 情報の範囲外非開示
- 古い観測の再署名で日時が更新されない、未来 / 失効 / policy / model / registry / prompt drift で無発行
- shared recipe の exact JSON / MD、固定 UUID、fanout の atomic preparation 同梱
- 同じ TaskSpec でも別 destination の receipt に置換不可。legacy request への receipt 後付け不可
- CAS 再試行ごとの binding 再検証、競合 append の保持、失われた ref 更新応答、同じ request の回復
- 正確な requester / task / terminal hash に限定した result、materializer なしの ACK 拒否、保存後・署名前後の session 失効で ACK を出さない
- compiled bus.js が有限入口を呼び、成功・入力失敗とも同じ deployment を閉じる。起動・終了の例外も有限コードへ伏せ、owned counter の終了失敗でも deployment の cleanup を試みる。fake ports のみで、provider / signer / network は起動しない
- B1 は terminal-first の保存、hash 検証済み cached response のみを読む。advisory sidecar の失敗や消失は terminal を書き換えず、起動の繰返し・challenge 再生成を起こさない
- fenced / quoted / HTML / nested ACK、重複・不正・別 identity は advisory 確認にならない。診断理由は有限コードのみ

`issuer-delivery.test.ts` の materializer は合成 fixture です。実際の fsync / archive2 / requester bundle の検証は既存 archive / materializer suite が担当します。compiled tests の子プロセスは Node の inert fixture だけです。実モデルや停止済み native R3 は使いません。

## 回帰時の出力

commit / Node・OS / 実行 command / 開始終了時刻 / passed・failed・skipped 件数 / 失敗 test 名 / 再現手順を保存します。prompt、署名キー、認証情報、raw SDK stream を公開 PR や diagnostics に貼らないでください。

例：

```json
{
  "commit":"EXACT_VERIFIED_HEAD",
  "suite":"issuer-bootstrap-offline",
  "commands":["npm run typecheck","npm test","node scripts/test-issuer-cli.mjs"],
  "tests":{"passed":0,"failed":0,"skipped":0},
  "providerCalls":0,
  "nativeExecution":false,
  "windowsVerified":false,
  "failureCodes":[]
}
```

0 は記入用です。実行結果で置き換え、未実行を成功にしないでください。失敗したら同じ synthetic fixture を直して再検証します。通信の unknown を解消するために provider を再起動することはしません。

# テスト手順書: 固定コミットの実装確認と実機引継ぎ

[USAGE.md](USAGE.md) は操作手順。本書は検査担当の手順と返却物。
「fake で通った」「実ブラウザで通った」「Windows で通った」「実モデルで通った」を分ける。
実装不足を「実機テストだけ残った」と言い換えない。ゼロ不具合を保証する検査ではない。

## 1 入力と禁止事項

必要な入力は、レビュー対象の **40桁の固定 head SHA**、許可された checkout、Node バージョン。
PR の最終報告にある SHA を使用。既定 main や途中の PR head を勝手に代用しない。

```powershell
git status --short
git rev-parse HEAD
node --version
npm --version
```

作業前に変更済みファイルがある場合、上書きせず報告する。今回は model CLI、login、鍵/permission
作成、外部 task 購読、merge/deploy、課金経路切替を実行しない。必要なら別途具体的に確認する。

## 2 A: 全 portable 検査

依存関係の準備後、LLM 担当は次の固定スクリプトでも実行できる。モデル/認証/GitHub書込みは起動しない。

```powershell
node scripts/verify-bridge-v2.mjs --strict
```

結果は新しい `runtime/verification/<timestamp>/report.json` と command 別ログ。
終了 0=全検査成功かつ skipなし、1=失敗/実行block、2=strictでskip残存。
既存 evidence directory は上書きしない。`.sourceHead` と `.dirty` を確認し、汚れたcheckoutの結果を
公開済みcommitの検証と誤認しない。cloudで56 browser skipが残る場合はstrictの終了2が正しい。


ルートで実行。ログは checkout 外または未追跡のローカル検査 directory に保存する。

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck 2>&1 | Tee-Object typecheck.log
npm run lint 2>&1 | Tee-Object lint.log
npm run build 2>&1 | Tee-Object build.log
npm test 2>&1 | Tee-Object tests.log
node dist/cli/main.js task capabilities
node dist/cli/bus.js capabilities
```

GUI も省略しない:

```powershell
cd gui
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck 2>&1 | Tee-Object gui-typecheck.log
npm run lint 2>&1 | Tee-Object gui-lint.log
npm run build 2>&1 | Tee-Object gui-build.log
npm test 2>&1 | Tee-Object gui-tests.log
cd ..
```

期待: runnable な typecheck/lint/build/unit/GUI checks はすべて終了 0。
ブラウザ fixture の skipped 数は必ず別記する。56 skipped は56件成功ではない。
`--ignore-scripts` では Electron binary の setup は行わないので、GUIの native 起動成功とは別。
既存のブラウザ fixture はインストール済み Chrome または Playwright Chromium が必要。

追加アダプターだけを再現する場合:

```powershell
npm test -- tests/unit/github-transport.test.ts tests/unit/browser-delivery.test.ts tests/unit/codex-quota.test.ts tests/unit/local-authority.test.ts tests/unit/deployment.test.ts tests/unit/deployment-loader.test.ts tests/unit/bus-cli.test.ts tests/unit/cli-broker.test.ts tests/unit/cli-isolation.test.ts tests/unit/cli-rpc.test.ts tests/unit/adapter-security-review.test.ts tests/unit/ui-deployment.test.ts
```

実際のファイル名は `tests/unit/cli-*.test.ts` を確認する。存在しない test file を無視して
成功扱いしない。独立 review の14件も `adapter-security-review.test.ts` に保存されている。

## 3 B: UI とブラウザ fixture の実機確認

モデルを使わない demo から始める:

```powershell
node dist/cli/main.js ui --profile demo
```

[UI-TESTING.md](UI-TESTING.md) に沿って次を確認し、合成データだけの screenshot を残す。

1. Dock の情報密度、詳細画面、DPI 100/125/150/200%、複数 monitor、画面端での配置
2. 合成タスク作成 → 承認 → 開始 → 成功/失敗/unknown → ACK
3. 連打、開始中のキャンセル、戻る/進む、詳細閉鎖/再表示、接続断、server restart
4. request ID、hash、結果 revision、受領済み表示が巻き戻らない
5. default production で未設定の承認/実行が本当に無効。legacy browser-chat 項目が残っている
6. unauthorized Origin/Host/token で API に到達できない。private URL/token をログや screenshot に残さない

fixture tier:

```powershell
npm run test:fixture 2>&1 | Tee-Object browser-fixtures.log
```

期待: 実ブラウザが使える実機では browser fixture が実行される。skipped は不足として返す。
cloud Linux では installed Chromium の起動を実際に試し、singleton socket の `EPERM` で停止した。
このため今回は実描画・56 fixture・native IPC を成功とはしていない。ガードや assertion を消して
緑にしない。ネットワーク認証回避や security warning の bypass は行わない。

## 4 C: IPC と native supervisor

Unix の許可されたホストだけで、明示的な実 IPC suite を実行:

```sh
npx vitest run --config tests/unit/cli-ipc.vitest.ts
```

これは default fake suite の代わりではない。cloud では Unix socket bind が `EPERM`。
同じ実行環境で失敗を skipped に書き換えていない。Windows named-pipe はまだ実装不足。

**実 Claude/Codex TaskSpec の実行試験は現在開始しない。**
[PLATFORM-GAPS.md](PLATFORM-GAPS.md) と [CLI-EXECUTOR.md](CLI-EXECUTOR.md) の未実装部分を先に埋める。
Job Object、AppContainer、CLI permission flag だけで exact path/argv/max-runs/network の保証を
満たしたと判断しない。能力 manifest を手で true にして進めない。

ネイティブ実装後の必須証拠:

- 未許可 read/write、command ID/argv/cwd/hash のすり替え、回数超過が OS/mediator で拒否される
- junction/reparse/hardlink/ADS/8.3/case/path replacement による escape がない
- cancel-before-start / during-spawn / after-start / controller disconnect の同じ run が再実行されない
- timeout と broker crash で descendants 全体の停止証明が得られる。PID reuse が別 process を消さない
- named pipe の他 principal/impersonation、台帳改ざん、credential 読取りが拒否される
- provider control-plane と task network が分離され、子プロセスへ provider secret が渡らない
- exact command/log/artifact/diff/evaluator/process の evidence が receipt に入り、偽 result を拒否する

## 5 D: 許可後の最小 live 一往復

portable と native の該当 gate が通り、対象 repo/branch/actor/host/account/conversation、最大1回、
期限、返す情報、必要権限についてユーザーの承認を得た後だけ実行する。
通常 Chat の hosted-response 試験は local-executor sandbox の成功証明とは分ける。

最初は合成 MD「この request UUID をそのまま返してください」のような非機密・無変更の入力。
GitHub `issue` → recipient `tick` → exact hash 承認 → start → result read → explicit ACK → recipient
`tick` を [USAGE.md](USAGE.md) の実 command で1回だけ行う。

合格条件:

1. request JSON/MD の raw SHA-256 と固定 commit が一致し、別 host の claim が取れない
2. receipt/start/result/ACK の UUID/hash/run/fence/payload が一致する
3. transport retry で model start/Chat send が増えない
4. requester が payload hash を受理する前は pending delivery のまま
5. quota 読取失敗は unknown と別記され、結果再実行や result bytes の変更がない
6. 通常 Chat は指定された同じ conversation に入り、hosted-response として戻る。別surfaceや
   APIに落とさない。認証ブロック・不明なら元の ID のまま止める

失敗時は新 UUID を発行しない。元の status/receipt/process/claim を保存して診断へ戻る。

## 6 Codex に渡す実装・修正依頼

以下の FIXED_HEAD を確認済み SHA へ置換して使う:

> nuts-kinoco/ChatGPT-Post の FIXED_HEAD を対象にしてください。docs/bridge-v2/USAGE.md、TESTING.md、ADAPTERS.md、PLATFORM-GAPS.md を読んで、現在の未実装と未検証を分けて報告してください。まず portable 全チェックと GUI 全チェックを実行し、失敗は原因を特定して最小修正し、影響範囲と全体を再テストしてください。spec/hash/approval/dedupe/fencing/cancel/ACK を弱めないでください。Windows supervisor は正式 API と adversarial evidence に基づき実装し、欠ける保証は fail closed のままにしてください。live model、login、credentials、権限設定、購読、merge/deploy は別途の明示承認があるまで実行しないでください。最終 commit、変更理由、各 command の終了値、passed/failed/skipped/blocked、再現手順とログを返してください。

## 7 Claude に渡す独立レビュー依頼

Claude を使う初回は、ユーザーが普段の許可された環境でこのプロンプトを渡す。
この文書は追加の Claude subprocess、別アカウントや別課金経路を勝手に起動する指示ではない。

> FIXED_HEAD の差分を独立レビューしてください。先に docs/bridge-v2/ADAPTERS.md、TESTING.md、PLATFORM-GAPS.md を読み、既存の完成主張を信用せずコードを追ってください。承認/署名/二重実行/unknown/cancel/deadline/結果改ざん/ACK/課金経路/Windows隔離の P0-P2 を優先し、各指摘に file:line、具体的な発火条件、影響、合成再現テストを付けてください。tests/unit/adapter-security-review.test.ts と関連 unit/GUI tests を実行してください。修正を実装者へ返すまで自分で設計を弱めないでください。live model/Windows security setup/credential/merge は行わず、必要な実機検証は正確な手順と期待する証拠で返してください。指摘なしでも未検証の範囲を残し、ゼロ不具合とは断言しないでください。

推奨分担は Codex が実装・修正、Claude が一度の独立監査と修正後の重点再検査。
同じ大きな実装を両方へ何度も投げ直さず、commit と指摘 ID を固定する。

## 8 ユーザーから返してほしい情報

- 対象 repository / exact HEAD / dirty tree の有無
- OS build、Node/npm、Chrome/Electron、CLI version（version 確認自体の許可がある場合）
- 各 command、開始/終了時刻、exit code、passed/failed/skipped/blocked 件数
- 失敗した test 名と最初の error/stack、修正前後の差分、再現最小入力
- 合成 request UUID、task/MD/result SHA-256、GitHub immutable commit、run/fence/receipt/ACK の対応
- UI screenshot は合成データのみ。token fragment、私的会話、profile path 等を必要に応じて除去
- native 試験は denied/allowed operation、actual binary hash、process creation identity、Job 全停止証拠
- 判断: pass / fail / blocked / not run を分け、次に必要な権限または不足コードを一文で

送らない物: password、API/OAuth token、signing key、browser cookie/profile、個人 account 全ログ、
未編集の私的 task DB。調査に必要な最小の sanitized 抜粋だけ返す。

## 9 構造化返却例

以下は形式例であり、実測値ではない。モデルは取得できなかった項目を null / not_run にする。

```json
{
  "repository": "nuts-kinoco/ChatGPT-Post",
  "head": "REPLACE_WITH_VERIFIED_40_HEX_HEAD",
  "dirty": false,
  "role": "codex-implementation-or-claude-review",
  "portable": {"state": "passed", "report": "report.json", "failed": 0, "skipped": 0},
  "ui_rendering": {"state": "not_run", "evidence": []},
  "normal_chat_roundtrip": {"state": "not_run", "request_id": null, "request_commit": null, "result_commit": null, "task_sha256": null, "payload_sha256": null, "ack_commit": null},
  "cli_roundtrip": {"state": "blocked_missing_supervisor", "request_id": null, "run_id": null, "fence": null, "receipt": null, "ack_commit": null},
  "findings": [],
  "missing_code": [],
  "user_intervention_required": [],
  "final_pr_acceptance": false
}
```

最終PRの合格には、通常ChatとCLIの **両方の実際の一往復** の一致する証拠が必要。portable/fake
だけでは final_pr_acceptance を true にしない。ユーザー本人に手作業テストを丸投げせず、Codex/Claude
担当が手順を実行・報告し、login/権限の承認など本人にしかできない地点だけ具体的に引き渡す。

# Bridge v2 成果物保存の検証

## 実行手順

```sh
npm run typecheck
npm run lint
npm run build
npx vitest run tests/unit/artifact-archive.test.ts tests/unit/route-archive.test.ts tests/unit/archive-integration.test.ts tests/unit/hosted-source.test.ts tests/unit/hosted-archive-integration.test.ts tests/unit/output-contract.test.ts tests/unit/output-evidence.test.ts tests/unit/archive-content-store.test.ts tests/unit/delivery-materializer.test.ts tests/unit/materialization-store.test.ts tests/unit/delivery-payload-verifiers.test.ts tests/unit/archive-delivery-roundtrip.test.ts tests/unit/archive-diagnostics.test.ts tests/unit/route-diagnostics.test.ts tests/unit/archive-error-secrecy.test.ts tests/unit/hosted-no-send-roundtrip.test.ts
npm test
cd gui
npm run typecheck
npm run lint
npm run build
npm test
```

件数・ファイル hash・チェック日時は固定 checkpoint の ARCHIVE-VERIFICATION.json を参照してください。作業中のファイルと報告済み checkpoint を混ぜません。

## 実際に検証する境界

- real: private temp filesystem、所有権/モード/link 検査、SQLite/WAL/FULL、immutable admission/receipt、SHA-256、Ed25519 署名、file/directory fsync、readback、CLI 関数、loopback API
- synthetic: Git object store / provider / model / rendered DOM snapshot / 一部のエラー注入。署名テスト鍵は fixture 内だけのもの
- simulated faults: EACCES / EPERM / EROFS / ENOSPC / fsync error / unavailable drive / late store response
- not run: 利用者 PC、S:/M:、Windows native ACL/reparse、実 Chat/モデル CLI、実 GitHub artifact upload、実通知、認証変更、実 provider quota

全体の既存 browser fixture/live suite には 56 件の skip 条件があります。PR5 追加テストに skip を足して失敗を隠しません。「全件実機/E2E 合格」と表現しません。

## 主な受入条件

1. 共通 registry の historical revision/hash、project/slug、root identity を受付前に pin。設定変更・crash orphan・同じ UUID retry で変更されない。旧 unpinned replay は停止
2. 作業 worktree と成果物の分離。symlink/ancestor link/hard link/不正所有権/Windows 予約名/escape を拒否。Windows は未実装の native storage を boolean で検証済みにしない
3. per-file と directory fsync、atomic staged publication、衝突/partial/missing/hash mismatch/切断/readonly/容量不足の各ケースで false complete を作らない。古い manifest と内容は上書きしない
4. local before-start cancellation は TaskStore evidence を使い、executor evidence と区別する。archive/ACK retry は start を増やさない
5. hosted unknown submission は非終端観測。後の exact old reply から同じ attempt を復旧し、新しい reply を代用しない。revision/CAS が stale update を拒否
6. bound output contract の版/署名/expected scope/actor/destination/registry を確認。raw-byte hash、宣言位置/重複/quoted/fenced、logical output set、MIME/size/hash/cap を確認。global enumeration unknown はそのまま
7. requester が exact result と全 required evidence/artifact bytes を本当に読み、hash/size/route receipt を検証し、durable save してから proof+ACK を作る。参照だけ、read 権限なし、missing materializer、空 artifact set だけでは認めない
8. 独立した read/publish CAS grant が全 binding/purpose/artifact/hash/destination を固定。default deny、corrupt/collision/timeout/late-write は明示状態。勝手な再実行・追加 upload なし
9. 診断 JSON は self-contained README/route/provenance/ACK/manifest/不足項目を含み、private prompt/path/name/token/cookie/任意 error を除く。未知 field、getter/proxy、過大/深い入力を拒否し、安定 hash を検証

## 統合テストの正しい読み方

archive-delivery-roundtrip は real Ed25519 と SQLite/fsync-backed requester files を使います。Git transport は MemoryGit、モデル実行は無しです。正しい proof が来る前は core の full-delivery/dependency gate が閉じ、byte permission が無ければ ACK が存在しないことを確認します。これは actual-byte portable integration の合格であり、実ネットワークや実モデル roundtrip の合格ではありません。

hosted-source の Page-backed adapter は既存の認可された DOM だけを読みます。現在のテストは fake Page/snapshot で、実サイトの selector/表示遅延/仮想化/ダウンロード対応を保証しません。未表示 old turn、source ID 不明、未対応 artifact bytes は unavailable/unsupported です。

## 独立レビューと実機ゲート

固定 manifest の source bytes を独立レビューした後、影響テストと全体チェックを再実行します。実 Windows/native confinement、実 CLI、普通の Chat の二経路 request→result→verified materialization→ACK は別途、固定 head と明示承認で検証します。source/fake pass だけで本番接続・公開・merge・deploy を自動実行しません。

## 独立レビューの回帰テスト

初回レビューで見つかった 8 項目と、再レビューの no-send 互換性について、元の adversarial assertion を保存し、修正後に再実行します。

- pin JSON の root/path/device/inode の書換えを sealed digest と受付時 registry snapshot/hash の両方で拒否。同じ request の reserve retry でも再検証。seal の無い旧行は自動補完しない
- run UUID/fencing token が割当済みで supervisor が no-launch を証明した receipt は有効。run=null の受付前 TaskStore evidence と同じ 3-field JSON を強制しない。いずれも署名済み binding と実 bytes/hash は必須
- exact raw framed source、保存した body、公開 markdown、request/task/attempt/hash の完全一致を検査
- rename 後の ancestor fsync 失敗からの retry は files、subdirectories、pinned root まで全 barrier を再実行
- 遅い失敗 collection が新しい complete manifest を incomplete に戻せない。commit transaction 中に immutable payload/item/source set を再検査
- requester persistence が admission に pin された exact output-contract digest と historical policy/conversation/registry/destination tuple を照合
- result.images/files にあるが exact source ID に対応しない項目を text-only zero proof から黙って除かない。mapping 未対応は unsupported
- CLI に dependency の任意 Error.message や任意 ArchiveError.code を出さない。固定語彙以外は generic code、cleanup error も固定 code

初回 checkpoint は保持し、修正版は別の固定 manifest として再レビューします。これらは cloud の一時ファイルと fake provider を使う検証であり、実 provider/Windows の合格ではありません。

再レビュー追加条件: hosted の verified pre-submit failure は admitted output contract のみを証拠として requester に保存し、user/assistant ID を捏造せず proof+ACK まで到達する。generated images/files/source/body、submitted unknown/yes はこの分岐を通過しない。contract byte が取得できなければ ACK は存在しない。

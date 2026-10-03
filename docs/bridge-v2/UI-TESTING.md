# Bridge v2 UI テスト手順

用途: この表示UIの固定コミットを更新・ビルドしたあと、LLM または人間が同じ手順と期待値で確認するためのチェックリストです。使い方は [UI-USAGE.md](UI-USAGE.md)。表示UIのAPI試験と、未設定の本番実行アダプターの試験を混同しません。

## A. 開始条件と記録

1. このPR説明の **Verified head** を `$ExpectedCommit` に設定し、その SHA を checkout
2. `git rev-parse HEAD` が一致すること、作業ツリーの変更がないことを確認
3. OS、Node/npm、Chrome/Electron、時刻、コマンドと終了コードを記録
4. 試験用のローカル runtime を使用。実データ、個人情報、API キー、認証情報を TaskSpec/MD に入れない
5. UI トークン付き起動 URL は記録やスクリーンショットに含めない

```powershell
$ExpectedCommit = '<このPR description: Verified head>'
git fetch origin
git switch --detach $ExpectedCommit
if ((git rev-parse HEAD) -ne $ExpectedCommit) { throw 'Commit mismatch' }
git status --short
node --version
npm --version
$env:CHATGPT_BRIDGE_RUNTIME_DIR = Join-Path $env:TEMP ('bridge-v2-ui-test-' + [guid]::NewGuid())
npm ci
npm run typecheck
npm run lint
npm run build
npm test
cd gui
npm ci
npm run typecheck
npm run lint
npm run build
npm test
cd ..
```

期待値: 全 runnable test が成功し、各コマンド終了コードが 0。ブラウザ未導入で fixture が skip になった場合、**ブラウザ回帰は未実行**として別欄に記録します。成功数だけで完了としません。Windows 固有の junction/プロセス/NTFS 検証も別に結果を記録します。

## B. 製品 entrypoint

| 操作 | 期待結果 |
|---|---|
| production の `gui/ npm start` | 440×46バー。明示的な展開だけで同じ440×604外枠へ。合成完了カードなし |
| ドックの「詳細」 | 同じローカルサーバーの詳細画面。初回は指定 UUID、再表示は既存の選択と下書きを維持 |
| 大画面、狭い画面、200%表示 | 横幅超過/文字切れなし。対のカード・操作幅が揃う |
| ドックを移動、隠す、トレイ再表示 | 操作可能な位置へ表示。余分なサーバー/実行を作らない |
| トレイ「従来のブラウザチャット」 | 旧画面が開く。v2結果と混ざらない |
| アプリ終了・再起動 | 受理済み台帳/ACKが保持される。新しい認証トークンを使う |
| `npm run ui` | 同じ製品詳細画面をブラウザで操作できる |

ブラウザ表示が環境制約で確認できなかった場合は、その制約・確認不能な項目を明記します。規制されたブラウザ起動を別の経路で回避しません。

## C. デモの実配線を確認

`npm run ui:demo` または `CHATGPT_BRIDGE_UI_PROFILE=demo` で Electron を起動します。明確な合成デモ表示を確認します。各シナリオは新しい UUID を使い、テスト間で勝手に台帳を消さないでください。unknown/中断はセッション全体を保留するため、項目8と9はそれぞれ別の新しい試験用 runtime で最後に実行します。元の台帳は証跡として保持し、保留を消して続行しないでください。

1. 新しいデモ依頼を作る → awaiting_approval と受信 ACK。再読み込みしても同じ UUID/ハッシュ
2. 検証と承認 → inspected JSON/MD のハッシュに一致する detached grant。承認だけで実行中にならない
3. 開始 → 1つの run ID / fencing token / 開始意図。連続クリック/再読込で二重実行しない
4. 成功を合成観測 → synthetic=true の終端結果と終端イベント。合成結果の公開 receipt は null のまま（実行証明として発行しない）。結果 ACK 前は未受領
5. 結果 ACK → 同じ event ID / payload hash の受領を保存。ACK 再送で結果や成功判定は変わらない
6. 別の依頼で失敗を合成観測 → failed。成功として表示しない
7. 別の依頼を開始して停止 → 停止意図と証跡を確認。単なるリクエスト送信を停止完了にしない
8. 別の依頼で unknown を合成観測 → 開始不可。照合しても証跡がなければ unknown のまま
9. 開始中にサーバー終了・再起動 → run ID/開始意図が残る。再実行されず、観測不明を表示
10. 新規入力のJSONまたはMDを変更 → 古い承認を転用しない。既存 UUID + 異なる内容は conflict、元の記録を維持
11. 同じ UUID + 同じ生バイトを再受理 → 既存記録を返し、受信/実行を増やさない
12. 通信切断後に操作 → 不明な操作を自動再送しない。明示の読取更新で台帳を確認
13. 一覧を素早く切り替える → 古い通信応答で新しい選択や未送信の入力を上書きしない
14. 入力ダイアログをキャンセル/閉じる → 送信されない。新しい依頼を勝手に作らない

## D. production の fail-closed

- demo 環境変数を削除して起動する。デモの台帳は表示しない
- `validate` は schema・duplicate JSON key・正確な MD hash を確認する
- `import` は実行せず immutable record を保存する。payload内の許可記述は実行権限にならない
- 未設定の approve/start/cancel/reconcile は API でも拒否。UI は具体的な理由を表示
- TaskSpec の任意パス/コマンドを API サーバー自身が読み/実行しない
- provider 利用枠/課金/モデルの実機検証を取得していなければ不明と表示
- このUIの認証済み依頼者に属する正式な終端結果がある場合のみ、表示した payload に結びつく ACK を受理。別の受取人の ACK を代理発行しない

## E. API とセキュリティの自動試験

`tests/unit/ui-server.test.ts` と `ui-service.test.ts` が実 HTTP/SQLite を用いて確認します。

- 127.0.0.1 専用。別 Host、外部 Origin、cross-site、認証なし/違うtokenの API は拒否
- URL query に token を置かない。CORS は許可しない。read API も Bearer 認証必須
- 静的ファイルは allowlist。`../`、エンコードされた traversal、任意ルート、任意ファイル取得を拒否
- JSON content-type/サイズ上限/schema/additionalProperties/duplicate key の検証
- CSP と nosniff、no-store、no-referrer。タスク内容を HTML として挿入しない
- ハッシュ/観測番号の不一致、古い開始/承認、ACK payload 改変、同一 ID 競合、永続化、再起動、unknown
- GUI は sandbox/contextIsolation を有効化し、v2ページへ旧 privileged preload を渡さない。任意リンク/新規ウィンドウ/許可要求を拒否

## F. 失敗時の扱い

- テスト失敗はそのまま記録し、skipや期待値緩和で隠さない
- unknown、DB破損、ハッシュ不一致は fail closed。run ID/UUIDを保存し、手動で状態を書き換えない
- ポート使用中: 新しいポートまたは既定の動的ポートで起動。同じ台帳で二重起動を意図的にしない
- 最終報告には固定 SHA、各 suite の passed/failed/skipped、実表示の確認範囲、Windows固有未検証、未設定アダプターを分ける
- この手順を完了しても、Claude/Codex 実機実行、料金/利用枠の取得、Windows confinement、GitHub roundtrip の成功証明にはならない。該当統合の手順書を追加して別に確認する

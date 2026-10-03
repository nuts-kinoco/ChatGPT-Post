# Bridge v2 UI 使い方

この文書はPR3上に積むA案の製品UI用です。表示設定の詳細は [UI-PRESENTATION.md](UI-PRESENTATION.md) を参照します。`gui/` の起動後に表示する UI と、`ui` コマンドのブラウザ UI は同じ実装を使います。静的モックを開く手順ではありません。

## 1. 更新する前に

- この表示UIは PR1 → PR2 → PR3 の上に積む下書きPRです。PR3の固定headは `a1ed5427379b37167db839bbc1d19d52e22afafd` です。マージは別途承認が必要です
- PR の説明にある **Verified head** の 40 桁 SHA を記録し、その固定コミットで確認します。実行中に別ブランチへ切り替えないでください
- Node.js 22.13 以上が必要です。クラウド検証は Node 24 で行っています
- `runtime/` は同じ PC のローカルディスクに置きます。共有フォルダ、同期フォルダ、別の PC と共通の SQLite 台帳を使わないでください
- 未構成の production は TaskSpec の検証・保存・記録の閲覧を扱います。実行・承認には信頼済み配置設定が必要です。実ジョブの結果ACKには必要成果物の実体化・検証が必要で、本文だけの過去ACKは全成果物受領と表示しません。未設定のボタンは理由を示して無効です

```powershell
# リポジトリのルート。PRのVerified headをそのまま代入する
$ExpectedCommit = '<このPR description: Verified head>'
git fetch origin
git switch --detach $ExpectedCommit
if ((git rev-parse HEAD) -ne $ExpectedCommit) { throw 'Commit mismatch' }
npm ci
npm run build
```

## 2. 通常の製品 UI を起動する

### Windows / Electron の既存アプリ

```powershell
# リポジトリのルート
$env:CHATGPT_BRIDGE_ROOT = (Get-Location).Path
$env:CHATGPT_BRIDGE_RUNTIME_DIR = Join-Path $env:LOCALAPPDATA 'ChatGPTBridge\runtime'
Remove-Item Env:CHATGPT_BRIDGE_UI_PROFILE -ErrorAction SilentlyContinue
cd gui
npm ci
npm start
```

起動時は **440×46の常駐バー** です。「↗」で同じウィンドウを下へ展開し、全体 **440×604** の「状況・結果」を表示します。どのページでも外枠は同じで、長文は内部だけスクロールします。「⌃」で入力を保持して畳みます。トレイと `Ctrl+Shift+C` で元の表示へ戻れます。最前面・非アクティブで隠す・最小化先・テーマは表示設定にあります。LLMがBridge CLIから受理させた依頼を確認するのが中心で、手動取り込みは補助操作です。トレイの「終了」はアプリとローカルサーバーを終了します。

トレイの「従来のブラウザチャット」から既存の画面を開けます。従来の `run / submit / status / wait / result` CLI も維持しています。通常の ChatGPT ブラウザ送信と Bridge v2 の実行証跡、Work/dot 向けイベントは別の経路です。チャット送信完了を v2 タスク成功と読み替えないでください。

既存の portable exe は古いコードのままでは更新されません。ソース更新後に `gui/` で `npm run package` を行って作り直します。起動時の `CHATGPT_BRIDGE_ROOT` は更新・ビルド済みリポジトリを指す必要があります。

### Electron を使わずに開く

```powershell
# リポジトリのルート
npm run ui
# 固定ポートが必要な場合だけ
npm run ui -- --port 8765
```

端末に表示された `http://127.0.0.1:.../#token=...` を**その PC のブラウザ**で開きます。トークンは本人用の一時的なアクセス権です。チャット、チケット、スクリーンショットへ貼らないでください。ページは直ちにアドレスバーのフラグメントを除去し、同じタブのセッションに保持します。別タブで開くには元の起動 URL が必要です。UI サーバー再起動後は新しい URL を使います。`Ctrl+C` でサーバーを終了します。

## 3. 画面の使い方

1. 一覧から依頼を選びます。状態・時刻・ハッシュはサーバーの台帳にある実値です。空の台帳では完了済み依頼を作って表示しません
2. 「依頼の内容」で受理済み TaskSpec JSON と Markdown を確認します。受理済みの内容は変更できません
3. 新しい JSON/MD の組を貼り付け、「検証」で schema と生 UTF-8 バイトの SHA-256 を照合します。「受け付ける」はローカル台帳への保存です。承認・実行を許可する操作ではありません
4. 「承認と許可」で対象・範囲・有効期限・承認記録・実行前確認を読みます。許可済み内容と異なる内容は、新しい UUID を使って新しい依頼として検証します。古い承認は引き継ぎません
5. 「実行の記録」で受信 ACK、開始証跡、終端結果、結果 ACK を区別します。結果ACKは成功判定やコードのマージを行いません。本文ACKだけならその旨を表示し、必要成果物の受領が未確認の間は全受領済みとは表示しません
6. 「復旧の確認」は既存 ID の記録を照合します。unknown を別 ID にコピーして開始することは復旧になりません
7. 接続エラー後は読取更新で現在の台帳を確かめます。操作結果が不明なまま同じ操作を自動送信しません

無効なボタンにはサーバーの具体的な理由を表示します。CLI や raw JSON を使って無効状態を迂回しないでください。provider 利用枠、課金見積、モデルの実機利用可否は未取得なら「不明」です。

## 4. 安全なデモ試験

```powershell
# ブラウザ UI。production と同じ root を使っても台帳は分離される
npm run ui:demo

# または Electron。起動前に明示する
$env:CHATGPT_BRIDGE_UI_PROFILE = 'demo'
cd gui
npm start
```

デモは `runtime/ui-demo/jobs.db` に保存され、production の `runtime/jobs.db` と混ざりません。画面に合成デモであることを常時表示します。新しいデモ依頼を作り、承認、開始、成功/失敗の合成観測、停止、結果 ACK を試せます。状態は実際の TaskController と SQLite 台帳を通りますが、外部プロセス、Claude/Codex、モデル、ネットワーク、リポジトリ処理は実行しません。

実行中にデモサーバーを終了して再起動すると実行観測は失われます。台帳と開始意図は保持され、unknown として照合を待ちます。同じ UUID を再実行しません。証跡のない unknown を成功や停止済みに書き換えません。

production に戻るにはアプリを終了し、上記の環境変数を削除して起動し直します。デモの結果を production の成果物や実機試験の成功証拠として扱わないでください。

## 5. エラー時の確認

- UI のビルドがない: リポジトリのルートで `npm run build`。portable GUI の root 設定も確認
- 接続/401: サーバーが生きているか確認し、同じ起動時の本人用 URL で開き直す
- `stale_observation` / 内容不一致: 現在の依頼を更新して確認。前の承認を転用しない
- `capability_unavailable`: 診断欄の未設定アダプターを確認。PR2 単体では実モデルを起動できない
- `unknown`: UUID、run ID、ハッシュ、観測番号を保全し、同じ ID の記録を照合する。新しい実行を作らない
- API の任意のパス読み出し、外部公開、任意コマンド実行、ネットワーク待受の拡張はサポートしない

テストは [UI-TESTING.md](UI-TESTING.md) を使います。Windows の実行制御や実アダプターの検証範囲は、統合後の全体手順書と [WINDOWS-HANDOFF.md](WINDOWS-HANDOFF.md) で別に確認します。

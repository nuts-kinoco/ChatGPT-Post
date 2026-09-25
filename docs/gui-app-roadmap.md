# GUI化ロードマップ (2026-09-25)

背景資料:
- [`docs/gui-app-brainstorm-brief.md`](gui-app-brainstorm-brief.md) — 壁打ち依頼時のブリーフ
- `chatgpt_web_bridge_architecture_v2_redteam_base.md`（外部LLMによるレッドチームレビュー、2026-09-25受領）

外部レビューは「CLIをGUIで薄く可視化する」という当初スコープを大きく超え、永続キュー・
`bridge-host`常駐プロセス・マルチスロット・Account Submit Gate・Knowledge Export/Obsidian連携まで
含む全面書き換え案だった。有用な部分だけを今回スコープに取り込み、残りはBacklogとして明示的に温存する。

## Now（今回のスコープ: 表示中心の軽量GUI）

出典: 当初のユーザ要望（`gui-app-brainstorm-brief.md`のたたき台）+ レッドチーム案から採用する部分。

**表示系（低リスク、既存の`doctor`/`runtime/`データを読むだけ）**
- 使用中セッション・リクエストID・内容の一覧化
- 送受信時間・完了時間の表示
- ログの確認
- Bridge Health表示（daemon/Chrome/Login/Queue相当の簡易状態。レッドチーム案§22.4のミニ版）
- 完了通知

**操作系（既存CLI/daemonコマンドを裏で呼ぶだけ、GUIは新しい状態を持たない）**
- ブラウザを立ち上げる／閉じる
- Cookie更新（再ログイン導線）
- 停止（実行中リクエストのキャンセル）

**レッドチーム案から採用する設計原則（実装は既存コードへの小改善として個別タスク化）**
- Submit intent/ack相当の永続化（§8）: 現状のcomposerCleared判定は機能的に同等だが、
  ディスク上に`submit.intent`/`submit.ack`を明示的に残す形にすると、クラッシュ後の状態確認が
  GUI側からも単純になる。既存`dispatchSubmit()`への追加改修として別タスク化する。
- Ready Fenceの一般化（§12, §13）: 「stopped ≠ 再利用可能」「単発確認でなく連続安定確認」は
  A-149/A-162で得た教訓と同じ。停止コマンドを追加する際は、この一般化されたチェックリストを
  参考にする。

## Backlog（将来検討、今は着手しない）

理由: 現在の利用パターン（単発・バースト的、実質シングルスロット共有）に対して、
以下は今のところ必要性が薄く、実装コスト・移行リスクが大きい。ニーズが顕在化してから再検討する。

- 永続SQLiteキュー + `bridge-host`常駐プロセスの新設（§4-7）
- CLI直接実行の廃止・Queue経由への統一（§2.2, §15）— 現在Claude/Codex/オーケストレータが
  並行して直接CLIを使っている現役システムであり、移行は慎重な計画が要る
- マルチスロット（複数Chrome Profile）+ Account Submit Gate（§9-11, §29）—
  同一アカウント由来のblast radius共有はドキュメント自身も認めている
- Priority Scheduler / Interactive Reserved Slot（§11）
- Knowledge Exporter / Export Outbox / Obsidian連携（§18, §20）—
  今回のGUI議論に含まれていなかった別領域の機能
- Slot Quarantine（§14）— マルチスロット前提のため保留

## 判断基準（Backlog着手のトリガー）

- 同時に複数のリクエストを本当に並行実行したい具体的なニーズが発生した場合のみ、
  マルチスロット関連（Queue/bridge-host/Account Submit Gate）を再検討する
- Obsidian等へのナレッジ書き出し自動化が別途必要になった時点で、Knowledge Exporterを再検討する

## 採用デザイン: 案C（ミニマル・フローティングバー型）

[`docs/gui-design-brief-v2.md`](gui-design-brief-v2.md) から作成した3案（[`gui-design-brief-v2.md`](gui-design-brief-v2.md) と同時受領の `Bridge Control GUI.dc.html`）のうち、**案C（L1 Bar 380×40 → L2 Popup 380×~520 → L3 Drawer 380×640 の3段階展開）**を採用。
「普段は最小・要求時だけ展開」という挙動が、原ブリーフのトレイ常駐コンセプトおよび実際の使用頻度（頻繁にチラ見・たまに操作、応答本文の精読は各AIクライアント側で完結）に最も合致すると判断。トレードオフとしてDrawer幅380pxはLogs/Response閲覧にはやや狭く、`Open in Browser`での外部確認を前提とする。

## 実装フェーズと技術選定

**技術スタック**: Electron + TypeScript + React + Tailwind CSS。既存コア（`src/`）はNode/TS製CLIであり、GUIプロセスからも`doctor`等のCLI呼び出し・`runtime/`配下のファイル読み取りだけで完結させたいため、別言語ブリッジ（Tauri+Rust等）を避けクロスランゲージの複雑さを避ける。

**配置**: リポジトリ直下に新規`gui/`ディレクトリ（独自`package.json`/`tsconfig`）。コアCLIのビルド・テストパイプラインには一切混在させない。

**安全境界（レッドチーム案§21を今回スコープでも踏襲）**: GUIはロック直接操作・Chrome PID kill・Cookie読取・Queue状態の手動書き換えを一切行わない。すべて既存CLIコマンドをサブプロセスとして呼ぶか、`runtime/`配下を読み取るだけ。

**モデル割り当て方針**: Codexへの実装ディスパッチは基本`gpt-5.6-terra`、難易度が高い箇所（Electron⇔既存ロック/プロセスモデルとの結線、Stop実装、状態遷移の一般化など）は`gpt-5.6-sol`を使う。ブリッジ（daemon/ロック/ブラウザ）を止める必要がある検証を行う場合は、事前にオーケストレータへ`SendMessage`で連絡してから実施する。

| Phase | 内容 | モデル | 備考 |
|---|---|---|---|
| GUI-01 | `chatgpt-bridge doctor --json` 追加（既存doctorの出力項目をJSON化するだけ） | Terra | コアCLI側の変更、既存テストパターンに追従 |
| GUI-02 | `gui/`スキャフォールド（Electron main process、トレイアイコン、L1 Bar空実装） | Terra | ブリッジは触らない、純粋に新規GUIプロセスの骨組み |
| GUI-03 | L1 Bar〜L2 Popup（表示系）: `doctor --json` + `runtime/requests/*`ポーリングして一覧・Health表示 | Terra | 読み取り専用 |
| GUI-04 | L3 Drawer（Logs/Response/Prompt表示） | Terra | 読み取り専用 |
| GUI-05 | 操作系（New / Stop / Refresh Cookie）の結線 | Sol | 既存CLIサブプロセス起動＋エラー処理、二重発火防止など安全境界に関わる |
| GUI-06 | 通知（完了トースト）・ホットキー・Pin | Terra | UI付随機能 |
| GUI-07 | パッケージング（tray常駐・自動起動設定） | Sol | Windows特有のプロセスライフサイクル（既存`run-watchdog.ts`と同じ地雷源） |

各フェーズはCodexタスクとして個別ディスパッチし、独立検証（typecheck/lint/build/test + 可能な範囲でのライブ確認）を経てから次へ進む。GUI-05以降でブリッジのライブ挙動に触れる検証は、Codexサンドボックス内では絶対に行わず（既存メモリ規則）、管理セッション（Claude）が自分のシェルから直接行う。

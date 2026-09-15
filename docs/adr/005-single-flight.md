# ADR-005: single-flight 実行、write-ahead 送信マーカー、送信後は再送しない

- 状態: Accepted（Phase 2、2026-09-14）。**FROZEN FOR MVP v1.0（Phase 3、2026-09-15）**
- 関連: `11-STATE-MACHINE.md` §5, §6 / FR-025, FR-035〜038, FR-042 / R-003, R-007

## 文脈

二重送信は利用枠を浪費し、回答の対応付けを壊し、規約上のレート制限回避と見なされ得る（R-001, R-003）。Windows ではプロセスの強制終了やファイルロックにより「送信したか分からない」状態が起こり得る。

## 決定

1. **プロセスロック**: `runtime/locks/bridge.lock` を `O_EXCL` で作成し `{ pid, startedAt, token, command, requestId }` を書く（`token` は所有者の乱数。作成直後に再読取して自トークンであることを確認する）。**所有トークンは取得直後・`submit.marker` 書込直前・解放時に再検証**し、失敗なら `LOCK_LOST` として送信せずに `ALREADY_RUNNING` で終了する。解放は自トークンのときのみ削除する。専用プロファイルを開くすべてのコマンド（`run`, `login`, `inspect-ui`, ブラウザを起動する `doctor` 項目）が取得する。取得できなければ `ALREADY_RUNNING`（終了コード 4、result.json を書かない）。
2. **stale 判定と内容照合付き回収**: lock の PID が `process.kill(pid, 0)` で不在、または PowerShell 経由の `Win32_Process.CreationDate` が lock の `startedAt` より後（PID 再利用）なら stale とみなす。回収は **`fs.rename(bridge.lock, bridge.lock.stale-<自PID>-<random>)`** で行い、rename 後に rename 先を読んで **stale と判定した記録（pid / startedAt / token）と一致することを確認**する。一致しなければ他者の生きた lock を奪ったので `rename` で元に戻し（戻せなければそのまま）、`ALREADY_RUNNING` に倒す。一致すれば改めて `O_EXCL` で作成する。0 バイト・JSON 不正の lock は mtime が 10 s より古ければ stale、若ければ `ALREADY_RUNNING`。WMI 照会が失敗した場合は「生存」とみなす（安全側）。奪われた側は決定 1 の再検証で送信前に停止するため、回収競合の窓が残っても二重送信には至らない。
3. **requestId 単位の排他**: 別ファイルのロックは持たず、(a) プロセスロック（同時に 1 件）、(b) `requestDir/result.json` の存在（`ALREADY_PROCESSED`）、(c) **requestId でグローバルな** `runtime/state/<requestId>/submit.marker` の存在（`SUBMIT_STATE_UNKNOWN`）で担保する。FR-036 の「リクエスト ID 単位のロック」はこの組み合わせで実現する（A-031）。**marker の判定はプロセスロック保持下でのみ行う**ため、進行中の同一 requestId に対しては必ず `ALREADY_RUNNING` になる。
4. **write-ahead マーカー**: 送信操作の直前に `submit.marker` を tmp → fsync → rename で書く。書けなければ送信しない。マーカーは成功時も残す。requestDir ではなく `runtime/state/` に置くため、同じ requestId を別ディレクトリで再実行しても再送されない（`SUBMIT_STATE_UNKNOWN` になる）。
5. **送信は 1 回**: 状態機械上、送信 effect は `PROMPT_ENTERED → PROMPT_SUBMITTING` の遷移（`MARKER_WRITTEN` 受領時）でのみ発火し、それ以降の状態から送信前へ戻る遷移は存在しない。送信後の失敗は全て終端し、`submitted: yes | unknown` を返す。
6. **内部再試行**は送信前の 4 状態に限定し、各 2〜3 回を上限とする。
7. 並列実行は行わない。キュー常駐も MVP 外。

## 理由

- 「送信したか分からない」状態を **次回起動時に検出して拒否する** ことが、クラッシュ耐性のある二重送信防止の最小構成。
- ロックとマーカーを別々にすることで、ロックの stale 回収がマーカーの意味を壊さない。
- 直列実行は最も単純で、用途（低頻度・単発）に対して十分。

## 却下した代替案

| 案 | 却下理由 |
|---|---|
| requestId ごとのロックファイル | プロセスロック + グローバル marker で十分。ファイルが増えるだけ |
| 送信後の一定条件での自動再送 | 二重送信の温床。CON-011 / FR-038 違反 |
| マーカーを成功時に削除 | クラッシュのタイミングによっては「result.json も marker も無い」状態が生まれ、再実行で再送される |
| stale 回収を `unlink` で行う | 2 プロセスが同時に回収すると片方が相手の新しい lock を消す（TOCTOU） |
| 内容照合の無い rename 回収 | 回収・再作成の直後に別プロセスが新しい lock を rename できる（二次 TOCTOU）。内容照合と送信前トークン再検証で塞ぐ |
| PID 生存のみで stale 判定 | PID 再利用で誤判定。`doctor` も WMI を使う設計なので `CreationDate` 照合を採用（失敗時は安全側） |

## 影響

- 同一 requestId の再実行は同じ `runtime/` 配下では必ず拒否される（別マシン・別 `runtime/` は対象外）。再送は新しい requestId で行う（呼び出し元の規約）。
- `doctor` の stale 判定・案内は同じロジック（`src/state/lock.ts`）を使う。
- `login` 中は `run` できない（意図通り）。

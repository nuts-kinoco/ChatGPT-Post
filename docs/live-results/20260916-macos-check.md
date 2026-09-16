# macOS 側の動作確認（2026-09-16、f2251b6）

実施: EMAKINOCO 側の Claude Code（emakinoco-cd）。Mac は `/Volumes/Share/Projects/chatgpt-web-bridge`（Windows の `S:\` と同じ SMB 共有）を直接使用。

## 結果一覧

| 手順 | 結果 |
|---|---|
| 1. `git pull` / `npm install` / `npm run build` | OK（f2251b6、tsc 通過）。`chatgpt-bridge` は Mac では `npm link` 未実施 → `node dist/cli/main.js` で代用 |
| 2. `doctor` | **NG `login: browser probe failed (exit 4)`** — Chrome の起動が 180 s でタイムアウト（`BROWSER_LAUNCH_FAILED`）。原因は §1 |
| 3. `daemon start` | **実行していない**（§2 の理由で Windows 側の daemon を壊すため） |
| 4. Projects 連携（schema 1.3） | ローカルの空プロファイルで `project` 付き request を `run` → schema 検証は通り、送信前に `AUTH_REQUIRED`（exit 3、`submitted: no`）で停止。ログイン後の実送信は未確認 |

## 1. 【最重要】`runtime/` が Windows と Mac で共有されている

`runtimeDir = REPO_ROOT/runtime` は設定不可で、SMB 共有上のリポジトリを両 OS から使うと **`runtime/profile`・`runtime/locks/bridge.lock`・`runtime/daemon.json`・`runtime/state` がそのまま共有**される。

観測した実害:

- `runtime/daemon.json` は Windows の daemon（pid 117856、`S:\...\profile`、07:21Z 起動、15 分ごとの keepalive が稼働中）のもの。Mac の `doctor` は「daemon.json is for a different profile」と表示するだけで正しく無視するが、Mac で `daemon start` すると **この JSON を上書きし、Windows 側が自分の daemon を見失う**
- Mac で `run` を実行中（14:06Z）、Windows の daemon の keepalive が `runtime/daemon.log` に **`skipped: lock held`** を記録した。`runtime/locks/bridge.lock` が機種をまたいで効いている。逆方向（Windows の run 中に Mac が lock を見る）では、Mac は Windows の PID を `process.kill(pid, 0)` で「不在」と判定して stale 回収するため、**single-flight が破れる**
- `runtime/profile` を Mac の Chrome で開くと、Windows の Chrome が保持している状態と SMB の遅さで起動が 180 s タイムアウト（前日は起動できたが、Windows 側 daemon が動き出してから常に失敗）
- 仮に起動できても **Cookie の暗号鍵が OS ごとに違う**（Windows: DPAPI、Mac: Keychain／Playwright 起動時は mock keychain）ので、片方でログインしても他方では `AUTH_REQUIRED`。前日の「ログインしたのに doctor が NG」はこれ

`CHATGPT_BRIDGE_PROFILE_DIR=$HOME/chatgpt-bridge-runtime/profile`（ローカルディスク）にすると `doctor` は 11 s で完走し、`login: AUTH_REQUIRED`（未ログインなので期待どおり）。

### 提案

1. `CHATGPT_BRIDGE_RUNTIME_DIR`（または `--runtime-dir`）を追加し、profile だけでなく locks / state / daemon.json / artifacts をまとめてローカルへ逃がせるようにする。SKILL.md の Mac 手順に「共有リポジトリなら必ずローカルの runtime を指定」と書く
2. 少なくとも `doctor` に「`runtime/` がネットワークボリューム上にある」警告（`df` / `statfs` で判定）を出す
3. `daemon.json` に `hostname` を入れ、他ホストの記録なら `daemon start/stop` が触らない

## 2. `scripts/manual-login.mjs` の macOS 固有の問題

darwin では Chrome を `--user-data-dir` だけで起動する。この Chrome は Cookie を **macOS Keychain の鍵**で暗号化するが、ブリッジ（Playwright）の Chrome は `--password-store=basic --use-mock-keychain` で起動するため復号できず、**手動ログインしても `doctor` は `AUTH_REQUIRED` のまま**（前日に 2 回再現）。

提案: darwin のときは `manual-login.mjs` の引数に `--password-store=basic --use-mock-keychain` を足す（自動操作ではないので Google のブロック対象にはならない。実機での成否は Mac 側で要確認）。

## 3. その他（Windows と違う挙動）

- Chrome の実行パス `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` は `manual-login.mjs`・Playwright とも正しく解決した
- macOS ではウィンドウを閉じても Chrome プロセスが残る（⌘Q が必要）。`manual-login.mjs` の案内文「ウィンドウを閉じて」は Mac では不十分 → 「⌘Q で終了」と書く
- `doctor` の `profile.free` は Mac ではプロセス走査ではなくファイル判定のようで、Chrome が生きていても `not held by another process` と出た（Windows の WMI 相当が無い）

## 次にやること（Mac 側）

1. ローカル runtime（提案 1）が入るまでは `CHATGPT_BRIDGE_PROFILE_DIR` をローカルにし、`daemon` は Mac では使わない
2. `manual-login.mjs` に mock keychain フラグを足した版で手動ログイン → `doctor` → Projects 付き `run` を実送信して確認

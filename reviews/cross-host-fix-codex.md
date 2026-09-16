レビュー結論: **現状は Block 推奨**です。hostname 判定の通常経路は正しい一方、共有 SMB 上での状態更新競合と、hostname を偽装できる書込み者への fail-closed が不足しています。

- **High — `daemon.json` の foreign 保護が TOCTOU で破れる。**  
  [src/browser/daemon.ts:208](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:208) で foreign を確認しても、worker は [daemon-worker.ts:99](S:/Projects/chatgpt-web-bridge/src/browser/daemon-worker.ts:99)-[111](S:/Projects/chatgpt-web-bridge/src/browser/daemon-worker.ts:111) で `rename()` により `daemon.json` を無条件置換します。判定後〜rename 前に他ホストが state を作れば、その foreign state を上書きできます。さらに `stopDaemon()` は読み取った state と現在のファイルの同一性を再検証せず [daemon.ts:199](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:199) で unlink し、worker の shutdown も [daemon-worker.ts:64](S:/Projects/chatgpt-web-bridge/src/browser/daemon-worker.ts:64) で無条件 unlink します。結果として、他ホストが新しく書いた state を削除可能です。  
  対策は hostname ごとの state ファイル分離が最も堅牢です。単一ファイルを維持するなら、ホスト固有の所有トークンを含め、削除・置換の直前に内容一致を原子的に確認できるプロトコルが必要です。

- **High — foreign daemon を認識しても、通常コマンドがローカル Chrome 起動へフォールバックする分岐が残る。**  
  [src/cli/adapters.ts:117](S:/Projects/chatgpt-web-bridge/src/cli/adapters.ts:117)-[128](S:/Projects/chatgpt-web-bridge/src/cli/adapters.ts:128) は `daemon.alive` だけを特別扱いし、`daemon.foreign` の場合は profile lock の再確認後に `session.launch()` します。SMB 越しの Chrome lock 判定が失敗／非互換なら、既知の foreign daemon が同じ profile を使っているのに並行起動し得ます。daemon は idle 時に `bridge.lock` を保持しないため、lock だけでは防げません。  
  `foreign` は `checkProfileFree()` で必ず `free:false` にし、`launch()` も明示的に拒否すべきです。doctor の [doctor.ts:115](S:/Projects/chatgpt-web-bridge/src/diagnostics/doctor.ts:115)-[128](S:/Projects/chatgpt-web-bridge/src/diagnostics/doctor.ts:128) が foreign daemon により profile を `OK` 扱いするのも、fail-closed の説明と整合しません。

- **High — hostname は認証情報ではなく、偽装で任意のローカル PID を kill し得る。**  
  共有 runtime に書ける攻撃者が target host と同じ hostname、稼働中 PID、将来の `startedAt` を含む `daemon.json` を置けます。[daemon.ts:154](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:154) の foreign 拒否を通過し、[daemon.ts:161](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:161)-[181](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:181) が SIGTERM/SIGKILL を送ります。macOS では [daemon.ts:100](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:100)-[104](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:104) の作成時刻照合が使えず、PID 生存だけで成立します。  
  共有ドライブを信頼境界外とするなら、state ファイルだけを根拠に signal を送ってはいけません。ホストローカルに保持した capability／所有記録と突合できない state は stop を拒否してください。

- **High — worker の一時 state 名がホスト間 PID 衝突を考慮していない。**  
  [daemon-worker.ts:99](S:/Projects/chatgpt-web-bridge/src/browser/daemon-worker.ts:99) の一時名は `.tmp-${process.pid}` のみです。異なるホストの PID は普通に衝突するため、同時・復旧中の worker が同一 temporary file を書換え、片方の rename が `ENOENT` となり Chrome だけ残る可能性があります。hostname と暗号学的ランダム nonce を含めるべきです。

- **Medium — hostname 無しの既存 lock/state は、共有環境では元の破壊的挙動を維持する。**  
  要件どおり [lock.ts:116](S:/Projects/chatgpt-web-bridge/src/state/lock.ts:116)-[123](S:/Projects/chatgpt-web-bridge/src/state/lock.ts:123)、[daemon.ts:75](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:75)-[77](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:77) は空 hostname を同一ホスト扱いに戻しています。しかし upgrade 直後の共有 runtime では、生きている旧 Mac lock を Windows が stale 回収する、旧 daemon state を stale 扱いする、という A-108 の再現が残ります。  
  これは後方互換性との明示的トレードオフですが、少なくとも共有 runtime を検出した場合は legacy state/lock を「手動移行が必要」として fail closed にするか、初回移行手順で旧 runtime の隔離を必須化すべきです。

- **Medium — 偽の foreign lock/state により恒久的 DoS を作れる。**  
  [lock.ts:116](S:/Projects/chatgpt-web-bridge/src/state/lock.ts:116)-[121](S:/Projects/chatgpt-web-bridge/src/state/lock.ts:121) は hostname が異なれば PID・時刻に関係なく永久に live とみなします。共有ディレクトリに書ける者は架空 hostname の `bridge.lock` で全ホストを止められます。同様に偽 foreign `daemon.json` は start/stop を拒否させます。安全側の選択ではありますが、hostname は信頼できない属性なので、DoS を受容する脅威モデルを明文化するか、ホストローカル runtime を実質必須にしてください。

- **Medium — `runtime.location` は今回の Windows 実害の経路を検知しない。**  
  [doctor.ts:223](S:/Projects/chatgpt-web-bridge/src/diagnostics/doctor.ts:223)-[225](S:/Projects/chatgpt-web-bridge/src/diagnostics/doctor.ts:225) は UNC と `/Volumes` 等だけで、実機の `S:\...` のような mapped SMB drive を `OK` と表示します。コメントにも限界は書かれていますが、まさに報告された Windows 側で警告が出ないため、`GetDriveTypeW` / PowerShell の `DriveType=4` 等で mapped drive を検出する価値があります。

- **Medium — macOS の cookie storage を弱める変更はセキュリティ上の明示的判断が必要。**  
  [launch.ts:19](S:/Projects/chatgpt-web-bridge/src/browser/launch.ts:19)-[23](S:/Projects/chatgpt-web-bridge/src/browser/launch.ts:23)、[manual-login.mjs:47](S:/Projects/chatgpt-web-bridge/scripts/manual-login.mjs:47)-[64](S:/Projects/chatgpt-web-bridge/scripts/manual-login.mjs:64) は Keychain を避ける設定を manual login と bridge に恒常適用します。ログイン自動入力・CAPTCHA 回避には該当しませんが、セッション cookie の OS 保護を弱める方向です。特に共有 runtime のままでは影響が大きくなります。A-108 の runtime 分離とは別変更として、脅威モデルと利用者への警告を追加すべきです。

確認できた良い点として、foreign hostname の通常判定は PID 照会より先にあり、[lock.ts:116](S:/Projects/chatgpt-web-bridge/src/state/lock.ts:116) は要求どおり foreign PID を stale 回収しません。[daemon.ts:110](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:110)-[116](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:116)、[daemon.ts:210](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:210)-[216](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:216)、[daemon.ts:154](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:154)-[160](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:160) も、競合が無い通常経路では意図どおりです。

テストは foreign/legacy の単体分岐を押さえていますが、上記の state 置換・shutdown unlink・adapter の foreign fallback・hostname 偽装・mapped drive 検知は未検証です。[tests/unit/daemon.test.ts:37](S:/Projects/chatgpt-web-bridge/tests/unit/daemon.test.ts:37) にこれらの競合／fail-closed ケースを追加することを推奨します。`git diff --cached --check` は問題ありませんでした。
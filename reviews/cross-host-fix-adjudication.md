# クロスホスト runtime/ 共有対策（A-108）— Codex レビュー裁定

日付: 2026-09-16 / 対象: A-108 差分 / 入力: `reviews/cross-host-fix-codex.md`（Codex, gpt-5.6-terra, high, read-only）

Codex の結論は「Block 推奨」。設計をホストごとに独立したファイル（`daemon.<hostname>.json`）へ変更することで、指摘の大半を「検知して拒否する」から「そもそも書けない」構造的解決に格上げした。

| # | 重要度 | 内容 | 裁定 | 対応 |
|---|---|---|---|---|
| Q-1 | High | `daemon.json` が単一共有ファイルのため、foreign 判定〜書き込みの間に TOCTOU で他ホストの state を上書き・削除し得る | **採用（設計変更）** | `daemon.<hostname>.json` に分離。各ホストは自分のファイルしか読み書き・rename・unlink しない。他ホストの検知はディレクトリスキャンのみ（書き込みなし）にしたため、TOCTOU の窓自体が構造的に無くなった |
| Q-2 | High | `cli/adapters.ts` が `daemon.alive` だけを見て、`daemon.foreign` のときは `checkProfileFree()`/`launch()` がローカル起動にフォールバックしてしまう（最重要: SMB 越しの lockfile 判定は信頼できないため、実際に他ホストの Chrome と衝突し得る） | **採用** | `checkProfileFree()` は foreign を `free:false` として返す。`launch()` も二重の安全策として foreign なら即座に拒否（`checkProfileFree` を経由しない呼び出し順があっても安全なように）。実機で `run`/`doctor` が `PROFILE_IN_USE`/`daemon: not running here` で正しく止まることを確認 |
| Q-3 | High | hostname は認証情報ではなく、共有ドライブに書き込める者が偽装して任意の自ホスト PID を kill させ得る | **見送り（許容リスクとして明記）** | この機能が前提とする脅威モデルは「PO 本人の複数マシン」であり、A-103/A-104 で CDP ポート無認証を許容したのと同じ前提。多人数環境への拡張時は要見直しとコメントに明記。トークン/capability 方式の追加実装は今回の目的（PO 自身の Win/Mac 事故防止）に対して過大 |
| Q-4 | High | worker の一時ファイル名が `.tmp-${pid}` のみで、ホスト間 PID 衝突を考慮していない | **採用（設計変更で解消）** | Q-1 の分離により `--state-path` 自体がホスト名を含むため、tmp 名（`${statePath}.tmp-${pid}`）も構造的にホスト名前空間化された。追加のコード変更は不要 |
| Q-5 | Medium | hostname 無しの既存 lock/state は共有環境で旧来の破壊的挙動のまま | **見送り（許容リスクとして明記）** | 移行期の狭い窓のみに影響。今回、このリポジトリ自身の旧 `daemon.json` は手動で退避・削除して移行した。DECISION-LOG に移行手順の必要性を明記 |
| Q-6 | Medium | 偽の foreign lock/state で恒久的 DoS を作れる | **見送り（Q-3 と同じ理由）** | 単一ユーザーの専有マシンという前提。共有ディレクトリに書ける者は既に他の方法でも妨害可能 |
| Q-7 | Medium | `runtime.location` が実機の `S:\` のようなマップ済み Windows ドライブを検知しない | **採用** | `Win32_LogicalDisk`（`DriveType=4` または `ProviderName` 非空）を PowerShell 経由で確認する `isWindowsMappedNetworkDrive()` を追加。ベストエフォート、失敗しても doctor は落ちない |
| Q-8 | Medium | macOS の Keychain 回避フラグはセキュリティ上の判断が必要 | **採用（説明追記のみ、コードは変更なし）** | Playwright の自動化 Chrome は元々既定でこのフラグを付けている（実機ログで確認）ため、今回の変更は「手動ログインの Chrome をそれに合わせる」だけで、新たに保護を弱めたわけではない。この経緯をコード内コメントと DECISION-LOG に明記 |

## 修正後の検証

- `npm run typecheck` / `npm run lint` / `npm run build`: OK
- `npm test`: **152 passed**（149 → +3、`tests/unit/adapters.test.ts` 新規で Q-2 の直接検証）
- Live: 本物の Windows daemon が稼働中の状態で、正しく書き込まれた偽の `daemon.mac-mini.local.json`（同一 profileDir）を並べて配置 → `daemon status`/`doctor` は自ホストの daemon を優先（正しい）。次に Windows 側 daemon を停止した状態で同じ偽ファイルのみを残すと、`doctor` が `PROFILE_IN_USE`／`daemon: not running here...refuses to launch`、実際の `run` コマンドも `PROFILE_IN_USE`（exit 4, ローカルブラウザを起動せず）で正しく止まることを確認。テスト後、偽ファイルを削除し本物の daemon を再起動して復旧

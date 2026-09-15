# ADR-002: 専用永続プロファイル（headed、Google Chrome チャネル既定）を使う

- 状態: Accepted（Phase 2、2026-09-14）。**FROZEN FOR MVP v1.0（Phase 3、2026-09-15）**
- 関連: `01-RESEARCH-AND-DECISION.md` D-03, D-04 / CON-004, CON-005, SEC-001 / OQ-004

## 文脈

ログイン状態をリクエスト間で保持する必要がある。Playwright 公式は通常 Chrome プロファイルの自動化を非サポートと明記し、通常プロファイルには他サイトの Cookie・パスワードが含まれる。

## 決定

1. `chromium.launchPersistentContext(profileDir, { channel, headless: false, viewport: null })` を使う。`profileDir` の既定は `runtime/profile/`。
2. 通常の Chrome / Edge / Chromium / Firefox の User Data パスを指す設定は起動前に拒否する。判定は `fs.realpath` の canonical path で行い、パスの最終要素・祖先が symlink / junction の場合も fail closed で拒否する（Codex レビュー F-01）。
3. `channel` の既定は `'chrome'`（インストール済み Google Chrome）。環境変数で `'chromium'`（Playwright 同梱）に切替可能。`doctor` はどちらが使われるかとバージョンを表示する。
4. headless は製品コードで使わない（fixture テストのみ可）。
5. `storageState` の書き出し・読み込み、`cookies()`、Cookie DB の読取は行わない。ログイン状態はプロファイルディレクトリ内にのみ存在する。

## 理由

- 専用プロファイルは被害範囲を ChatGPT セッションに限定する。
- headed は CAPTCHA・再ログイン・同意画面をそのまま人間が処理でき、検知回避の実装動機を消す。
- Google Chrome チャネル: ログインフロー（Google / Apple SSO 等）は自動化された Chromium で拒否される事例があり、ブランド Chrome の方が「通常利用」に近い。プロファイル形式は同一。Chrome の自動更新による挙動変化は `doctor` のバージョン表示と Live smoke で検出する。
- Chromium 同梱を選べる余地を残すのは、Chrome 未インストール環境や再現性重視の検証のため。

## 却下した代替案

| 案 | 却下理由 |
|---|---|
| 通常プロファイルの利用 | Playwright 非サポート、CON-004 違反 |
| 通常プロファイルの複製 | Cookie DB を読む＝秘密情報操作 |
| `storageState` JSON で認証を持ち回る | Cookie をファイルに書き出す（SEC-002 違反） |
| headless 既定 | CON-005 違反。bot 判定の誘発 |
| Chromium 同梱を既定 | ログインフロー拒否のリスク。ただし選択肢として残す |

## 影響

- `login` コマンドが必要（初回・失効時）。
- 実行中はブラウザウィンドウが表示され、人間が触ってはいけない（17-OPERATIONS §5）。
- Chrome の自動更新で挙動が変わり得る（R-015）。

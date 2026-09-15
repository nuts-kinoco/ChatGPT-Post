# 01 — Research and Decision

| 項目 | 値 |
|---|---|
| 文書版 | 1.0 (Phase 1) |
| 調査時点 | PO 調査: 2026-09-14 / Claude 再確認: 2026-09-14 |
| 状態 | 決定済み（D-01〜D-08）。Phase 3 の独立レビューで再挑戦を受ける |

本書は「なぜこの方式か」を将来の自分と独立レビュアーに説明するための文書である。各決定には根拠・却下した代替案・再考トリガーを付す。

## 1. 調査結果

### 1.1 Sengpt（不採用）

| 観点 | 結果 |
|---|---|
| 方式 | ブラウザの開発者ツールからセッショントークンを手動取得し、非公式経路で ChatGPT を叩く |
| 保守状態 | GitHub リポジトリは **2024-09-14 にアーカイブ（読み取り専用）**。README に "Dead project since re_gpt is not maintained anymore" と明記 |
| 再確認 | 2026-09-14 に Claude が GitHub ページを取得し、アーカイブ表示と上記文言を確認した |
| 対応モデル | 記載が旧世代 |
| 問題 | トークン抽出は絶対条件 10（秘密情報を扱わない）と原則（Cookie/Token 抽出禁止）に反する。依存先 `re_gpt` が死んでいる |

**判断: フォーク・修理せず不採用。**

### 1.2 G4F / GPT4Free（依存しない）

| 観点 | 結果 |
|---|---|
| 状態 | 現在も大規模に保守。複数プロバイダー、OpenAI 互換 REST API、GUI、Python/JS クライアント |
| 問題 1 | 単一の自分の ChatGPT 契約を使う用途に対して過大 |
| 問題 2 | HAR、Cookie、ブラウザ認証、非公開 Web エンドポイント、Proof Token 等への依存が増えやすい（Issue #3369 の nodriver / HAR / proof token 失敗例） |
| 問題 3 | ChatGPT 側の通信方式変更（SSE→WebSocket 等）、認証変更、モデル識別子変更への追従が必要（Issue #3404 の thinking effort / transport 変更例） |
| 問題 4 | 指定モデルが本当に使われたか、暗黙フォールバックが発生していないかを保証しづらい |
| 問題 5 | 認証情報の保存・漏洩リスクが大きい |

**判断: 参考実装として読むことは許容。依存ライブラリ・土台としては採用しない。**

### 1.3 ブラウザ UI 自動化（採用）

内部 API を再現するより、ChatGPT の通常 Web UI を可視ブラウザで操作する薄いブリッジの方が保守範囲を限定できる。

Playwright の関連機能:

- Locator による自動待機とリトライ（`getByRole` 等のアクセシビリティ優先ロケータ）
- `launchPersistentContext` による永続ブラウザコンテキスト（ログイン状態は user data directory 内に保持される。`storageState` の書き出し・読み込みは本プロジェクトでは使わない — SEC-002）
- スクリーンショット、動画、Trace Viewer
- TypeScript との良好な統合

**Playwright 公式の警告（2026-09-14 再確認）**: `launchPersistentContext` のドキュメントは "Chromium/Chrome: Due to recent Chrome policy changes, automating the default Chrome user profile is not supported." と明記し、専用の user data directory を作るよう案内している。

### 1.4 規約・アカウントリスク

OpenAI の個人向け利用規約（Terms of Use）には、データや Output を自動・プログラム的に抽出すること、レート制限・保護措置を迂回すること等の禁止が記載されている（PO 調査 2026-09-14）。

> **再確認状況**: 2026-09-14 に Claude が https://openai.com/policies/row-terms-of-use/ を自動取得しようとしたが HTTP 403 で取得できなかった。本項は PO 調査結果を仮定として引き継ぐ。**Phase 3 の設計 Freeze 前に PO が手動で最新版を確認すること（未決事項 OQ-001）。**

法的評価は断定しない。ただしリスクを隠さない。詳細は `03-RISK-REGISTER.md` R-001。

## 2. 決定（Decision Record 要約）

正式 ADR は Phase 2 で `docs/adr/` に作成する。本節はその前段の決定とその根拠である。

### D-01 UI ブリッジ方式を採用し、Sengpt / G4F を採用しない

- **根拠**: 1.1〜1.3。内部 API の再現は認証・転送方式・モデル識別子の変更へ追従し続ける必要があり、かつ Cookie/HAR/Proof Token 等の秘密情報を扱う。UI 操作は「人間がやること」を代行するだけで保守範囲が DOM に限定される。
- **却下案**: Sengpt フォーク（死んだ依存）、G4F 依存（過大・秘密情報・暗黙フォールバック）。
- **再考トリガー**: ChatGPT が公式にローカル連携（拡張 API 等）を提供した場合。

### D-02 TypeScript + Playwright を採用する

- **根拠**: Locator の自動待機、永続コンテキスト、Trace Viewer による失敗解析、TypeScript strict による契約の型付け、Claude Code / Codex がともに扱いやすい。
- **却下案**: Python + Playwright（PO の他プロジェクトとの親和性・Node LTS が既に環境にある点で TS が優位）、Puppeteer（Locator/trace の成熟度で劣る）、Selenium（同上）。
- **再考トリガー**: Playwright が Chrome 系永続プロファイルをサポートしなくなった場合。

### D-03 専用永続プロファイルを使う

- **根拠**: Playwright 公式が通常 Chrome プロファイルの自動化を非サポートと明記。通常プロファイルには他サイトの Cookie・パスワードが含まれ、絶対条件 4・10 に反する。専用プロファイルなら失効時も被害範囲が ChatGPT セッションに限定される。
- **却下案**: 通常プロファイルの複製（Cookie DB を読む＝秘密情報操作）、`storageState` の JSON 書き出し（Cookie をプログラムへ露出させる）。
- **再考トリガー**: なし（絶対条件）。

### D-04 可視ブラウザを基本とする

- **根拠**: 絶対条件 5。CAPTCHA・再ログイン・同意画面など人間の介入が必要な場面で、そのまま同じウィンドウで操作できる。headless は bot 判定を受けやすく、検知回避（禁止事項）を誘発する。
- **却下案**: headless 既定。
- **再考トリガー**: MVP 後、PO が明示的に headless 検証を指示した場合のみ検討。検知回避は引き続き禁止。

### D-05 単一リクエストを直列処理する

- **根拠**: 絶対条件 6。二重送信・プロファイル競合・レート制限を根本的に避ける最も単純な方法。用途が低頻度なので並列の価値が無い。
- **却下案**: キュー常駐＋複数タブ。
- **再考トリガー**: MVP 後、ファイルキュー監視を検討する際も「同時に 1 件」を維持する。

### D-06 内部 API、HAR、Cookie 抽出をしない

- **根拠**: 絶対条件 8・10。規約リスク（1.4）を増大させ、秘密情報の漏洩経路を作り、ChatGPT 側の変更に脆い。
- **却下案**: `page.route` / `waitForResponse` による内部 SSE 監視で完了検出する案 → 内部 API への依存になるため **不採用**。完了検出は DOM 信号で行う（FR-026, FR-027）。
- **再考トリガー**: なし（絶対条件）。

### D-07 モデル / effort が確認できなければ fail closed

- **根拠**: 絶対条件 7。ChatGPT UI は既定モデルを暗黙に変える可能性があり、「pro を頼んだつもりが instant だった」は静かな品質劣化になる。呼び出し元（Claude Code）は回答の質を検証しにくいので、ブリッジが保証する必要がある。
- **却下案**: 見つからなければ `current` で送る。
- **再考トリガー**: なし（絶対条件）。

### D-08 OCR・画面座標ベースの文字回収をしない

- **根拠**: 絶対条件 9。Markdown 構造（コードブロック、表）が失われる。DOM またはコピー操作で取得できる。
- **再考トリガー**: なし。

## 3. 参考にする一次情報

| 資料 | URL | 再確認 2026-09-14 |
|---|---|---|
| OpenAI Terms of Use | https://openai.com/policies/row-terms-of-use/ | 403 で自動取得不可。PO 手動確認待ち（OQ-001） |
| Playwright launchPersistentContext | https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context | 確認済み。デフォルトプロファイル非サポートの警告あり |
| Playwright Locators | https://playwright.dev/docs/locators | Phase 2 で参照 |
| Playwright Best Practices | https://playwright.dev/docs/best-practices | Phase 2 で参照 |
| Playwright Trace Viewer | https://playwright.dev/docs/trace-viewer | Phase 2 で参照 |
| Sengpt | https://github.com/SenZmaKi/Sengpt | 確認済み。2024-09-14 アーカイブ |
| GPT4Free | https://github.com/xtekky/gpt4free | PO 調査を引き継ぐ |
| G4F issue #3404 | https://github.com/xtekky/gpt4free/issues/3404 | PO 調査を引き継ぐ |
| G4F issue #3369 | https://github.com/xtekky/gpt4free/issues/3369 | PO 調査を引き継ぐ |
| Claude Code model config | https://docs.anthropic.com/en/docs/claude-code/model-config | Phase 3 以降で参照 |
| OpenAI Codex models | https://developers.openai.com/codex/models | Phase 3 以降で参照 |

## 4. 環境調査結果（2026-09-14）

| 項目 | 値 |
|---|---|
| OS | Windows 11 Pro 10.0.26200 |
| Shell | PowerShell 5.1（`&&` 非対応）/ Git Bash 利用可。**PowerShell 7（`pwsh`）は未インストール**（OQ-008） |
| Node.js | v24.16.0（LTS 系）|
| npm | 11.13.0 |
| pnpm / yarn | 未インストール → **npm を採用** |
| git | 2.49.0.windows.1 |
| gh | 2.95.0 |
| Claude Code | 2.1.261 |
| Codex CLI | 0.153.4。`codex exec` に `--ephemeral`, `-C <dir>`, `-m <model>`, `-c key=value`, `-o <file>`, `--output-schema`, `--json`, `-s read-only` あり。既定 `model="gpt-5.6-terra"`, `model_reasoning_effort="high"` |
| Playwright ブラウザキャッシュ | `%LOCALAPPDATA%\ms-playwright` に chromium-1181/1200/1228, firefox, webkit あり |
| Google Chrome | `C:\Program Files\Google\Chrome\Application\chrome.exe` あり |
| Microsoft Edge | あり |
| リポジトリ | 新規作成 `S:\Projects\chatgpt-web-bridge`。既存 README / CLAUDE.md / AGENTS.md / package.json は無し |
| Git 設定 | `init.defaultBranch` 未設定（`-b main` で初期化）、`core.autocrlf` 未設定（Phase 2 で `.gitattributes` を検討） |

## 5. 本フェーズで置いた仮定

`DECISION-LOG.md` の A-001〜 を参照。

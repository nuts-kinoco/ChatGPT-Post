# ChatGPT Web Bridge

ログイン済みの専用ブラウザプロファイルを使って ChatGPT Web へ単発プロンプトを送信し、生成完了後の回答を Markdown と機械可読な結果 JSON として返す、Windows 優先・ローカル専用・直列実行型の CLI ブリッジ。

Claude Code 等のローカルオーケストレータが、人間のコピー＆ペーストなしに ChatGPT Web を「外部アドバイザー」として使えるようにすることが目的です。

## 現状

**Phase 7（運用手順・最終レビュー）実施中。契約 1.2。** 実ブラウザで次が動いています（すべて 2026-09-15 の Live で確認、[docs/live-results/](docs/live-results/)）:

- 1 往復の質問 → `response.md` + `result.json`（28〜66 s）
- 思考量 5 段階（Instant / 中程度 / 高 / 極高 / Pro）とモデル（最新 / GPT-5.6 Sol / GPT-5.5）の選択と読み戻し確認
- ファイル添付（秘密ガード付き）、`bundle` によるリポジトリの Markdown 化、57 k 文字の参照
- 生成画像の受け取り（`images/1.png`）、画像添付からの説明・タグ付け
- 同一会話への追記、ファイルキュー `worker`、`usage` による使用量の目安
- コードレビュー: 仕込んだバグ 3/3 発見・誤検出 0、修正パッチは `git apply` 通過

使い方は [docs/20-COMMAND-REFERENCE.md](docs/20-COMMAND-REFERENCE.md)（貼り付け用）、運用は [docs/17-OPERATIONS.md](docs/17-OPERATIONS.md)、他 PJ の Claude Code / Codex からは [skills/chatgpt-bridge/SKILL.md](skills/chatgpt-bridge/SKILL.md)。進捗は [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md)。

## 方針（要約）

- OpenAI API は使わない（追加 API 費用ゼロ）。ChatGPT Web の通常 UI を Playwright で操作する。
- 通常の Chrome プロファイルは自動化しない。`runtime/profile/` の専用永続プロファイルを使う。
- 可視ブラウザ、単一リクエスト直列処理。
- モデル / effort が UI で確認できなければ送信しない（fail closed）。
- 内部 API・Cookie・HAR・トークン抽出、CAPTCHA / bot 検知の回避、stealth・UA 偽装は一切行わない。
- CAPTCHA・再ログイン・利用上限は `manual_intervention_required` で停止し、人間に委ねる。

## 重要な注意（削除しないこと）

- **規約・アカウントリスク**: OpenAI の利用規約は Output の自動・プログラム的な抽出やレート制限・保護措置の迂回等を禁止しています。本ツールは通常 UI を自動操作するため、アカウント警告・停止のリスクがあります。本プロジェクトは法的評価を断定しません。個人のローカル・低頻度・直列利用を前提とし、回避技術は実装しません。詳細: [docs/03-RISK-REGISTER.md](docs/03-RISK-REGISTER.md) R-001。
- **秘密情報**: `runtime/` 配下（ブラウザプロファイル、プロンプト、回答、trace、スクリーンショット）は Git 管理外です。Playwright trace とスクリーンショットには認証情報・個人情報が含まれ得るため、第三者へ共有しないでください。
- **データ保持**: プロンプトと回答はローカルにのみ保存され、MVP では自動削除されません。

## 文書

| 文書 | 内容 |
|---|---|
| [docs/00-PRODUCT-BRIEF.md](docs/00-PRODUCT-BRIEF.md) | 目的、利用フロー、MVP 境界、絶対条件 |
| [docs/01-RESEARCH-AND-DECISION.md](docs/01-RESEARCH-AND-DECISION.md) | Sengpt / G4F / UI 自動化の調査と方式決定、環境調査 |
| [docs/02-REQUIREMENTS.md](docs/02-REQUIREMENTS.md) | 要件（CON / FR / NFR / SEC / OPS）と MoSCoW、未決事項 |
| [docs/03-RISK-REGISTER.md](docs/03-RISK-REGISTER.md) | リスク登録簿 |
| [docs/04-ACCEPTANCE-CRITERIA.md](docs/04-ACCEPTANCE-CRITERIA.md) | 受入条件 |
| [docs/05-PHASE-PLAN.md](docs/05-PHASE-PLAN.md) | フェーズ計画とゲート |
| [docs/DECISION-LOG.md](docs/DECISION-LOG.md) | 軽微な判断・仮定 |
| [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) | 現在の状態 |
| [docs/10-ARCHITECTURE.md](docs/10-ARCHITECTURE.md) | コンポーネント、データフロー、完了検出、抽出 |
| [docs/11-STATE-MACHINE.md](docs/11-STATE-MACHINE.md) | 状態遷移表、送信境界、再試行の限定 |
| [docs/12-IO-CONTRACT.md](docs/12-IO-CONTRACT.md) | request.json / result.json / response.md の契約 |
| [docs/13-ERROR-MODEL.md](docs/13-ERROR-MODEL.md) | エラーコード、終了コード |
| [docs/14-SELECTOR-STRATEGY.md](docs/14-SELECTOR-STRATEGY.md) | selector 集約、多言語、UI 変更時の手順 |
| [docs/15-SECURITY-AND-PRIVACY.md](docs/15-SECURITY-AND-PRIVACY.md) | 信頼境界、禁止 API、trace サニタイズ、redaction |
| [docs/16-TEST-STRATEGY.md](docs/16-TEST-STRATEGY.md) | Unit / Fixture / Live |
| [docs/17-OPERATIONS.md](docs/17-OPERATIONS.md) | セットアップ、運用、トラブルシューティング |
| [docs/adr/](docs/adr/) | ADR 001〜005 |
| [schemas/](schemas/) | request / result の JSON Schema |

## セットアップと使い方

```powershell
npm ci
npm run build
npm test            # unit + fixture（Chrome の headless で DOM スナップショット。ChatGPT には接続しない）
npm link            # chatgpt-bridge をグローバルコマンドに
chatgpt-bridge doctor
```

初回ログイン（Google アカウントの場合は自動操作なしの通常 Chrome を専用プロファイルで起動して行う。[docs/17-OPERATIONS.md](docs/17-OPERATIONS.md) §2）:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="<repo>untime\profile" https://chatgpt.com/
```

```powershell
chatgpt-bridge run --request .untimeequests\<id>equest.json --json   # 1 件
chatgpt-bridge worker --queue <dir> --drain                                  # キュー
chatgpt-bridge bundle --root <repo> --include "src/**/*.ts" --out context.md # リポジトリを Markdown に
chatgpt-bridge usage                                                         # 使用量の目安
chatgpt-bridge inspect-ui --walk-effort                                      # UI 変更時の診断（送信しない）
```

`request.json` / `result.json` の契約は [docs/12-IO-CONTRACT.md](docs/12-IO-CONTRACT.md)。プロンプトの型は [prompts/](prompts/)、ベストプラクティスは [docs/22-BEST-PRACTICES.md](docs/22-BEST-PRACTICES.md)、活用範囲の所見は [docs/21-CAPABILITY-EXPLORATION.md](docs/21-CAPABILITY-EXPLORATION.md)。

## 技術構成

Node.js 24 / TypeScript strict / Playwright 1.63（既定はインストール済み Google Chrome チャネル）/ npm / Ajv / turndown / vitest / Biome。詳細は `docs/10-ARCHITECTURE.md`。

## ライセンス

未定（Phase 7 で決定）。

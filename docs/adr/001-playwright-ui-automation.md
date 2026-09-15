# ADR-001: ChatGPT Web の通常 UI を Playwright（TypeScript）で自動操作する

- 状態: Accepted（Phase 2、2026-09-14）。**FROZEN FOR MVP v1.0（Phase 3、2026-09-15）**
- 関連: `01-RESEARCH-AND-DECISION.md` D-01, D-02, D-06, D-08 / CON-001, CON-002, CON-008, CON-009

## 文脈

PO は OpenAI API の従量課金を使わず、ChatGPT 契約の Web UI を Claude Code から利用したい。既存手段は Sengpt（アーカイブ済み、トークン抽出方式）と G4F（大規模、内部エンドポイント・HAR・Proof Token 依存、暗黙フォールバック）で、いずれも秘密情報を扱い、ChatGPT 側の内部変更に脆い。

## 決定

- ChatGPT の通常 Web UI を、人間と同じ操作（新規チャット → preset 確認 → 入力 → 送信 → 待機 → コピー）で Playwright により代行する。
- 言語は TypeScript strict、ランタイムは Node.js LTS。
- 内部 / 非公開 API の呼び出し、ネットワーク傍受（`page.route`, `waitForResponse`）、HAR、Cookie / トークン抽出、OCR は行わない。完了検出は DOM 信号のみで行う。

## 理由

- 保守範囲が DOM に限定され、selector を一か所に集約すれば UI 変更への追従が局所化する。
- Playwright は accessible-name ベースの Locator、永続コンテキスト、Trace Viewer を備え、失敗解析と fixture テストが容易。
- 内部 API を触らないことで規約リスク（R-001）の増大と秘密情報の漏洩経路（R-009）を避ける。

## 却下した代替案

| 案 | 却下理由 |
|---|---|
| Sengpt フォーク | 依存 `re_gpt` が死亡。トークン抽出は CON-010 違反 |
| G4F 依存 | 過大。内部エンドポイント・Proof Token・HAR 依存。モデル指定の保証が弱い |
| 内部 SSE / WebSocket 監視で完了検出 | 内部 API への依存になる（CON-008） |
| Chrome 拡張 + Native Messaging | MVP 後の再評価候補。拡張の配布・権限管理が増える |
| Python + Playwright | 環境に Node LTS があり、Claude Code / Codex との親和性で TS が優位 |

## 影響

- UI 変更のたびに selectors の更新が必要（R-002。`inspect-ui` と fixture で緩和）。
- 規約・アカウントリスクは残る（R-001。削除禁止）。
- 送信 → 回答の遅延はブラウザ描画に依存し、API より遅い。用途（低頻度・単発）では許容。

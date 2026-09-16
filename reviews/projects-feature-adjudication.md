# Projects 連携（A-106）— Codex レビュー裁定

日付: 2026-09-16 / 対象: 未コミットの A-106 差分 / 入力: `reviews/projects-feature-codex.md`（Codex, gpt-5.6-terra, high, read-only）

| # | 重要度 | 内容 | 裁定 | 対応 |
|---|---|---|---|---|
| P-1 | High | `controller.ts` の会話 URL 捕捉が `CONVERSATION_PATH_RE`（pathname のみ）に統一された際、従来の origin チェック（`startsWith("https://chatgpt.com/c/")`）が失われ、外部 origin の同形パスを `conversationUrl` として保持し得る | **採用** | `new URL(url).origin === CHATGPT_ORIGIN` を明示的に再導入し、`CONVERSATION_PATH_RE.test(pathname)` と両方成立したときのみ捕捉するよう修正 |
| P-2 | Medium | `project` フィールドの説明が「1.3」限定であるかのように書かれているが、`allOf` は `schemaVersion` を条件にしておらず実際は任意のバージョンで有効 | **採用（表現修正のみ）** | 既存の `model`/`attachments` と同様「schemaVersion は文書上の目安で、実際の enforcement ではない」という本プロジェクトの既存方針に合わせて説明文を修正。新たな version gating は既存方針との一貫性を崩すため追加しない |
| P-3 | Medium | A-106 の受理・拒否条件（project 単体 OK、project+conversationUrl 拒否、nested conversationUrl 許可、外部 origin 拒否、controller の捕捉ロジック）を直接検証する単体テストが無い | **採用** | `tests/unit/contracts.test.ts` に schema レベルのテストを追加（project 単体/相互排他/外部 origin/誤ったパス形/nested conversationUrl 許可・外部 origin 拒否）。`tests/unit/controller.test.ts` に P-1 修正を検証する専用テストを追加（nested URL 捕捉、外部 origin 非捕捉） |
| P-4 | Low | `CONVERSATION_PATH_RE`/`project` の pattern が実測形式より広く（hash/slug の厳密な形を要求しない）、page.ts と schema で重複している | **見送り** | ReDoS 等の実害は無いと Codex 自身も判定。共通定数への統合は理想だが JSON schema が JS 定数を import できない制約上、コメントで同期を明記する対応（既に実施済み）に留める。実害の無い将来的なクリーンアップとして記録のみ |

## 修正後の検証

- `npm run typecheck` / `npm run lint` / `npm run build`: OK
- `npm test`: **143 passed**（140 → +3、P-3 の新規テスト）
- Live: `chatgpt-bridge run` で `project` 指定により実際に PixivVault Project 内へ新規チャットが作成されることを確認（Project のチャット一覧に反映）。そのチャットの `conversationUrl`（`/g/g-p-.../c/<id>` 形式）で `newChat:false` の継続送信も正常動作を確認

# ADR-004: 回答抽出はページ内コピー捕捉 → DOM→Markdown → innerText の多段方式。システムクリップボードは使わない

- 状態: Accepted（Phase 2、2026-09-14）。**FROZEN FOR MVP v1.0（Phase 3、2026-09-15）**
- 関連: `10-ARCHITECTURE.md` §7 / FR-030〜034 / OQ-003, OQ-007 / R-008

## 文脈

ChatGPT の回答は Markdown としてレンダリングされる。最も忠実な Markdown は「コピー」操作が生成するテキストだが、その内容が Markdown かどうかは未確認（OQ-003）。またコピー操作はシステムクリップボードに書くため、PO の同時作業と衝突する（OQ-007）。OCR は禁止（CON-009）。

## 決定

1. 抽出対象は「送信後に出現した最新の assistant ターン」。送信後のターン増分が 2 以上（A/B 比較等）なら完了判定が `CHAT_ERROR(multiple_responses)` にするため抽出には至らない。Canvas 等のサイドパネルが可視なら `EXTRACTION_FAILED(canvas)` で fail closed。
2. 方式の優先順位:
   - `copy`: `run` のコンテキストにのみ `context.addInitScript` で `navigator.clipboard.writeText` / `write` をページ内でフックし、書き込まれたテキストを `window.__bridgeCopyCapture` に保持する（`login` / `doctor` / `inspect-ui` では登録しない）。クリック直前に捕捉変数をリセットし、最新ターンの **メッセージ単位**のコピー操作（コードブロックの Copy は除外）をクリックして捕捉テキストを得る。コピー操作が見つからない／複数ある場合は `dom` へ降格し `DOM_CHANGED` にしない。**システムクリップボードへは書かず、読まない。**
   - `dom`: 本文要素の HTML を turndown（gfm、KaTeX `annotation` → `$...$`、コードブロック言語クラス → fence 言語）で Markdown 化。
   - `innerText`: 最後の手段。`extractionQuality: degraded`。
3. 抽出の入口で本文 `innerText` が空なら方式 1〜3 を試さず `EXTRACTION_FAILED(empty)`。`copy` / `dom` の結果は同メッセージの `innerText` と照合（正規化後の先頭・末尾 200 文字の包含、長さ比 0.5〜3.0）し、不合格なら次の方式へ。
4. `result.json` に `extractionMethod` と `extractionQuality` を記録する。
5. Phase 4 の実画面確認（OQ-003）で、コピー操作が `navigator.clipboard.writeText` / `write` を呼ばない（`document.execCommand('copy')` 等。シムでは捕捉も抑止もできない）か、Markdown を返さない（プレーンテキスト）と判明した場合は、`copy` 方式を廃止し `dom` を第 1 方式にする（本 ADR を改訂）。「システムクリップボードへ書かない」はこの確認が通った場合にのみ成立する。

## 理由

- ページ内フックにより OQ-007 の衝突問題が消え、`clipboard-read` 権限も不要になる。
- 照合により「クリップボードの中身が別物」「DOM 変換で大幅欠落」を `completed` として返すことを防ぐ（失敗を成功と報告しない）。
- 多段方式は UI 変更への耐性を上げる。

## 却下した代替案

| 案 | 却下理由 |
|---|---|
| システムクリップボードを読む（`navigator.clipboard.readText`） | PO の作業と衝突、権限付与が必要、他アプリの上書きで誤取得 |
| `dom` のみ | ChatGPT 固有レンダリング（数式・引用内コード）で欠落し得る。コピーが Markdown を返すならそちらが忠実 |
| 内部 API の応答（SSE）から Markdown を得る | CON-008 違反 |
| OCR | CON-009 違反 |

## 影響

- `addInitScript` は製品コード唯一のページ内スクリプトであり、検知回避目的ではないことを 15-SECURITY §6 に明記。
- コピー操作のボタンが無い UI 状態では `dom` に自動フォールバックする。

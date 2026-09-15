# ADR-003: ファイルベースの入出力契約（request.json / result.json / response.md、アトミック書き出し、1 リクエスト 1 ディレクトリ）

- 状態: Accepted（Phase 2、2026-09-14）。**FROZEN FOR MVP v1.0（Phase 3、2026-09-15）**
- 関連: `12-IO-CONTRACT.md`, `schemas/*.json` / FR-007〜014, FR-032 / OQ-006

## 文脈

呼び出し元は Claude Code 等のローカルプロセスで、人間のコピー＆ペーストを無くすことが目的。REST / RPC / キューは MVP 外（FR-093）。

## 決定

1. 入力は `request.json`（JSON Schema で検証）と `promptFile`（UTF-8 Markdown）。出力は同一ディレクトリの `result.json` と `response.md`。
2. `schemas/request.schema.json` / `result.schema.json` を唯一の契約とし、実行時に Ajv で検証する（型は schema から導出）。
3. `requestId` は呼び出し元が生成する。形式 `^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$`、推奨 `<yyyyMMddTHHmmssZ>-<8 hex>`。
4. `result.json` は終端時に必ず書く。例外は (1) request.json 不読、(2) `ALREADY_PROCESSED`、(3) `ALREADY_RUNNING`、(4) result.json 自身の書き出し失敗。(2)(3) は既存・進行中の結果を保護するため。
5. 書き出しは tmp → fsync → rename（同一ディレクトリ）。`response.md` → `result.json` の順。
6. `result.json` に `submitted: yes | no | unknown` を持たせ、呼び出し元が「送信された可能性」を判断できるようにする。
7. `newChat` は MVP で `true` のみ。`responseFormat` は `markdown` のみ。未知フィールドは拒否。

## 理由

- ファイルは Claude Code から最も扱いやすく、プロセス境界が明確で、テストが容易。
- 1 リクエスト 1 ディレクトリにすることで requestId ごとの成果物が自己完結し、冪等判定（result.json / marker の有無）が単純になる。
- `submitted` は二重送信防止（R-003）の呼び出し元側の担保。
- UUID v7 ライブラリを避け、PowerShell だけで生成できる時系列 ID を推奨する。

## 却下した代替案

| 案 | 却下理由 |
|---|---|
| 標準入出力のみ | 長文・Markdown・バイナリ安全性・途中書き込みの問題。終端の合図が曖昧 |
| `--output-dir` オプション | 出力先が分散し冪等判定が複雑になる。MVP では不要（OPS-010） |
| zod で型定義し schema を生成 | 契約の出典が二重になる。Codex レビューや他言語の呼び出し元が読むのは JSON Schema |
| `ALREADY_PROCESSED` でも result.json を上書き | 既存の `completed` 結果を破壊し呼び出し元が誤読する（R-011） |

## 影響

- 呼び出し元は `result.json` の出現を待ってから読む必要がある（Phase 6 の wrapper が担う）。
- スキーマ変更は `schemaVersion` を上げる。

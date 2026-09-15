## 指摘

- [High] `src/chatgpt/page.ts:215` — 会話 URL の遷移後、`pathname` しか照合しておらず origin を再検証していません。再現条件: `https://chatgpt.com/c/<id>` が同一パスの別 origin にリダイレクトされ、そこに composer が存在する場合、プロンプトを送信し得ます。 — `new URL(this.page.url()).origin === CHATGPT_ORIGIN` も必須条件にしてください。

- [High] `src/cli/worker.ts:90` — `running` から終端ディレクトリへの `rename()` が失敗すると例外が上位まで伝播し、対象は `running/` に孤立します。再現条件: Windows で対象または移動先を他プロセスが開いている、あるいは rename 非対応の配置で、runner が終了コードを返す場合。次回 `--drain` は `pending/` だけを見て正常終了するため、孤立項目は永久に処理されません。 — rename 失敗を捕捉して明示的な停止結果・ログにし、再開時の `running/` 回復／隔離方針を実装してください。

- [Medium] `schemas/result.schema.json:290`, `src/contracts/invariants.ts:16` — `images[]` は任意の非空文字列を許容し、`checkResultInvariants()` も相対パス・`images/` 配下・画像のみという契約を検査しません。`../`、絶対パス、無関係なファイルを含む completed result が通ります。 — schema に `images/<連番>.<許可拡張子>` の pattern を入れ、invariant でも重複・パス逸脱・成功状態との整合を検査してください。

- [Low] `src/chatgpt/page.ts:828`, `src/state/ports.ts:164` — コメントは viewer download を第1経路、in-page fetch を fallback と説明しますが、実装は A-092 どおり fetch を第1経路にしています。 — コメントを実装・決定記録に合わせて更新してください。

- [Low] `src/cli/worker.ts:85` — busy 項目は lexical order の先頭に戻るため、`--drain` 中は後続項目が最大 retry 回数まで待たされます。 — busy 再試行を後続項目の処理後に回すか、再試行時刻を持つ方式を検討してください。

## 設計との乖離一覧

| 項目 | 状態 |
|---|---|
| A-096 の「会話 URL で既存会話のみを開く」 | リダイレクト後の origin 確認が欠ける |
| A-094 のキュー状態遷移 | rename 失敗時に `running/` からの回復経路がない |
| 契約 1.2 の `images[]` は requestDir 相対 | schema / invariant がパス制約を強制しない |
| A-092 の fetch-primary | 実装は一致、コメントのみ旧設計のまま |

## 良い点

- `openConversation()` は入力 URL を origin・`/c/<id>` 形式で絞り、既存 assistant turn、非生成中、空 composer を確認してから送信しています。
- 画像のみのターンで保存画像ゼロなら `EXTRACTION_EMPTY` に戻すため、保存失敗を成功扱いしません。
- worker は pending ディレクトリ名を `isValidRequestId()` で検証しており、`..` や不正なパス片を処理対象から除外しています。
- viewer 操作は opt-in で、viewer 内の Save / Close に scope を限定しています。
- 対象ユニットテストは read-only 環境のため Vite の一時設定ファイルを作成できず実行不能でした（`EPERM`）。
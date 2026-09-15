# バッチ分類 / タグ付け

request id: `{{requestId}}`

添付の `items.jsonl` は 1 行 1 件の JSON です（`id` と `text` [と `image` の名前]）。各件に対して以下のラベルを付けてください。

## ラベル定義
{{ラベル名: 定義（曖昧さを減らす例を 1 つずつ）}}

## ルール
- 出力は **JSON Lines のみ**（説明文なし）。1 行 1 件、`{"id": ..., "labels": [...], "confidence": 0-1, "note": "任意"}`
- 判断できないものは `labels: []` と `note` に理由
- 入力に無い id を作らない。全件を出す

## 出力
先頭行に `{"requestId": "{{requestId}}"}` を置き、その後に各件の JSON 行。

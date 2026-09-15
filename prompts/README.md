# prompts/ — ブリッジ向けプロンプトテンプレート

`{{...}}` を埋めて `runtime/requests/<requestId>/prompt.md` にする。原則は `docs/22-BEST-PRACTICES.md` §2。
すべて「requestId を先頭に書き、回答にも書かせる」「分からないものは分からないと書かせる」「材料は添付」を共通にしている。

| ファイル | 用途 | 推奨 preset |
|---|---|---|
| second-opinion.md | 設計判断のセカンドオピニオン | high / extra_high |
| code-review.md | 機能バグ中心のレビュー | high |
| bug-hunt-bundle.md | bundle を添付して横断的な不整合探し | extra_high |
| patch-request.md | unified diff での修正パッチ | high |
| research-brief.md | 調査（公式と推測を分ける） | high |
| classify-batch.md | JSON Lines のバッチ分類 | instant / medium |

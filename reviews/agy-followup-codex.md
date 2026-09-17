レビュー結果: 現状は **修正(2)に重大な取りこぼしがあり、承認不可**です。修正(1)は安全側ですが、設定上の意味が変わる副作用があります。

- **重大 — emergency fallback も `error.cause` のスキーマ上限を超え、結果ファイルが依然として消える。**  
  [src/state/controller.ts:31](S:/Projects/chatgpt-web-bridge/src/state/controller.ts:31) の `sanitiseResultText()` は最大 500 文字ですが、[schemas/result.schema.json:71](S:/Projects/chatgpt-web-bridge/schemas/result.schema.json:71) は `error.cause` を最大 200 文字に制限しています。  
  新設 fallback も [src/state/controller.ts:672](S:/Projects/chatgpt-web-bridge/src/state/controller.ts:672) で同じ 500 文字上限の値を `error.cause` に入れるため、201–500 文字の原因で通常書込みが失敗した場合、再試行も同じ `maxLength` 違反で失敗します。実害として、複数の検証エラーを join する経路（[src/state/machine.ts:368](S:/Projects/chatgpt-web-bridge/src/state/machine.ts:368)）などで容易に発生し得ます。  
  `error.cause` 専用に「redact 後 200 文字へ切詰める」関数を使い、テストは実際の invariant 検証を通して 201 文字以上の cause で fallback が書けることを確認すべきです。

- **高 — `emergencyResult()` は「常にスキーマ適合」「最小限」ではない。**  
  [src/state/controller.ts:644](S:/Projects/chatgpt-web-bridge/src/state/controller.ts:644)–[665](S:/Projects/chatgpt-web-bridge/src/state/controller.ts:665) は `bridgeVersion`、`requestId`、要求 preset/model、URL、時刻、duration、既存 warnings を元の不正 result からコピーします。特に warnings はスキーマ上、各要素が空文字不可です（[schemas/result.schema.json:310](S:/Projects/chatgpt-web-bridge/schemas/result.schema.json:310)）。したがって、元の失敗が warnings の空文字、bridgeVersion の空文字、将来追加される enum/format 制約などなら fallback も失敗します。  
  fallback は契約値を固定し、採用する外部由来値はそれぞれ契約に合わせて再検証・正規化する必要があります。少なくとも copied warnings は捨てるか、空文字除外・sanitize を行うべきです。

- **高 — 書いた `result.json` と CLI/API が返す result が不一致になる。**  
  fallback 成功時も [src/state/controller.ts:495](S:/Projects/chatgpt-web-bridge/src/state/controller.ts:495) が `this.result = result`（元の不正オブジェクト）を保持します。一方ディスクには fallback が書かれます。`--json` はその `outcome.result` を「result.json content」として stdout に出力するため（[src/cli/main.ts:233](S:/Projects/chatgpt-web-bridge/src/cli/main.ts:233)–[243](S:/Projects/chatgpt-web-bridge/src/cli/main.ts:243)）、監視側は stdout では未知の error code、ファイルでは `INTERNAL_ERROR` を受け取ります。テストもこの不一致を意図的に固定しています（[tests/unit/controller.test.ts:451](S:/Projects/chatgpt-web-bridge/tests/unit/controller.test.ts:451)–[459](S:/Projects/chatgpt-web-bridge/tests/unit/controller.test.ts:459)）。  
  fallback 成功時は `this.result` に fallback 自体を保存し、stdout・RunOutcome・result.json を同一契約文書に揃えるべきです。

- **中 — profileDir 比較の除去は fail-closed だが、独立 profile の daemon まで恒久的に停止させ得る。**  
  [src/browser/daemon.ts:131](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:131)–[135](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:135) は、同じ `runtimeDir` にある有効な foreign state を profile に関係なく busy とします。コメント自身が `CHATGPT_BRIDGE_PROFILE_DIR` の独立指定をサポートしていると認めています（[src/browser/daemon.ts:117](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:117)–[121](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:121)）。その構成で、同一 runtimeDir・別 profile の二台は安全に共存できるのに、後から起動する側を拒否します（[src/browser/daemon.ts:262](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:262)–[270](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:270)）。これは安全性を下げず availability を下げる新しい誤検知です。さらに表示文言の「この profile を使用中」（[src/browser/daemon.ts:183](S:/Projects/chatgpt-web-bridge/src/browser/daemon.ts:183)）も事実でなくなります。  
  方針としては、`runtimeDir` を profile 専有の排他単位として明文化するか、共有マウントでも同一に解決できる明示的な profile identity を state に持たせる必要があります。後者なしにパス文字列比較へ戻すのはクロスホスト問題を再発させます。

確認できた点として、fallback の phase 選択そのものは正しいです。[src/state/controller.ts:635](S:/Projects/chatgpt-web-bridge/src/state/controller.ts:635)–[641](S:/Projects/chatgpt-web-bridge/src/state/controller.ts:641) は `INTERNAL_ERROR` に対し、`no → VALIDATED`、`unknown → PROMPT_SUBMITTING`、`yes → WRITING_RESULT` とし、[src/contracts/invariants.ts:52](S:/Projects/chatgpt-web-bridge/src/contracts/invariants.ts:52)–[61](S:/Projects/chatgpt-web-bridge/src/contracts/invariants.ts:61) と整合します。また (1) は foreign state を読むだけで他ホストのファイルを書換えない点は維持されています。

`git diff --cached --check` は通過しました。変更・ブラウザ操作・外部 API 利用は行っていません。
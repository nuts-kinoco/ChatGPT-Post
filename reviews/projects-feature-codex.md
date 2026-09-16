レビュー結果: **High 1件、Medium 2件、Low 1件**です。A-106 の主要フローは概ね fail-closed ですが、会話 URL 捕捉に明確な回帰があります。

- **High — origin 検証が抜け、外部 URL を `conversationUrl` として保持し得る。**  
  [src/state/controller.ts:547](S:/Projects/chatgpt-web-bridge/src/state/controller.ts:547)–552 は pathname だけを `CONVERSATION_PATH_RE` に照合します。従来の `startsWith("https://chatgpt.com/c/")` は origin も制限していました。  
  そのため `https://evil.example/c/x` や `https://evil.example/g/g-p-x/c/y` が捕捉対象になります。結果生成時の [sanitiseConversationUrl](S:/Projects/chatgpt-web-bridge/src/state/controller.ts:36)–44 も origin を再検証しません。一方、result schema は `https://chatgpt.com/` を要求するため、成功後の `writeResult` が契約違反で失敗し、完了状態なので stderr に出すだけで終了コード 0 のまま結果ファイルなしになり得ます。  
  `new URL(url)` 後に `u.origin === CHATGPT_ORIGIN && CONVERSATION_PATH_RE.test(u.pathname)` を両方要求してください。できれば URL の parse・origin・path 検証・canonicalization を共有 helper にします。

- **Medium — `project` は「1.3 のみ」という説明と異なり、1.0〜1.2 でも有効です。**  
  [schemas/request.schema.json:77](S:/Projects/chatgpt-web-bridge/schemas/request.schema.json:77)–80 の説明は 1.3 機能ですが、[同:94](S:/Projects/chatgpt-web-bridge/schemas/request.schema.json:94)–145 の `allOf` は `schemaVersion` を条件にしていません。従って `schemaVersion: "1.0", newChat: true, project: ...` が通り、実行時にも Project を開きます。  
  schemaVersion を機能世代の契約として扱うなら、`project` 存在時に `schemaVersion: "1.3"` を必須化すべきです。既存フィールドも世代で gate しない方針なら、説明を「1.3 で導入」に弱め、互換性方針を明記するのが整合的です。

- **Medium — A-106 の動作・拒否条件を直接検証するテストがありません。**  
  [tests/unit/controller.test.ts:60](S:/Projects/chatgpt-web-bridge/tests/unit/controller.test.ts:60)–62 と [tests/unit/error-codes.test.ts:48](S:/Projects/chatgpt-web-bridge/tests/unit/error-codes.test.ts:48)–50 は interface を満たすための fake 追加だけです。既存の request schema テストも [tests/unit/contracts.test.ts:179](S:/Projects/chatgpt-web-bridge/tests/unit/contracts.test.ts:179)–197 の旧 `conversationUrl` ケースに留まります。  
  少なくとも以下を追加すべきです: `newChat:true + project` が `openProject` を呼ぶ、`newChat:false + project` と `newChat:true + conversationUrl` が拒否される、nested Project conversation URL の許可、外部 origin／query／末尾 slash の拒否、controller が外部 origin を保存しないこと。

- **Low — 正規表現は ReDoS ではありませんが、実測形式より広いです。**  
  [src/chatgpt/page.ts:54](S:/Projects/chatgpt-web-bridge/src/chatgpt/page.ts:54)–55 と schema の [conversationUrl pattern](S:/Projects/chatgpt-web-bridge/schemas/request.schema.json:74)、[project pattern](S:/Projects/chatgpt-web-bridge/schemas/request.schema.json:79) は、固定リテラル＋アンカー付き ASCII 文字クラスだけなので ReDoS の懸念はありません。  
  ただし `g-p-[A-Za-z0-9-]+` は、実測された `<hash>-<slug>` の区切りや hash 形状を要求しません。これは将来互換性寄りですが fail-closed の厳密さは下がります。少なくとも `PROJECT_PATH_RE` を導入して page/schema の重複を減らし、実測済み形式をテスト fixture に固定するのがよいです。現時点の証拠だけでは、別の Project URL 形式を「見落としている」とは断定できません。未対応の locale prefix・query・fragment・trailing slash は安全側に拒否されます。

`allOf` の `project` / `conversationUrl` 相互排他は、現行の root-level `type: string` と `required` を前提に正しく効いています。`newChat:false + project`、および `newChat:true + conversationUrl` は拒否されます。

確認済み: `npm.cmd run typecheck` は通過、`git diff --cached --check` は指摘なし。なお staged には `scripts/start-daemon.cmd` もありますが、`runtime/a106-diff.txt` には含まれていません。A-106 専用の監査対象なら、これは別カードの混入として分離確認が必要です。
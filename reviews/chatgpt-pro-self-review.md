# chatgpt-bridge コードレビュー(ChatGPT Pro, self-review)

- 実施日: 2026-09-17〜18
- request: `runtime/requests/20260917T145825Z-cdb9deff/`
- conversationUrl: https://chatgpt.com/c/6aac002d-4df0-83e8-9a0c-ab6853740351
- 注記: 生成はtimeoutMs(15分)を超えて継続し(`GENERATION_TIMEOUT_ACTIVE`, 実測約26分)、
  ブリッヂ自身の自動抽出(`response.md`)は間に合わなかったため、ユーザーが手元のブラウザから
  回答本文をコピペしたものをここに保存している。line番号は `runtime/self-review/context.md`
  (bundleでまとめたファイル、299356 bytes)内の行番号であり、各ソースファイル単体の行番号ではない
  可能性が高い — 引用箇所は実ファイルを直接grepして照合すること。

---

## 総合判定

設計の方向性は妥当。ただし、現状の収録コードを根拠に「安心して人に渡せる」とは言えない。配布判断は見送り。

問題は状態機械の導入や状態数の多さではなく、安全性を確認できなかった場面で周辺実装が
「問題なし」という値を返してしまうことと、ブラウザ・ロック・キューの所有権が一貫して
管理されていないこと。

(以下、原文全文はチャット履歴を参照。本ファイルは記録目的のサマリ版として後日整形する)

## 指摘一覧(見出しのみ、詳細は元チャットログ参照)

1. 設計として筋が通っているか — 中核設計は妥当。所有権モデルが不十分、page.tsの責務過多、
   複数ホスト対応のprofileDir文字列比較(A-113で対応済みのはずだが要再確認)
2. fail-closedの一貫性
   2.1 verifiedOnly=trueで一部selector(continueButton, sidePanel, challengeFrame)がverifiedOn無しで無効化される
   2.2 selectors.ts resolve()がvisible countとfirst()の対象がずれる
   2.3 normalisePrompt()が全空白を削除し意味の異なる文字列を同一視する
   2.4 extraction/verify.tsのcoverage判定(85%語集合一致)が弱くfull判定が甘い
   2.5 markerExists() / priorState() / checkProfileFree()がI/Oエラーを「存在しない」に変換
   2.6 daemon keepaliveがlock protocolに参加せずTOCTOU競合
   2.7 stale lock recoveryのrenameが別プロセスの新lockを上書きしうる
   2.8 browser close timeoutが実質unboundedなfallback待ちを持つ
   2.9 daemon shutdownがcontext.close()のtimeout後もstate file削除を強行
   2.10 AbortSignalがpage.evaluate内fetchに渡っていない
   2.11 daemon PID所有権確認がMacで弱い(processStartedAt常にnull)
   2.12 workerが実行中jobを孤児として誤回収しうる
   2.13 workerがexit codeのみで結果分類し、GENERATION_TIMEOUT_ACTIVE後の再送保護が弱い
   2.14 添付secret scanが2MiB超/非テキスト拡張子をスキップ
   2.15 trace sanitizerが未知entryをそのまま通す(allowlist化を推奨)
3. machine.ts/controller.tsの分離 — 設計は妥当だがcontext.mdから本文が省略されており実装未確認
   (effect逐次実行、cleanup順序、late event抑止などは要人力確認)
4. JSON SchemaとTypeScript型の同期 — 現状概ね一致だが構造的に乖離しやすい
   (BridgeRequest/BridgeResultがdiscriminated unionでない、image extension不整合、
   STATE_NAMES配列順序への暗黙依存)
5. 修正優先順位: (1) 「不明」を「安全」に変換しない fail-closed 3値化、
   (2) 所有権モデル統一、(3) 入出力内容の忠実性を成功条件にする

---

## 独立検証結果(general-purpose agentによる実コード照合、2026-09-18)

15件中13件CONFIRMED、1件PARTIALLY-TRUE、1件REFUTED(指摘が古い)。
別途確認したA-113/A-114関連の指摘もREFUTED(既に修正済み)。

| # | 内容 | 判定 | 根拠(実ファイル:行) |
|---|---|---|---|
| 1 | continueButton/sidePanel/challengeFrameにverifiedOn無し | CONFIRMED | selectors.ts:260,267,301-307 |
| 2 | resolve()/probe()がcountVisible===1判定なのにfirst()を返す | CONFIRMED | selectors.ts:542-555,568-570,586-588 |
| 3 | normalisePrompt()が全空白除去 | CONFIRMED | page.ts:86-88 |
| 4 | extraction/verify.tsのcoverage判定が弱くfull判定が甘い | CONFIRMED | verify.ts:7-51, page.ts:866,879 |
| 5 | markerExists/priorState/checkProfileFreeがI/Oエラーを不在/freeに変換 | PARTIALLY-TRUE | marker.ts:20-27, adapters.ts:37-44 は全catch→false。profile-guard.ts:108-126は一部コード判定あり、ENOENT以外の未知エラーのみfreeへフォールスルー(120-124) |
| 6 | daemon keepaliveがlock取得でなくisLockHeld()のみでTOCTOU | CONFIRMED | daemon-worker.ts:82-90,117-123(コード自身が認めている) |
| 7 | stale lock recoveryのrename-backが別プロセスの新lockを上書きしうる | CONFIRMED | lock.ts:181-206(rename()はPOSIXで無条件上書き) |
| 8 | launch.tsのclose()が「bounded close, then kill」のコメントと実装が不一致、tracing.stop()もunbounded | CONFIRMED | launch.ts:194-229,205,218 |
| 9 | daemon-worker.ts shutdown()がcontext.close()確認前にstate削除 | **REFUTED(指摘が古い)** | daemon-worker.ts:73-80 — close()を先に待ち、その後unlink。A-110の修正通り正しい順序 |
| 10 | page.tsの画像fetchでAbortSignalがpage内fetchに渡っていない | CONFIRMED | page.ts:1004-1023 |
| 11 | macOSでprocessStartedAt()が常にnull、PID再利用を検出できない | CONFIRMED | lock.ts:46-47, daemon.ts:194-201 |
| 12 | worker.tsのrecoverRunning()が他workerの処理中jobを誤って回収しうる | CONFIRMED | worker.ts:57-90,184(所有者チェック無し) |
| 13 | worker.tsがexit code 4の複数原因を一括り、GENERATION_TIMEOUT_ACTIVEも通常failed扱い | CONFIRMED | types.ts:155-159,166, worker.ts:113-118 |
| 14 | attachments.ts secret scanが2MiB超/非テキスト拡張子でスキップ | CONFIRMED | attachments.ts:12,38-76,151-172 |
| 15 | trace-sanitizer.tsが未知entryをそのまま通す(blocklist方式) | CONFIRMED | trace-sanitizer.ts:161-188(elseでout.set(name,buf)) |
| 追加 | cross-host判定がまだprofileDir文字列比較(A-113/A-114未反映) | **REFUTED(指摘が古い)** | daemon.ts:162-178 findForeignDaemon()はprofileId比較。checkDaemon()内のprofileDir比較(:206)は自ホスト用で、不一致でも正しくforeign daemon scanにフォールスルーする |

**結論**: レビューは高品質。13件は実在するfail-closedの穴で、対処が必要。2件(#9, cross-host)は
直近のA-108〜A-114の作業で既に修正済みのため、レビュー時点のbundleが古かった可能性が高い
(contextのタイムスタンプ要確認)。

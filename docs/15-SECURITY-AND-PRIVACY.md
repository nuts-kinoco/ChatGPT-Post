# 15 — Security and Privacy

| 項目 | 値 |
|---|---|
| 文書版 | 1.3 (Phase 3、Codex レビュー反映。FROZEN FOR MVP v1.0、2026-09-15) |
| 作成日 | 2026-09-14 |
| 上位文書 | `02-REQUIREMENTS.md` SEC-001〜010, CON-004, CON-008, CON-010, CON-011、`03-RISK-REGISTER.md` R-001, R-009 |

## 1. 信頼境界

```text
┌─ ローカルマシン（信頼） ───────────────────────────────────────────┐
│  呼び出し元 (Claude Code) ──files──▶ Bridge プロセス ──CDP──▶ 専用 Chrome │
│                                          │                    │        │
│                                     runtime/            profile/ (Cookie 等) │
└──────────────────────────────────────────┼────────────────────┼────────┘
                                           │ HTTPS（ブラウザが行う）│
                                           ▼                    ▼
                                    chatgpt.com（外部・通常の Web 利用として扱う）
```

- Bridge プロセスは **ブラウザに操作を指示するだけ**で、HTTP を自分で発行しない。Cookie・トークンはブラウザプロファイル内に留まり、Bridge のメモリに載らない。
- Bridge が読み書きするのは `runtime/` 配下と、呼び出し元が指定した `requestDir` のみ。
- 外部ネットワークへの送信は chatgpt.com へのブラウザ通信のみ。テレメトリ・自動更新・外部 API は無い（NFR-009）。

## 2. 秘密情報の扱い

| 情報 | どこにあるか | Bridge の扱い |
|---|---|---|
| ChatGPT セッション Cookie / トークン | `runtime/profile/` 内 | **読まない**。`context.cookies()`、`storageState()`、Cookie DB 読取をコードに持たない（AC-029 で grep） |
| Authorization ヘッダー | ブラウザ内部 | 傍受しない。`page.route` / `waitForResponse` / `page.on('request')` を使わない（CON-008） |
| プロンプト・回答本文 | `requestDir/` | ログには先頭 200 文字 + 総文字数のみ（SEC-005）。`error.message` / `cause` に含めない |
| アカウント名・他の会話タイトル | 画面上 | スクリーンショットに写り得る → viewport のみ撮影し、README で注意喚起（SEC-006） |
| trace | `runtime/artifacts/` | §3 のサニタイズ後に保存 |

**禁止 API / パッケージ一覧**（AC-029 の grep 対象。`biome` の `noRestrictedImports` / `noRestrictedGlobals` と Unit テストで機械検査）:

```text
Playwright:  storageState( , cookies( , addCookies( , recordHar , route( , waitForResponse( , waitForRequest( ,
             on('request' , on('response' , on('websocket' , request.newContext( , page.request. , context.request. ,
             setExtraHTTPHeaders( , extraHTTPHeaders: , userAgent: , headless: true 〔製品コード〕
Clipboard:   clipboard.readText( , readText( , clipboard.read(
Profile:     'Cookies' , 'Login Data' , 'Local State' , 'Web Data' 〔プロファイル内ファイル名〕
Node:        fetch( / http.request( / https.request( 〔製品コード〕
Packages:    openai , @openai/* , puppeteer-extra-plugin-stealth , playwright-extra , playwright-stealth ,
             tesseract.js , node-tesseract-ocr , proxy-chain , undetected-*
```

一覧は `src/diagnostics/forbidden-tokens.ts` の単一定数として持ち、Unit テスト（`src/**` と `tests/fixtures/**` を走査）と Biome の `noRestrictedImports` の両方がそれを参照する。`fetch` はテストコードでも chatgpt.com に対して使わない。

## 3. Playwright trace のサニタイズ（SEC-010）

`tracing.start({ screenshots: true, snapshots: true, sources: false })` で記録する trace.zip には、DOM スナップショットに加えてネットワーク記録（`*.network` JSONL: リクエスト／レスポンスヘッダー、Cookie ヘッダーを含み得る）が含まれる。

**サニタイザ**（`src/browser/trace-sanitizer.ts`）:

1. `tracing.stop({ path: tmp })` で一時ファイルへ出力
2. zip 内の `*.network`（JSONL）を読み、各 `resources/<sha1>` の Content-Type と参照関係を把握する
3. `resources/*` は **許可リスト方式**で残す: `.network` で `text/css`、`font/*`、`image/*`（SVG を含む）と判定されたもの、および `trace.trace` から参照されるスクリーンキャストフレーム（`.jpeg` / `.png`）。`text/html`（bootstrap JSON 埋め込みの文書本体）、`application/javascript`、`application/json`、`text/event-stream`、未知種別は削除
4. `*.network` は削除ではなく **縮約**する: 各エントリを `{ url（クエリ・フラグメント除去）, method, status, response.content.{ mimeType, _sha1 } }` だけに書き直し、リクエスト／レスポンスヘッダー、postData、Cookie、タイミング以外の付随情報を落とす。許可リスト外で削除した sha1 への参照も除く（Trace Viewer が CSS / フォントをスナップショットに適用できるよう URL→sha1 の対応は残す）
5. `trace.trace` / `*.stacks` 等のテキストエントリは JSONL 行単位で §4 の `redact()` を適用する（ヘッダ形、`Bearer …`、JWT 形、`__Secure-`、`sk-…`、URL のクエリ `?…` / フラグメント `#…`）。エントリは削除せず置換し、置換が起きたことだけを `diagnostics` に警告として残す（単語としての "cookie" を含む本文は残る）
6. 残り（上記いずれにも該当しないエントリ）は、先頭バイトを見てtext-likeと判定できれば§4の`redact()`を行単位で適用してから、binary-likeならそのまま `artifacts/<requestId>/trace.zip` に書き直す（A-126、2026-09-18: 名前ベースのdenylistで「未知の新しいエントリ種別は無条件通過」となっていたのを、内容ベースの判定に変更）
7. 一時ファイルを削除

Trace Viewer で開けること（`npx playwright show-trace`）を Unit（手製 zip）と Live で確認する。

**残存**: スナップショットの DOM 自体に画面上の文字（アカウント名、会話タイトル、回答本文）が含まれる。これは除去しない（診断に必要）。README に「trace / screenshot は共有しない」と明記する（SEC-006）。

## 4. ログの redaction（SEC-005）

```ts
redact(text: string): string
```

- 200 文字を超える文字列は `先頭 200 文字 + "…(N chars)"` に丸める（プロンプト・回答・DOM テキストはすべてこの関数を通す）
- 以下のパターンをマスク: `Bearer [A-Za-z0-9._-]+`、`(cookie|authorization|set-cookie)\s*[:=]\s*\S+`（大小文字無視）、`sk-[A-Za-z0-9]{10,}`、`__Secure-[^;\s]+`、`eyJ[A-Za-z0-9._-]{20,}`（JWT 風）
- URL のクエリ文字列を `?…`、フラグメントを `#…` に置換（OAuth の `#access_token=` 等。`conversationUrl` は `/c/<id>` までなのでそのまま）
- ログ出力（stderr）は既定 `info`。`debug` では観測ループの `Observation` を出すが `lastAssistantText` は redact 済み（メモリ上の原文はログに出さない）

Unit テストで各パターンの入力→出力を固定する（AC-029）。

## 5. プロファイルの保護（SEC-001, CON-004）

- 既定 `runtime/profile/`。`CHATGPT_BRIDGE_PROFILE_DIR` で変更可。
- 起動前（`PRIOR_RESULT_CHECKED`、ロック取得前）に検査し、以下のいずれかなら `INVALID_CONFIG`（終了コード 2、result.json あり）で拒否（`doctor` は NG 表示）。初回作成時（ディレクトリ不在）も親ディレクトリに対して同じ検査を行う:
  - `fs.realpath` で解決した canonical path が、同じく `realpath` した禁止パスに一致・包含される
  - プロファイルパスの最終要素、またはその全祖先のいずれかが reparse point（symlink / junction。`fs.lstat().isSymbolicLink()`）である（fail closed。NTFS junction で通常 `User Data` を指す迂回を防ぐ）
  - 禁止パス:
  - `%LOCALAPPDATA%\Google\Chrome\User Data`
  - `%LOCALAPPDATA%\Microsoft\Edge\User Data`
  - `%LOCALAPPDATA%\Chromium\User Data`
  - `%APPDATA%\Mozilla\Firefox\Profiles`
- Cookie / 認証情報を含むプロファイル内ファイル（`Cookies`, `Login Data`, `Local State` 等）を Bridge が開くコードパスは存在しない。唯一の例外は占有判定のための `lockfile`（Chrome が排他保持する 0 バイトの判定用ファイル）を開いて即閉じる操作で、内容は読まない（10 §5）。
- `runtime/` は `.gitignore`。`inspect-ui --dump-dom` の生 DOM は `runtime/artifacts/inspect-ui/` にのみ書く。`doctor` は `git check-ignore runtime/profile` が通ることも確認する（リポジトリ内で実行されている場合）。

## 6. 検知回避・規約（SEC-008, R-001）

実装しないもの（コードレビューの確認項目、AC-029）:

- stealth 系プラグイン、`navigator.webdriver` の偽装、UA / 言語 / 画面サイズの偽装、フォント／Canvas 指紋の操作
- CAPTCHA / Turnstile の自動操作（クリックを含む）
- レート制限時の自動待機・自動再送
- 複数アカウント / IP / プロキシのローテーション
- headless 既定（`headless: false` を固定。テストでのみ fixture に対して headless 可）

**ページ内スクリプト**は `navigator.clipboard.writeText` / `write` の捕捉シムのみ（`addInitScript`）で、**`run` のコンテキストにのみ登録する**（`login` / `doctor` / `inspect-ui` では人間のコピー操作を妨げないため登録しない。`BrowserPort.launch({ copyCaptureShim })` の明示引数）。これは出力の捕捉であり、検知回避・自動化の隠蔽ではない。他の `addInitScript` / `evaluate` による DOM 改変は行わない（読み取りの `evaluate` は可）。

規約リスクは解消しない。README と `03-RISK-REGISTER.md` R-001 を参照（SEC-009）。

## 7. ローカルデータの保持（SEC-007）

- `requestDir/`（prompt, response, result）、`runtime/state/`（marker）、`artifacts/` は自動削除しない。
- `runtime/profile/`、`runtime/locks/`、`runtime/requests/`、`runtime/artifacts/` は呼び出し元／PO が任意に削除してよい（`profile/` を削除すると再ログインが必要）。**`runtime/state/` は送信監査台帳であり一般削除の対象外**。削除すると同じ requestId を別ディレクトリで再実行したときに再送を拒否できなくなる（R-003）。GC は MVP 外で、将来行う場合も明示承認付きとする。`doctor` は `runtime/state/` が存在しない、または `runtime/` 直下にあるべきディレクトリが欠けている場合に警告する。
- 保持期間ポリシーは MVP 外。README に明記。

## 8. 依存の固定と監査

- `package-lock.json` をコミットし、`npm ci` を使う。
- Phase 7 で `npm audit` の結果を記録する（修正の要否は PO 判断）。
- Playwright のブラウザは `npx playwright install chromium` で取得するが、既定 `channel: 'chrome'` はインストール済み Google Chrome を使う（ADR-002）。

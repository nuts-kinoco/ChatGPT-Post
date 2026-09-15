# 14 — Selector Strategy

| 項目 | 値 |
|---|---|
| 文書版 | 1.3 (Phase 3、Codex レビュー反映。FROZEN FOR MVP v1.0、2026-09-15) |
| 作成日 | 2026-09-14 |
| 上位文書 | `02-REQUIREMENTS.md` FR-004, FR-022, FR-041, NFR-005, NFR-006, OPS-008 |
| 重要 | 本書の候補 selector は **未検証のプレースホルダ**（OQ-002）。Phase 4 で `inspect-ui` により実画面で確認したものだけを実装する。推測で実装しない（OPS-008） |

## 1. 集約モジュールの構造

DOM に関する知識は `src/chatgpt/selectors.ts` にのみ置く。他のモジュールは要素を **名前**（`ElementKey`）で要求する。

```ts
type Locale = 'ja' | 'en';

type Candidate = {
  kind: 'role' | 'label' | 'placeholder' | 'testid' | 'text' | 'css';
  spec: unknown;                // kind ごとの引数。role なら { role, name: RegExp }、testid なら string、css なら string
  verifiedOn?: string;          // 実画面で確認した日付と UI 版。例 '2026-09-20 chatgpt.com ja'
};

type ElementDef = {
  key: ElementKey;
  purpose: string;
  candidates: Candidate[];      // 優先順
  mode: 'unique' | 'presence' | 'count';
  //   unique   : 操作対象。候補を順に評価し、可視かつ exactly-one を満たす最初の候補を使う。どれも満たさなければ DOM_UNEXPECTED（送信境界前のみ）
  //   presence : 存在検出。全候補を評価し、**可視**（isVisible）な一致が 1 件以上なら「存在」。0 件でも DOM_UNEXPECTED にしない
  //   count    : 件数取得。全候補の attached な一致数の最大値を返す（assistantTurn / modelPickerOption 用）
  scope?: ElementKey;           // 走査範囲を別要素内に限定（例: copyButton は latestAssistantTurn 内）
};

type ElementKey =
  | 'composer'                  // プロンプト入力欄（unique）
  | 'sendButton'                // 送信ボタン（unique。送信境界前に解決して保持。composerReady には使わない）
  | 'stopButton'                // 生成停止ボタン（presence。存在 = streaming）
  | 'newChatButton'             // 新規チャット（unique）
  | 'modelPicker'               // モデル／effort 選択メニューのトリガ（unique）
  | 'modelPickerOption'         // メニュー内の選択肢（count。0 件 = MODEL_NOT_AVAILABLE、2 件以上 = MODEL_NOT_VERIFIABLE）
  | 'modelPickerCurrentLabel'   // 現在の選択を示す表示（unique）
  | 'assistantTurn'             // assistant ターンのルート（count / 最新の取得）
  | 'assistantTurnBody'         // ターン本文（unique、scope: assistantTurn）
  | 'copyTurnButton'            // ターン単位のコピー操作（presence、scope: assistantTurn のアクションバー。コードブロックの Copy を除外）
  | 'continueButton'            // 「続きを生成 / Continue generating」（presence）
  | 'sidePanel'                 // Canvas 等の編集パネル（presence）
  | 'errorBanner'               // role=alert のエラー（presence）
  | 'loginCta'                  // ログイン導線（presence）
  | 'challengeFrame'            // Cloudflare / Turnstile / CAPTCHA（presence）
  | 'blockingDialog';           // 同意等のモーダル（presence）
```

```ts
type PresetLabels = Record<Exclude<Preset, 'current'>, Record<Locale, string[]>>;
// 制約: 全 preset のラベル集合は互いに素（Unit で検査）。逆引きは一意でなければ MODEL_NOT_VERIFIABLE

type Phrases = {
  rateLimited: Record<Locale, string[]>;
  chatError: Record<Locale, string[]>;
  networkError: Record<Locale, string[]>;
  challenge: Record<Locale, string[]>;
};
```

API:

| 関数 | 説明 |
|---|---|
| `resolve(page, key, locale?)` | `mode: 'unique'` 用。verify を満たす最初の Locator。無ければ `DOM_UNEXPECTED { key, tried }`。**`BROWSER_STARTED` 〜 `PROMPT_ENTERED` でのみ使用可** |
| `probe(page, key, locale?)` | `unique` 要素の読み取り専用版。`{ found: boolean, enabled?: boolean, locator? }` を返し例外を投げない（0 件・複数件は `found: false`）。送信後の `observe()` はこちらを使う |
| `exists(page, key, locale?)` | `mode: 'presence'` 用。全候補を OR 評価し、可視な一致があれば true |
| `countMatches(page, key)` | `mode: 'count'` 用 |
| `latest(page, key)` | `count` 要素の最後の 1 件（scope 付き要素の起点に使う） |

不変条件: `PROMPT_SUBMITTING` 以降に呼ばれる関数（`observe`, `readLatestAssistant`, `captureCopy`, `dispatchSubmit`）は `resolve` を呼ばず、`DOM_UNEXPECTED` を投げない。

## 2. 候補の優先順位（NFR-005）

1. `getByRole(role, { name })` — accessible name は ja / en の配列で持ち、正規表現で OR にする
2. `getByLabel` / `getByPlaceholder`
3. `getByTestId`（ChatGPT が `data-testid` を付けている要素のみ。付与は変わりやすいので 3 位。ただし **`copyTurnButton` はコードブロックの Copy と区別するため testid を第 1 候補にする**）
4. テキスト + 構造（`getByText(...)` の祖先／子孫）
5. CSS 構造セレクタ（クラス名は避け、`article`、`form`、`[role]`、`[data-message-author-role]` 等の意味的属性）
6. XPath は使わない

各 `Candidate` には実画面で確認した日付を `verifiedOn` に記録する。**`verifiedOn` の無い候補を実装に含めてはならない**（Unit テストで検査）。

## 3. 要素定義（Phase 4 で実画面確認済み。`verifiedOn: 2026-09-15 chatgpt.com ja`）

実装は `src/chatgpt/selectors.ts` の `ELEMENTS`。`verifiedOn` 付きの候補のみが既定で使われ、無印の候補は `--allow-unverified`（診断専用）でのみ有効になる。

| key | mode | 検証済み候補（優先順） | 備考 |
|---|---|---|---|
| `composer` | unique | `#prompt-textarea`（ProseMirror、role `textbox`、aria-label「ChatGPT とチャットする」） | 未ログイン画面にも表示されるため、ログイン判定には使わない（A-056） |
| `sendButton` | unique | role `button` name `メッセージを送信します` | 送信境界前に `resolve` して保持。空入力時は無効 |
| `stopButton` | presence | testid `stop-button` | 存在 = streaming |
| `newChatButton` | presence | 複数のリンクが同名で存在するため unique にできない。新規チャットは `https://chatgpt.com/` への遷移で開く（A-058） | |
| `modelPicker` | unique | `form [data-composer-transition-slot="trailing"] button[aria-haspopup="menu"]` | 入力欄右端の「思考量」トリガ。ラベルは現在の段階（例「極高」）。メニューが開いている間は「思考量」と表示される |
| `modelPickerCurrentLabel` | unique | `modelPicker` のテキスト | 逆引き不能なら `MODEL_NOT_VERIFIABLE` |
| `modelPickerMenu` | presence | testid `composer-intelligence-picker-content` | 中に effort スライダー `[data-model-reasoning-effort-slider] [role=slider]`（`aria-valuenow` 0..4）とモデルのラジオ（「最新」既定 / GPT-5.6 Sol / GPT-5.5） |
| `assistantTurn` | count | `section[data-turn="assistant"]` → `[data-message-author-role="assistant"]` | `data-message-model-slug` を持つ |
| `assistantTurnBody` | unique（scope: assistantTurn） | `[data-message-author-role="assistant"] .markdown` | |
| `copyTurnButton` | presence（scope: 最新 assistantTurn） | testid `copy-turn-action-button` → role `button` name `回答をコピーする` | アクションバー aria-label「応答アクション」内。コードブロックの「コピーする」は別物 |
| `continueButton` | presence | 未観測（LS-01 では出現せず） | Phase 5 で確認 |
| `sidePanel` | presence | 未観測 | Phase 5 で確認 |
| `errorBanner` | presence | role `alert` → phrases.chatError / networkError | Phase 5 で Live 確認 |
| `loginCta` | presence | role `button`/`link` name /^(ログイン\|Log in)$/ | 見えれば `AUTH_REQUIRED`（入力欄より優先） |
| `challengeFrame` | presence | iframe src /challenges\.cloudflare\.com\|turnstile\|captcha/ → phrases.challenge | Phase 5 で Live 確認（発生させられないので fixture） |
| `blockingDialog` | presence | role `dialog` visible | |

DOM 構造メモ（2026-09-15）:
- コードブロックは外側 `<pre>`（ヘッダ `div` に言語ラベル + 「コピーする」ボタン）が内側 `<pre><code>` を包む二重構造。Markdown 変換は外側 `<pre>` 単位で行い、ヘッダ文字列を fence の言語にする（A-059）。
- 送信直後の URL は一時 ID `/c/WEB:…` で、数秒後に `/c/<uuid>` に置き換わる。`conversationUrl` は観測ループ中の最新値を記録する。
- 「回答をコピーする」は `navigator.clipboard.writeText(markdown)` を呼ぶ（OQ-003 解決、A-062）。

## 4. preset ↔ UI ラベル（Phase 4 で一部確定）

実画面では「モデル」と「思考量（effort）」が同じメニュー内の別コントロールになっている。**preset は思考量スライダーの段階を指す**（A-061）。モデルのラジオは MVP では変更しない。

| preset | スライダー段階（`aria-valuenow`） | UI ラベル（ja / en） | 状態 |
|---|---|---|---|
| `instant` | 0（推定） | 未確定 | Phase 5 で確定 |
| `medium` | 1 or 2（推定） | 未確定 | Phase 5 で確定 |
| `high` | 2 or 3（推定） | 未確定 | Phase 5 で確定 |
| `extra_high` | **3** | **極高** / Extra high | **確定（2026-09-15）** |
| `pro` | 4（推定） | 未確定 | Phase 5 で確定 |
| `current` | 操作しない。`modelPickerCurrentLabel` を `PRESET_LABELS` で逆引き | — | Phase 4 で実装 |

- 段階数は 5（`aria-valuemax` = 4）だが、preset 5 種との 1:1 対応は **推定であり未検証**。Phase 5 で `inspect-ui` のスライダー操作（矢印キー）でラベルを 1 段階ずつ確定してから `PRESET_LABELS` / `EFFORT_SLIDER_INDEX` に追加する。未登録段階の `current` は `MODEL_NOT_VERIFIABLE`。
- Phase 4 では `current` 以外の preset を指定すると送信前に `MODEL_NOT_VERIFIABLE`（A-063）。
- モデル側（「最新」= 自動ルーティング相当）を preset に含めるかは OQ-009 として Phase 5 で PO 判断。

## 5. 観測（読み取り専用）と操作の分離

| 関数 | 種別 | 説明 |
|---|---|---|
| `observeAuth(page, url)` | 読取 | `url` は `PagePort.currentUrl()` から渡す（fixture では差し替え可）。ドメイン、`loginCta`、`challengeFrame`、`blockingDialog`、`phrases.rateLimited`、`composer` の有無 → `AUTH_OK` / `AUTH_REQUIRED` / `CHALLENGE(kind)` / `WRONG_PAGE` / `NOT_READY`（chatgpt.com 配下で `composer` も `loginCta` もチャレンジも無い → controller が `RETRYABLE_STEP_FAILED(auth)` に写す） |
| `observePreset(page)` | 読取 | `modelPickerCurrentLabel` → preset（一意逆引き）または `not_verifiable` / `DOM_UNEXPECTED` |
| `observe(page, url, t)` | 読取 | `Observation`（10-ARCHITECTURE §6）を 1 回作る。`probe` / `exists` / `countMatches` のみを使い、例外を投げない。`composerReady = !exists(stopButton) && probe(composer).found && probe(composer).enabled` |
| `countAssistantTurns(page)` | 読取 | `countMatches(assistantTurn)` |
| `readLatestAssistant(page)` | 読取 | `{ html, innerText }`（`latest(assistantTurn)` → `assistantTurnBody`） |
| `openNewChat(page, url)` | 操作 | `newChatButton` クリック → フェーズ上限（30 s）内で 250 ms ごとに再観測し、`composer` が出現した時点で**最終判定**: URL に `/c/` → `NEW_CHAT_FAILED(existing_conversation)`、`stopButton` 可視 → `NEW_CHAT_FAILED(generating)`、`composer` 非空 → `NEW_CHAT_FAILED(composer_not_empty)`、すべて満たせば `NEW_CHAT_OK`。`composer` が出現しなければ `RETRYABLE_STEP_FAILED` |
| `selectPreset(page, preset)` | 操作 | `modelPicker`（unique）を開く → `countMatches(modelPickerOption)` が 0 なら `PRESET_NOT_AVAILABLE`、2 以上なら `PRESET_NOT_VERIFIABLE`、1 ならクリック → 閉じた後 `observePreset` で一致確認（不一致なら `PRESET_NOT_VERIFIABLE`）。`DOM_UNEXPECTED` は `modelPicker` 自体の未解決でのみ発生 |
| `enterPrompt(page, text)` | 操作 | `composer` にフォーカス → `fill`（contenteditable なら `insertText`）→ `composer.innerText` と正規化比較。不一致なら全選択削除して再入力を最大 2 回、それでも不一致なら `PROMPT_MISMATCH` を 1 回だけ返す。`composer` の一時的な未解決のみ `RETRYABLE_STEP_FAILED` |
| `snapshotBaseline(page, url)` | 読取 | `countAssistantTurns`、URL、`observePreset`（`PRESET_VERIFIED` 時の表示と比較。異なれば `PRESET_CHANGED`）、`resolve(sendButton)` を行い Locator を保持 → `BASELINE_OK` |
| `dispatchSubmit(locator, baselinePresetLabel)` | 操作 | click の直前に `observePreset` を読み取り専用（`probe`）で再実行し、`baselinePresetLabel` と不一致なら click せず `SUBMIT_ABORTED(preset_changed)` を返す。一致なら `snapshotBaseline` で解決済みの `sendButton` Locator をクリック（`Enter` は IME 事故を避けるため使わない）。**1 回のみ**。要素消失・無効・クリック例外は `SUBMIT_FAILED(cause)` を返し、`DOM_UNEXPECTED` を投げない |
| `captureCopy(page)` | 操作 | `window.__bridgeCopyCapture = null` → 最新ターンの `copyTurnButton` クリック → 捕捉テキスト読取。`copyTurnButton` が無い／複数なら `null` を返し `dom` へ降格 |

`inspect-ui` はすべての `ElementDef` について候補ごとの一致数・可視性を JSON で出力し、`observePreset` の結果と `modelPicker` を開いた場合の選択肢一覧（テキストのみ）も含める。**送信・入力・選択は行わない**（`modelPicker` を開いて閉じるのみ）。

## 6. 多言語（NFR-006）

- `locale` は `document.documentElement.lang` から推定（`ja*` → ja、それ以外 en）。推定できなければ ja / en 両方の候補を OR で試す。
- accessible name の照合は正規表現 `new RegExp('^(?:' + labels.map(escape).join('|') + ')$', 'i')`（**前後アンカー付き**。`high` が `Extra high` に部分一致しないため）。ボタン等の文言照合も同様に完全一致を基本とし、`phrases` のみ部分一致。
- 文言（`phrases`）は部分一致。エラーバナー系は `role="alert"` を第 1 候補にして文言依存を減らすが、`presence` モードなので他候補も常に評価される。

## 7. UI 変更時の手順（FR-004, R-002）

1. `DOM_CHANGED` の `artifacts/<id>/inspect-ui.json` と screenshot を確認する
2. `chatgpt-bridge inspect-ui` を実行し、どの `ElementKey` の候補がすべて外れたかを見る
3. `login` で開いた専用ブラウザの DevTools（人間が操作）で新しい accessible name / 構造を確認する
4. `selectors.ts` の該当 `candidates` を更新し、`verifiedOn` を記録する（古い候補は末尾に残してよい）
5. sanitized fixture を更新し、fixture テストを通す
6. Live smoke（LS-01）を通す

selectors 以外のファイルを触る必要が出た場合は設計上の問題としてレビューする。

## 8. fixture の作り方（16-TEST-STRATEGY と共用）

1. `login` で開いたブラウザで対象画面を表示し、`inspect-ui --dump-dom` を実行する。生 DOM は `runtime/artifacts/inspect-ui/<timestamp>.raw.html` にのみ書かれる（gitignore、共有禁止）
2. `scripts/sanitize-fixture.ts`（Phase 5）で処理する: `script` / インライン JS / 外部リソース参照 / `<meta>` / hidden input / `data-*` の値を除去、メールアドレス・`user-` で始まる ID・`eyJ` で始まる JWT 風文字列・`__Secure-` を検査し **ヒットすれば失敗**。会話 ID（`/c/<uuid>`）は秘密情報ではない（認証情報を含まない URL）が、固定ダミーに置換する。アカウント名・会話タイトル・回答本文も固定ダミーに置換
3. 保存先 `tests/fixtures/chatgpt/<yyyymmdd>-<state>-<locale>.html`。`state` は `new-chat`, `generating`, `completed`, `completed-truncated`, `completed-canvas`（`login` で Canvas を開いた状態で採取）, `two-responses`, `error-banner`, `error-in-message`, `rate-limited`, `login`, `login-during-generation`（生成中に `loginCta` が出た画面。再現困難なら `generating` に `login` の導線要素を合成）, `challenge`, `consent-dialog`
4. `copy` 経路の fixture テストは、テスト側が `page.evaluate` で「`copyTurnButton` クリック時に本文 Markdown を `navigator.clipboard.writeText` に渡す」テスト専用スクリプトを注入する（fixture 自体には JS を含めない）
5. 禁止 API / 秘密情報の grep（16 §2）は `tests/fixtures/**` にも適用する
6. fixture は静的 HTML なので Playwright 同梱 Chromium を headless で開いてよい（CON-005 は製品挙動の制約）

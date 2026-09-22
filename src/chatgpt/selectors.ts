import type { Locator, Page } from "playwright";
import type { ObservedModel, ObservedPreset } from "../contracts/types.js";

export type Locale = "ja" | "en";

export type Candidate =
  | {
      kind: "role";
      role: Parameters<Page["getByRole"]>[0];
      name: RegExp | string;
      exact?: boolean;
      verifiedOn?: string;
    }
  | { kind: "testid"; testId: string; verifiedOn?: string }
  | { kind: "placeholder"; text: RegExp | string; verifiedOn?: string }
  | { kind: "css"; selector: string; verifiedOn?: string }
  | { kind: "text"; text: RegExp | string; verifiedOn?: string };

export type Mode = "unique" | "presence" | "count";

export interface ElementDef {
  key: ElementKey;
  purpose: string;
  mode: Mode;
  candidates: Candidate[];
  scope?: ElementKey;
}

export type ElementKey =
  | "composer"
  | "sendButton"
  | "stopButton"
  | "newChatButton"
  | "modelPicker"
  | "modelPickerCurrentLabel"
  | "pickerMenu"
  | "effortSlider"
  | "effortSliderRow"
  | "modelExpander"
  | "modelRadio"
  | "assistantTurn"
  | "assistantTurnBody"
  | "copyTurnButton"
  | "continueButton"
  | "sidePanel"
  | "errorBanner"
  | "loginCta"
  | "challengeFrame"
  | "blockingDialog"
  | "fileInput"
  | "attachmentChip"
  | "turnImage"
  | "imageViewer"
  | "imageSaveButton"
  | "imageViewerClose"
  | "projectSidebarItem"
  | "projectOpenHomeButton"
  | "newProjectButton"
  | "newProjectNameInput"
  | "newProjectConfirmButton";

/**
 * 14-SELECTOR-STRATEGY §3. Candidates carry `verifiedOn` only after confirmation on the real
 * screen (OPS-008). Unverified candidates are kept for inspect-ui but must not be used by `run`.
 */
export const ELEMENTS: Record<ElementKey, ElementDef> = {
  composer: {
    key: "composer",
    purpose: "プロンプト入力欄（ProseMirror contenteditable）",
    mode: "unique",
    candidates: [
      { kind: "css", selector: "#prompt-textarea", verifiedOn: "2026-09-15 chatgpt.com ja" },
      {
        kind: "role",
        role: "textbox",
        name: /ChatGPT とチャットする|Message ChatGPT|質問|Ask/i,
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
      {
        kind: "css",
        selector: 'form [contenteditable="true"]',
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
    ],
  },
  sendButton: {
    key: "sendButton",
    purpose: "送信ボタン（入力欄が空のときは音声ボタンに置き換わる）",
    mode: "unique",
    candidates: [
      {
        kind: "role",
        role: "button",
        name: /^(メッセージを送信します|プロンプトを送信する|Send prompt|Send message)$/i,
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
      { kind: "testid", testId: "send-button", verifiedOn: "2026-09-15 chatgpt.com ja" },
    ],
  },
  stopButton: {
    key: "stopButton",
    purpose: "生成停止（存在 = streaming）",
    mode: "presence",
    candidates: [
      { kind: "testid", testId: "stop-button", verifiedOn: "2026-09-15 chatgpt.com ja" },
      { kind: "role", role: "button", name: /^(ストリーミングを停止|停止|Stop streaming|Stop)$/i },
    ],
  },
  newChatButton: {
    key: "newChatButton",
    purpose: "新規チャット（複数存在するため操作には使わず、新規チャットは URL 遷移で行う）",
    mode: "presence",
    candidates: [
      { kind: "testid", testId: "create-new-chat-button", verifiedOn: "2026-09-15 chatgpt.com ja" },
      {
        kind: "role",
        role: "link",
        name: /新しいチャット|New chat/i,
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
    ],
  },
  modelPicker: {
    key: "modelPicker",
    purpose: "思考 effort / モデル選択メニューのトリガ（composer 右側、現在値をラベル表示）",
    mode: "unique",
    candidates: [
      {
        kind: "css",
        selector: 'form [data-composer-transition-slot="trailing"] button[aria-haspopup="menu"]',
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
      { kind: "testid", testId: "model-switcher-dropdown-button" },
    ],
  },
  pickerMenu: {
    key: "pickerMenu",
    purpose: "思考量 / モデル選択メニュー本体（開いている間だけ存在）",
    mode: "unique",
    candidates: [
      {
        kind: "testid",
        testId: "composer-intelligence-picker-content",
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
    ],
  },
  effortSlider: {
    key: "effortSlider",
    purpose: "思考量スライダー（aria-valuenow 0..4、矢印キーで操作）",
    mode: "unique",
    scope: "pickerMenu",
    candidates: [
      {
        kind: "css",
        selector: "[data-model-reasoning-effort-slider] [role=slider]",
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
    ],
  },
  effortSliderRow: {
    key: "effortSliderRow",
    purpose:
      "スライダーを含む menuitem（aria-describedby の先頭 id が現在の段階ラベル「極高、5件中4件目。」）",
    mode: "unique",
    scope: "pickerMenu",
    candidates: [
      {
        kind: "css",
        selector: "[role=menuitem][aria-describedby]:has([data-model-reasoning-effort-slider])",
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
    ],
  },
  modelExpander: {
    key: "modelExpander",
    purpose:
      "「モデルを選択」menuitem（aria-expanded。クリックで advanced view = モデルのラジオが操作可能になる）",
    mode: "unique",
    scope: "pickerMenu",
    candidates: [
      {
        kind: "css",
        selector: "[role=menuitem][aria-expanded]",
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
    ],
  },
  modelRadio: {
    key: "modelRadio",
    purpose: "モデルのラジオ（最新 / GPT-5.6 Sol / GPT-5.5。advanced view でのみクリック可能）",
    mode: "count",
    scope: "pickerMenu",
    candidates: [
      { kind: "role", role: "menuitemradio", name: "", verifiedOn: "2026-09-15 chatgpt.com ja" },
    ],
  },
  modelPickerCurrentLabel: {
    key: "modelPickerCurrentLabel",
    purpose: "現在の選択表示（modelPicker のテキスト）",
    mode: "unique",
    candidates: [
      {
        kind: "css",
        selector: 'form [data-composer-transition-slot="trailing"] button[aria-haspopup="menu"]',
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
      { kind: "testid", testId: "model-switcher-dropdown-button" },
    ],
  },
  assistantTurn: {
    key: "assistantTurn",
    purpose: "assistant ターン（本文 + 応答アクションバーを含む section）",
    mode: "count",
    candidates: [
      {
        kind: "css",
        selector: 'section[data-turn="assistant"]',
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
      {
        kind: "css",
        selector: '[data-message-author-role="assistant"]',
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
    ],
  },
  assistantTurnBody: {
    key: "assistantTurnBody",
    purpose: "ターン本文（Markdown レンダリング部分）",
    mode: "unique",
    scope: "assistantTurn",
    candidates: [
      {
        kind: "css",
        selector: '[data-message-author-role="assistant"] .markdown',
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
      { kind: "css", selector: ".markdown", verifiedOn: "2026-09-15 chatgpt.com ja" },
    ],
  },
  copyTurnButton: {
    key: "copyTurnButton",
    purpose: "ターン単位のコピー（応答アクションバー内。コードブロックの「コピーする」は含めない）",
    mode: "presence",
    scope: "assistantTurn",
    candidates: [
      {
        kind: "testid",
        testId: "copy-turn-action-button",
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
      {
        kind: "role",
        role: "button",
        name: /^(回答をコピーする|Copy response)$/i,
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
    ],
  },
  // A-127 (Phase 0-C-1): no verifiedOn candidate. page.ts calls exists() for this key with
  // verifiedOnly:false unconditionally (safetyCheckOpts) — a false verifiedOnly default here would
  // otherwise silently disable this detection entirely in every normal run.
  continueButton: {
    key: "continueButton",
    purpose: "続きを生成（存在 = truncated）",
    mode: "presence",
    candidates: [{ kind: "role", role: "button", name: /続きを生成|Continue generating/i }],
  },
  // A-127: same as continueButton above — no verifiedOn, always checked via safetyCheckOpts.
  sidePanel: {
    key: "sidePanel",
    purpose: "Canvas 等の編集パネル",
    mode: "presence",
    candidates: [
      { kind: "css", selector: 'section[aria-label*="canvas" i] [contenteditable="true"]' },
    ],
  },
  errorBanner: {
    key: "errorBanner",
    purpose: "エラーバナー",
    mode: "presence",
    candidates: [{ kind: "role", role: "alert", name: "" }],
  },
  loginCta: {
    key: "loginCta",
    purpose: "ログイン導線（未ログイン画面にも入力欄があるため、これが見えれば AUTH_REQUIRED）",
    mode: "presence",
    candidates: [
      {
        kind: "role",
        role: "button",
        name: /^(ログイン|Log in)$/i,
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
      {
        kind: "role",
        role: "link",
        name: /^(ログイン|Log in)$/i,
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
      { kind: "testid", testId: "login-button" },
    ],
  },
  // A-127: same as continueButton above — no verifiedOn, always checked via safetyCheckOpts.
  challengeFrame: {
    key: "challengeFrame",
    purpose: "Cloudflare / Turnstile / CAPTCHA",
    mode: "presence",
    candidates: [
      {
        kind: "css",
        selector:
          'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[src*="captcha"]',
      },
      { kind: "text", text: /Verify you are human|人間であることを確認|Just a moment/i },
    ],
  },
  blockingDialog: {
    key: "blockingDialog",
    purpose: "同意等のモーダル",
    mode: "presence",
    candidates: [{ kind: "role", role: "dialog", name: "" }],
  },
  fileInput: {
    key: "fileInput",
    purpose: "composer のファイル入力（hidden、multiple。Playwright setInputFiles の対象）",
    mode: "unique",
    candidates: [
      {
        kind: "css",
        selector: 'form input[type="file"]#upload-files',
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
      {
        kind: "css",
        selector: 'form input[type="file"]:not([accept])',
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
    ],
  },
  turnImage: {
    key: "turnImage",
    purpose: "回答ターン内の生成画像（同じ src が複数回描画される。naturalWidth で絞る）",
    mode: "count",
    scope: "assistantTurn",
    candidates: [
      {
        kind: "css",
        selector: "img[alt^='生成された画像'], img[alt^='Generated image']",
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
      {
        kind: "css",
        selector: "img[src*='estuary/content']",
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
    ],
  },
  imageViewer: {
    key: "imageViewer",
    purpose:
      "画像クリックで開く全画面ビューア（role=dialog。中に独自の入力欄と送信ボタンがあるので触らない）",
    mode: "unique",
    candidates: [
      { kind: "role", role: "dialog", name: "", verifiedOn: "2026-09-15 chatgpt.com ja" },
    ],
  },
  imageSaveButton: {
    key: "imageSaveButton",
    purpose: "ビューア内の「保存」= ダウンロード",
    mode: "unique",
    scope: "imageViewer",
    candidates: [
      {
        kind: "role",
        role: "button",
        name: /^(保存|Save)$/,
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
    ],
  },
  imageViewerClose: {
    key: "imageViewerClose",
    purpose: "ビューアを閉じる",
    mode: "unique",
    scope: "imageViewer",
    candidates: [
      {
        kind: "role",
        role: "button",
        name: /^(全画面表示を閉じる|Close fullscreen|Close)$/,
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
    ],
  },
  // A-144: live-verified 2026-09-22 (ja, chatgpt.com, daemon session) — sidebar Project rows are
  // client-routed `role="button"` divs, not `<a>` tags with an href; `projectOpenHomeButton` (the
  // per-row "プロジェクトのホームを開く" icon SKILL.md already told callers to click by hand) is the
  // only way to learn a row's Project-home URL. Creation dialog fields confirmed present and
  // fillable/enabling the submit button; the submit click itself was never exercised live (that
  // would have created a real Project in the account under test) — treat `newProjectConfirmButton`
  // as verified-present-and-enablable, not verified-to-actually-create.
  projectSidebarItem: {
    key: "projectSidebarItem",
    purpose: "A Project row in the sidebar Project list",
    mode: "count",
    candidates: [
      {
        kind: "css",
        selector: 'li:has([data-testid="project-folder-icon"])',
        verifiedOn: "2026-09-22 chatgpt.com ja",
      },
    ],
  },
  projectOpenHomeButton: {
    key: "projectOpenHomeButton",
    purpose: "Within a projectSidebarItem row: navigates to that Project's home",
    mode: "unique",
    scope: "projectSidebarItem",
    candidates: [
      {
        kind: "css",
        selector: 'button[aria-label="プロジェクトのホームを開く"]',
        verifiedOn: "2026-09-22 chatgpt.com ja",
      },
    ],
  },
  newProjectButton: {
    key: "newProjectButton",
    purpose: "Open the New Project creation dialog from the sidebar",
    mode: "unique",
    candidates: [
      {
        kind: "css",
        selector: '[aria-label="プロジェクトを新規作成"]',
        verifiedOn: "2026-09-22 chatgpt.com ja",
      },
    ],
  },
  newProjectNameInput: {
    key: "newProjectNameInput",
    purpose: "New Project name input (id/name confirmed; disables submit until non-empty)",
    mode: "unique",
    candidates: [
      { kind: "css", selector: "#project-name", verifiedOn: "2026-09-22 chatgpt.com ja" },
    ],
  },
  newProjectConfirmButton: {
    key: "newProjectConfirmButton",
    purpose:
      "Submits the New Project dialog (element/enable-state verified; the click itself was not exercised live to avoid creating a real Project)",
    mode: "unique",
    candidates: [
      {
        kind: "css",
        selector: 'form[data-testid="create-new-project-form"] button[type="submit"]',
        verifiedOn: "2026-09-22 chatgpt.com ja",
      },
    ],
  },
  attachmentChip: {
    key: "attachmentChip",
    purpose:
      "添付チップ（aria-label = ファイル名。サーバー側で「name(1).ext」に改名されることがある）",
    mode: "count",
    candidates: [
      {
        kind: "css",
        selector: "form [role=group][aria-label]",
        verifiedOn: "2026-09-15 chatgpt.com ja",
      },
    ],
  },
};

/**
 * preset = 思考 effort スライダーの段階（5 段階、aria-valuenow 0..4）。ja ラベルは 2026-09-15 に全段階を
 * 実画面で確認（Instant / 中程度 / 高 / 極高 / Pro）。en ラベルは未検証の推定で、英語 UI では
 * inspect-ui で確認してから信頼すること。
 */
export const PRESET_LABELS: Record<ObservedPreset, Record<Locale, string[]>> = {
  instant: { ja: ["Instant"], en: ["Instant"] },
  medium: { ja: ["中程度"], en: ["Medium"] },
  high: { ja: ["高"], en: ["High"] },
  extra_high: { ja: ["極高"], en: ["Extra high"] },
  pro: { ja: ["Pro"], en: ["Pro"] },
};

/** Slider index <-> preset (5 levels, all confirmed 2026-09-15). */
export const EFFORT_SLIDER_INDEX: Record<number, ObservedPreset> = {
  0: "instant",
  1: "medium",
  2: "high",
  3: "extra_high",
  4: "pro",
};
export const EFFORT_INDEX_OF: Record<ObservedPreset, number> = {
  instant: 0,
  medium: 1,
  high: 2,
  extra_high: 3,
  pro: 4,
};
export const EFFORT_SLIDER_MAX = 4;
/** Keyboard presses closer than this were observed to lose the last step on persistence (2026-09-15). */
export const EFFORT_KEY_INTERVAL_MS = 450;

/**
 * Model radios (advanced view). Matched against the first line of the radio text (GPT-5.5 carries a
 * second line "10月14日 に提供終了予定"). en labels unknown -> fail closed on an English UI.
 */
export const MODEL_LABELS: Record<ObservedModel, Record<Locale, string[]>> = {
  latest: { ja: ["最新"], en: [] },
  "gpt-5.6-sol": { ja: ["GPT-5.6 Sol"], en: ["GPT-5.6 Sol"] },
  "gpt-5.5": { ja: ["GPT-5.5"], en: ["GPT-5.5"] },
};

/**
 * data-message-model-slug of the assistant turn, observed 2026-09-15 (post-hoc evidence only, never a
 * pre-submit gate). latest+instant=gpt-5-6, latest+thinking levels=gpt-5-6-thinking,
 * latest+pro=gpt-6-pro, gpt-5.6-sol+medium=gpt-5-6-thinking, gpt-5.5+high=gpt-5-5-thinking.
 */
export const MODEL_SLUG_PATTERNS: Partial<Record<ObservedModel, RegExp>> = {
  latest: /^gpt-(5-6|6)(-|$)/,
  "gpt-5.6-sol": /^gpt-5-6(-|$)/,
  "gpt-5.5": /^gpt-5-5(-|$)/,
};
export const EFFORT_SLUG_PATTERNS: Record<ObservedPreset, RegExp> = {
  instant: /^gpt-[0-9-]+$/,
  medium: /-thinking$/,
  high: /-thinking$/,
  extra_high: /-thinking$/,
  pro: /-pro$/,
};
export function slugMatches(
  model: ObservedModel | null,
  preset: ObservedPreset | null,
  slug: string,
): { ok: boolean; cause: string | null } {
  const m = model ? MODEL_SLUG_PATTERNS[model] : undefined;
  if (m && !m.test(slug)) return { ok: false, cause: `slug ${slug} does not match model ${model}` };
  const e = preset ? EFFORT_SLUG_PATTERNS[preset] : undefined;
  if (e && !e.test(slug))
    return { ok: false, cause: `slug ${slug} does not match preset ${preset}` };
  return { ok: true, cause: null };
}

export const PHRASES = {
  rateLimited: {
    ja: ["利用上限", "上限に達しました", "使用制限"],
    en: ["usage limit", "reached the limit", "You've hit", "limit reached", "rate limit"],
  },
  chatError: {
    ja: ["問題が発生しました", "エラーが発生しました", "応答の生成中にエラー"],
    en: ["Something went wrong", "There was an error generating a response", "An error occurred"],
  },
  networkError: {
    ja: ["ネットワークエラー", "接続が切断"],
    en: ["Network error", "connection was lost"],
  },
  challenge: {
    ja: ["人間であることを確認"],
    en: ["Verify you are human", "Just a moment"],
  },
} as const;

export function build(page: Page | Locator, c: Candidate): Locator {
  switch (c.kind) {
    case "role":
      return c.name === ""
        ? page.getByRole(c.role)
        : page.getByRole(c.role, { name: c.name, ...(c.exact ? { exact: true } : {}) });
    case "testid":
      return page.getByTestId(c.testId);
    case "placeholder":
      return page.getByPlaceholder(c.text);
    case "css":
      return page.locator(c.selector);
    case "text":
      return page.getByText(c.text);
  }
}

export function describeCandidate(c: Candidate): string {
  switch (c.kind) {
    case "role":
      return `role=${String(c.role)} name=${String(c.name)}`;
    case "testid":
      return `testid=${c.testId}`;
    case "placeholder":
      return `placeholder=${String(c.text)}`;
    case "css":
      return `css=${c.selector}`;
    case "text":
      return `text=${String(c.text)}`;
  }
}

export class DomUnexpected extends Error {
  constructor(
    public readonly element: ElementKey,
    public readonly tried: string[],
  ) {
    super(`DOM_UNEXPECTED: ${element}`);
  }
}

export interface Probe {
  found: boolean;
  enabled?: boolean;
  visible?: boolean;
  locator?: Locator;
  matches: number;
}

async function countVisible(loc: Locator): Promise<number> {
  const n = await loc.count();
  let visible = 0;
  for (let i = 0; i < Math.min(n, 20); i++) {
    if (
      await loc
        .nth(i)
        .isVisible()
        .catch(() => false)
    )
      visible++;
  }
  return visible;
}

/**
 * A-123 (Phase 0-C-2, ChatGPT Pro redesign review §2.2): `resolve()`/`probe()` used to check
 * `countVisible(loc) === 1` but then return `loc.first()` — the first DOM-order match, not
 * necessarily the one confirmed visible. If match #1 was hidden and match #2 was the visible one,
 * the caller got handed a hidden element while believing visibility had been verified. Returns the
 * actual visible `nth(i)` locator (or null if none/more than one), so callers never act on an
 * element whose visibility was never actually checked.
 */
async function findVisible(loc: Locator): Promise<{ count: number; visible: Locator | null }> {
  const n = await loc.count();
  let count = 0;
  let visible: Locator | null = null;
  for (let i = 0; i < Math.min(n, 20); i++) {
    if (
      await loc
        .nth(i)
        .isVisible()
        .catch(() => false)
    ) {
      count++;
      if (count === 1) visible = loc.nth(i);
    }
  }
  return { count, visible };
}

/** unique: first candidate that is visible and exactly-one. Throws DomUnexpected. Pre-submit only. */
export async function resolve(
  root: Page | Locator,
  key: ElementKey,
  opts: { verifiedOnly?: boolean } = {},
): Promise<Locator> {
  const def = ELEMENTS[key];
  const tried: string[] = [];
  for (const c of def.candidates) {
    if (opts.verifiedOnly && !c.verifiedOn) continue;
    const loc = build(root, c);
    const { count, visible } = await findVisible(loc);
    tried.push(`${describeCandidate(c)} -> ${count}`);
    if (count === 1 && visible) return visible;
  }
  throw new DomUnexpected(key, tried);
}

/** Read-only version of resolve for post-submit observation. Never throws. */
export async function probe(
  root: Page | Locator,
  key: ElementKey,
  opts: { verifiedOnly?: boolean } = {},
): Promise<Probe> {
  const def = ELEMENTS[key];
  for (const c of def.candidates) {
    if (opts.verifiedOnly && !c.verifiedOn) continue;
    try {
      const loc = build(root, c);
      const { count, visible } = await findVisible(loc);
      if (count === 1 && visible) {
        return {
          found: true,
          matches: 1,
          visible: true,
          enabled: await visible.isEnabled().catch(() => false),
          locator: visible,
        };
      }
      if (count > 1) return { found: false, matches: count };
    } catch {
      /* try next */
    }
  }
  return { found: false, matches: 0 };
}

/** presence: any candidate with >= 1 visible match. */
export async function exists(
  root: Page | Locator,
  key: ElementKey,
  opts: { verifiedOnly?: boolean } = {},
): Promise<boolean> {
  const def = ELEMENTS[key];
  for (const c of def.candidates) {
    if (opts.verifiedOnly && !c.verifiedOn) continue;
    try {
      if ((await countVisible(build(root, c))) >= 1) return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

/**
 * Returns every visible match from the first eligible candidate with a visible match. This is for
 * registry-defined list elements whose callers must inspect every item (for example, duplicate
 * Project-name detection), rather than silently choosing a DOM-order match.
 */
export async function all(
  root: Page | Locator,
  key: ElementKey,
  opts: { verifiedOnly?: boolean } = {},
): Promise<Locator[]> {
  const def = ELEMENTS[key];
  let eligible = false;
  const tried: string[] = [];
  for (const c of def.candidates) {
    if (opts.verifiedOnly && !c.verifiedOn) continue;
    eligible = true;
    try {
      const loc = build(root, c);
      const matches: Locator[] = [];
      for (let i = 0; i < (await loc.count()); i++) {
        const item = loc.nth(i);
        if (await item.isVisible().catch(() => false)) matches.push(item);
      }
      if (matches.length > 0) return matches;
      tried.push(`${describeCandidate(c)} -> 0`);
    } catch {
      tried.push(`${describeCandidate(c)} -> error`);
    }
  }
  if (!eligible) throw new DomUnexpected(key, def.candidates.map(describeCandidate));
  return [];
}

/** count: max attached matches across candidates. */
export async function countMatches(
  root: Page | Locator,
  key: ElementKey,
  opts: { verifiedOnly?: boolean } = {},
): Promise<number> {
  const def = ELEMENTS[key];
  let max = 0;
  for (const c of def.candidates) {
    if (opts.verifiedOnly && !c.verifiedOn) continue;
    try {
      max = Math.max(max, await build(root, c).count());
    } catch {
      /* try next */
    }
  }
  return max;
}

/** Locator of the last match of a count element (best candidate = the one with the max count). */
export async function latest(
  root: Page | Locator,
  key: ElementKey,
  opts: { verifiedOnly?: boolean } = {},
): Promise<Locator | null> {
  const def = ELEMENTS[key];
  let best: { loc: Locator; n: number } | null = null;
  for (const c of def.candidates) {
    if (opts.verifiedOnly && !c.verifiedOn) continue;
    try {
      const loc = build(root, c);
      const n = await loc.count();
      if (n > (best?.n ?? 0)) best = { loc, n };
    } catch {
      /* try next */
    }
  }
  return best ? best.loc.last() : null;
}

export function reverseLookupModel(
  radioText: string,
  locale: Locale,
): { model: ObservedModel } | { error: "unmapped" | "ambiguous" } {
  const first = (radioText.split(/\r?\n/)[0] ?? "").trim().toLowerCase();
  const hits: ObservedModel[] = [];
  for (const model of Object.keys(MODEL_LABELS) as ObservedModel[]) {
    const labels = [
      ...MODEL_LABELS[model][locale],
      ...MODEL_LABELS[model][locale === "ja" ? "en" : "ja"],
    ];
    if (labels.some((l) => l.trim().toLowerCase() === first)) hits.push(model);
  }
  if (hits.length === 1) return { model: hits[0] as ObservedModel };
  return { error: hits.length === 0 ? "unmapped" : "ambiguous" };
}

/**
 * The trigger reads "極高" with the default model and "<model short> <effort>" (e.g. "5.5 高",
 * observed 2026-09-15) once a model radio is chosen. Match the effort label as the whole string or
 * as the last space-separated token (longest label first so "極高" is not read as "高").
 */
/**
 * Trigger label prefixes observed 2026-09-15: none (latest), "5.6" (GPT-5.6 Sol), "5.5" (GPT-5.5),
 * "6" (latest routed to GPT-6 Pro at the pro level). Anything else is unknown -> fail closed.
 */
export const MODEL_HINTS: Record<string, { model: ObservedModel; preset?: ObservedPreset }> = {
  "5.6": { model: "gpt-5.6-sol" },
  "5.5": { model: "gpt-5.5" },
  "6": { model: "latest", preset: "pro" },
};

/** True when the trigger prefix agrees with what the menu showed (Codex P5-3). */
export function hintMatches(
  hint: string | null,
  model: ObservedModel,
  preset: ObservedPreset,
): boolean {
  if (hint === null) return model === "latest" && preset !== "pro";
  const h = MODEL_HINTS[hint];
  if (!h) return false;
  if (h.model !== model) return false;
  if (h.preset && h.preset !== preset) return false;
  if (!h.preset && model === "latest") return false;
  return true;
}

export function parseTriggerLabel(
  label: string,
  locale: Locale,
):
  | { preset: ObservedPreset; effortLabel: string; modelHint: string | null }
  | { error: "unmapped" } {
  const norm = label.trim();
  const whole = reverseLookupPreset(norm, locale);
  if (!("error" in whole)) return { preset: whole.preset, effortLabel: norm, modelHint: null };
  const candidates: Array<{ preset: ObservedPreset; l: string }> = [];
  for (const preset of Object.keys(PRESET_LABELS) as ObservedPreset[]) {
    for (const loc of ["ja", "en"] as Locale[])
      for (const l of PRESET_LABELS[preset][loc]) candidates.push({ preset, l });
  }
  candidates.sort((x, y) => y.l.length - x.l.length);
  const lower = norm.toLowerCase();
  for (const c of candidates) {
    const suffix = ` ${c.l.toLowerCase()}`;
    if (lower.endsWith(suffix)) {
      const hint = norm.slice(0, norm.length - suffix.length).trim();
      // unknown prefixes are not accepted (Codex P5-3): the caller cross-checks with hintMatches()
      if (!hint || !MODEL_HINTS[hint]) return { error: "unmapped" };
      return { preset: c.preset, effortLabel: c.l, modelHint: hint };
    }
  }
  return { error: "unmapped" };
}

export function reverseLookupPreset(
  label: string,
  locale: Locale,
): { preset: ObservedPreset } | { error: "unmapped" | "ambiguous" } {
  const norm = label.trim().toLowerCase();
  const hits: ObservedPreset[] = [];
  for (const preset of Object.keys(PRESET_LABELS) as ObservedPreset[]) {
    const labels = [
      ...PRESET_LABELS[preset][locale],
      ...PRESET_LABELS[preset][locale === "ja" ? "en" : "ja"],
    ];
    if (labels.some((l) => l.trim().toLowerCase() === norm)) hits.push(preset);
  }
  if (hits.length === 1) return { preset: hits[0] as ObservedPreset };
  return { error: hits.length === 0 ? "unmapped" : "ambiguous" };
}

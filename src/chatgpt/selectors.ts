import type { Locator, Page } from "playwright";
import type { ObservedPreset } from "../contracts/types.js";

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
  | "modelPickerOption"
  | "modelPickerCurrentLabel"
  | "assistantTurn"
  | "assistantTurnBody"
  | "copyTurnButton"
  | "continueButton"
  | "sidePanel"
  | "errorBanner"
  | "loginCta"
  | "challengeFrame"
  | "blockingDialog";

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
      { kind: "testid", testId: "send-button" },
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
  modelPickerOption: {
    key: "modelPickerOption",
    purpose: "メニュー内の選択肢",
    mode: "count",
    candidates: [{ kind: "role", role: "menuitem", name: "" }],
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
  continueButton: {
    key: "continueButton",
    purpose: "続きを生成（存在 = truncated）",
    mode: "presence",
    candidates: [{ kind: "role", role: "button", name: /続きを生成|Continue generating/i }],
  },
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
};

/**
 * preset = 思考 effort スライダーの段階（5 段階、aria-valuenow 0..4）。モデルのラジオ（「最新」等）は別次元で、
 * MVP では変更しない。ラベルは実画面で確認したものだけを登録する（2026-09-15: 「極高」= index 3）。
 * 他の段階のラベルは Phase 5 の選択実装時に確定する（未登録の段階は MODEL_NOT_VERIFIABLE で fail closed）。
 */
export const PRESET_LABELS: Record<ObservedPreset, Record<Locale, string[]>> = {
  instant: { ja: [], en: [] },
  medium: { ja: [], en: [] },
  high: { ja: [], en: [] },
  extra_high: { ja: ["極高"], en: ["Extra high"] },
  pro: { ja: [], en: [] },
};

/** Slider index -> preset (5 levels). Confirmed only for index 3 so far. */
export const EFFORT_SLIDER_INDEX: Partial<Record<number, ObservedPreset>> = { 3: "extra_high" };

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
    const visible = await countVisible(loc);
    tried.push(`${describeCandidate(c)} -> ${visible}`);
    if (visible === 1) return loc.first();
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
      const visible = await countVisible(loc);
      if (visible === 1) {
        const l = loc.first();
        return {
          found: true,
          matches: 1,
          visible: true,
          enabled: await l.isEnabled().catch(() => false),
          locator: l,
        };
      }
      if (visible > 1) return { found: false, matches: visible };
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

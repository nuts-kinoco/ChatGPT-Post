/**
 * 15-SECURITY §2: single source for the forbidden API / package / secret patterns.
 * Consumed by tests/unit/forbidden-tokens.test.ts (scans src/** and tests/fixtures/**).
 */
export const FORBIDDEN_CODE_TOKENS: ReadonlyArray<{ token: string; reason: string }> = [
  { token: "storageState(", reason: "SEC-002: never export auth state" },
  { token: ".cookies(", reason: "SEC-002: never read cookies" },
  { token: "addCookies(", reason: "SEC-002" },
  { token: "recordHar", reason: "SEC-003" },
  { token: ".route(", reason: "CON-008: no network interception" },
  { token: "waitForResponse(", reason: "CON-008" },
  { token: "waitForRequest(", reason: "CON-008" },
  { token: "on('request'", reason: "CON-008" },
  { token: 'on("request"', reason: "CON-008" },
  { token: "on('response'", reason: "CON-008" },
  { token: 'on("response"', reason: "CON-008" },
  { token: "on('websocket'", reason: "CON-008" },
  { token: 'on("websocket"', reason: "CON-008" },
  { token: "request.newContext(", reason: "CON-008" },
  { token: "page.request.", reason: "CON-008" },
  { token: "context.request.", reason: "CON-008" },
  { token: "setExtraHTTPHeaders(", reason: "SEC-002" },
  { token: "extraHTTPHeaders:", reason: "SEC-002" },
  { token: "userAgent:", reason: "SEC-008: no UA spoofing" },
  { token: "headless: true", reason: "CON-005" },
  { token: "clipboard.readText(", reason: "ADR-004: never read the system clipboard" },
  { token: "clipboard.read(", reason: "ADR-004" },
  { token: "'Cookies'", reason: "SEC-001: never open profile files" },
  { token: '"Cookies"', reason: "SEC-001" },
  { token: "Login Data", reason: "SEC-001" },
  { token: "Local State", reason: "SEC-001" },
  { token: "Web Data", reason: "SEC-001" },
  { token: "api.openai.com", reason: "CON-001" },
  { token: "platform.openai.com", reason: "CON-001" },
  { token: "backend-api", reason: "CON-008" },
  { token: "--enable-automation", reason: "SEC-008: no automation-flag tampering" },
];

export const FORBIDDEN_PACKAGES: readonly string[] = [
  "openai",
  "@openai/",
  "puppeteer-extra-plugin-stealth",
  "playwright-extra",
  "playwright-stealth",
  "tesseract.js",
  "node-tesseract-ocr",
  "proxy-chain",
  "undetected-",
];

/** Secret-looking content that must not be committed in src/ or fixtures. */
export const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9._-]{20,}/ },
  { name: "secure_cookie", re: /__Secure-/ },
  { name: "openai_key", re: /\bsk-[A-Za-z0-9]{10,}/ },
];

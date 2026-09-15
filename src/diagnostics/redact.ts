export const REDACT_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; replacement: string }> = [
  { name: "bearer", re: /Bearer\s+[A-Za-z0-9._~+/=-]+/g, replacement: "Bearer [REDACTED]" },
  {
    name: "header",
    re: /\b(cookie|authorization|set-cookie)(\s*[:=]\s*)[^\n]+/gi,
    replacement: "$1$2[REDACTED]",
  },
  { name: "openai_key", re: /\bsk-[A-Za-z0-9]{10,}/g, replacement: "sk-[REDACTED]" },
  { name: "secure_cookie", re: /__Secure-[^;\s"']+/g, replacement: "__Secure-[REDACTED]" },
  { name: "jwt", re: /\beyJ[A-Za-z0-9._-]{20,}/g, replacement: "eyJ[REDACTED]" },
  { name: "url_query", re: /(https?:\/\/[^\s"'<>?#]+)\?[^\s"'<>#]*/g, replacement: "$1?…" },
  { name: "url_fragment", re: /(https?:\/\/[^\s"'<>#]+)#[^\s"'<>]*/g, replacement: "$1#…" },
];

export const REDACT_PREVIEW_CHARS = 200;

/** SEC-005 / 15 §4: mask secrets and URL query/fragment. Does not truncate. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const p of REDACT_PATTERNS) out = out.replace(p.re, p.replacement);
  return out;
}

/** Truncate long text to a preview (used for prompt/response/DOM text in logs). */
export function preview(text: string, max = REDACT_PREVIEW_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(${text.length} chars)`;
}

/** Full log redaction: secrets masked then truncated. */
export function redact(text: string, max = REDACT_PREVIEW_CHARS): string {
  return preview(redactSecrets(text), max);
}

/** True if the text still contains something matching a secret pattern (used by the trace sanitizer). */
export function containsSecret(text: string): boolean {
  return REDACT_PATTERNS.filter((p) => p.name !== "url_query" && p.name !== "url_fragment").some(
    (p) => text.replace(p.re, p.replacement) !== text,
  );
}

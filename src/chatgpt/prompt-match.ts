/**
 * Comparison key for verifying prompt text. It intentionally preserves internal whitespace:
 * these checks guard against content loss, not formatting differences.
 */
export function normalisePrompt(text: string): string {
  return text.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
}

const MIN_COLLAPSED_PREFIX_LENGTH = 120;
const TRAILING_COLLAPSE_UI = /(?:\s*(?:…|\.\.\.|展開|Show more|折りたたむ)\s*)+$/u;

type UserTurnMatchOptions = {
  /** Attachment chips may be rendered as trailing text outside the prompt body. */
  allowTrailingText?: boolean;
};

/**
 * Matches ChatGPT's readable user-turn text to the submitted prompt.
 *
 * Long turns may be visually collapsed by ChatGPT, leaving an initial excerpt followed by an
 * ellipsis and an expand/collapse label. Exact text remains required for ordinary turns. A
 * collapsed excerpt is accepted only when it is a meaningful prefix of the expected prompt.
 */
export function userTurnMatchesPrompt(
  turnText: string,
  expectedPrompt: string,
  options: UserTurnMatchOptions = {},
): boolean {
  const actual = normalisePrompt(turnText);
  const expected = normalisePrompt(expectedPrompt);
  if (actual === expected) return actual.length > 0;
  if (options.allowTrailingText && expected.length > 0 && actual.startsWith(expected)) return true;

  const excerpt = actual.replace(TRAILING_COLLAPSE_UI, "").trimEnd();
  const minimum = Math.min(expected.length, MIN_COLLAPSED_PREFIX_LENGTH);
  return excerpt.length >= minimum && expected.startsWith(excerpt);
}

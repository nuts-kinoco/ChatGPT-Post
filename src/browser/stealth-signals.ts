/**
 * Experimental, opt-in-only browser fingerprint patch.
 *
 * This is deliberately a one-signal patch. The daemon measurement recorded a real
 * `navigator.webdriver === true`; it did not find any `cdc_` properties. Likewise,
 * `window.chrome.runtime` is normally unavailable to ordinary web pages unless an
 * extension exposes it, so inventing either signal here would make the comparison
 * less useful rather than more realistic.
 */
export const STEALTH_SIGNAL_PATCH = `
(() => {
  try {
    // Chrome exposes webdriver as an inherited accessor. Shadowing that accessor on this
    // Navigator instance makes the observed value undefined without changing unrelated APIs.
    Object.defineProperty(navigator, "webdriver", {
      configurable: true,
      get: () => undefined,
    });
  } catch {
    // Fingerprinting must never make a page unusable if a future browser disallows the shadow.
  }
})();
`;

/** The independently selectable mechanisms for the A-140 follow-up experiment. */
export type ExperimentalStealthMode = "off" | "initscript" | "extension";

export function parseExperimentalStealthMode(raw: string | undefined): {
  mode: ExperimentalStealthMode;
  warning?: string;
} {
  switch (raw) {
    case undefined:
    case "":
    case "0":
      return { mode: "off" };
    // Keep the initially proposed 1 spelling as the concise env-var form.
    case "1":
    case "initscript":
      return { mode: "initscript" };
    case "extension":
      return { mode: "extension" };
    default:
      return {
        mode: "off",
        warning: `warning: CHATGPT_BRIDGE_EXPERIMENTAL_STEALTH=${JSON.stringify(raw)} is not one of 0, 1, initscript, or extension; disabling the experiment\n`,
      };
  }
}

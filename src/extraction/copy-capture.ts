/**
 * ADR-004: page-side hook that captures what the page tries to write to the clipboard.
 * Registered only for `run`. Never reads or writes the system clipboard.
 */
export const COPY_CAPTURE_GLOBAL = "__bridgeCopyCapture";

export const COPY_CAPTURE_SHIM = `
(() => {
  const KEY = ${JSON.stringify(COPY_CAPTURE_GLOBAL)};
  try {
    const w = window;
    w[KEY] = null;
    const clip = navigator.clipboard;
    if (!clip) return;
    const origWriteText = clip.writeText ? clip.writeText.bind(clip) : null;
    const origWrite = clip.write ? clip.write.bind(clip) : null;
    Object.defineProperty(clip, "writeText", {
      configurable: true,
      value: (text) => { w[KEY] = String(text); return Promise.resolve(); },
    });
    Object.defineProperty(clip, "write", {
      configurable: true,
      value: async (items) => {
        try {
          for (const item of items || []) {
            const types = item.types || [];
            const pick = types.includes("text/plain") ? "text/plain" : types[0];
            if (!pick) continue;
            const blob = await item.getType(pick);
            w[KEY] = await blob.text();
            return;
          }
        } catch (e) { w[KEY] = null; }
      },
    });
    void origWriteText; void origWrite;
  } catch (e) { /* ignore */ }
})();
`;

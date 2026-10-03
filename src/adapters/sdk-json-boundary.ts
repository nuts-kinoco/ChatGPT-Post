/** Bounds Bridge's canonicalization of already yielded SDK values, not the SDK's internal allocations. */
export function canonicalSdkMessage(value: unknown, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 262144)
    throw new Error("sdk_json_limit");
  const chunks: string[] = [];
  let used = 0,
    nodes = 0;
  const active = new Set<object>();
  const put = (text: string) => {
    const n = Buffer.byteLength(text);
    if (used + n > maxBytes) throw new Error("sdk_json_limit");
    used += n;
    chunks.push(text);
  };
  const quoted = (text: string) => {
    if (text.length > maxBytes) throw new Error("sdk_json_limit");
    let n = 2;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = text.charCodeAt(++i);
        if (!(d >= 0xdc00 && d <= 0xdfff)) throw new Error("sdk_json_unicode");
        n += 4;
      } else if (c >= 0xdc00 && c <= 0xdfff) throw new Error("sdk_json_unicode");
      else if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) n += 2;
      else if (c < 32) n += 6;
      else n += c < 128 ? 1 : c < 2048 ? 2 : 3;
      if (used + n > maxBytes) throw new Error("sdk_json_limit");
    }
    put(JSON.stringify(text));
  };
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 16384 || depth > 32) throw new Error("sdk_json_shape_limit");
    if (v === null) {
      put("null");
      return;
    }
    if (typeof v === "string") {
      quoted(v);
      return;
    }
    if (typeof v === "boolean") {
      put(v ? "true" : "false");
      return;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("sdk_json_number");
      put(JSON.stringify(v));
      return;
    }
    if (typeof v !== "object" || active.has(v)) throw new Error("sdk_json_invalid");
    const array = Array.isArray(v),
      proto = Object.getPrototypeOf(v);
    if (
      (!array && proto !== Object.prototype && proto !== null) ||
      (array && proto !== Array.prototype)
    )
      throw new Error("sdk_json_prototype");
    if (Object.getOwnPropertySymbols(v).length) throw new Error("sdk_json_symbol");
    active.add(v);
    if (array) {
      if (v.length > 16384) throw new Error("sdk_json_shape_limit");
      put("[");
      for (let i = 0; i < v.length; i++) {
        if (i) put(",");
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !("value" in d)) throw new Error("sdk_json_accessor");
        visit(d.value, depth + 1);
      }
      put("]");
    } else {
      put("{");
      let first = true;
      for (const k in v) {
        if (!Object.hasOwn(v, k)) throw new Error("sdk_json_prototype");
        if (++nodes > 16384) throw new Error("sdk_json_shape_limit");
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (!d || !("value" in d)) throw new Error("sdk_json_accessor");
        if (!first) put(",");
        first = false;
        quoted(k);
        put(":");
        visit(d.value, depth + 1);
      }
      put("}");
    }
    active.delete(v);
  };
  visit(value, 0);
  return Buffer.from(chunks.join(""));
}

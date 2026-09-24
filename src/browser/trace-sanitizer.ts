import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import yauzl from "yauzl";
import yazl from "yazl";
import { redactSecrets } from "../diagnostics/redact.js";

export interface SanitizeReport {
  networkEntriesReduced: number;
  resourcesDropped: number;
  resourcesKept: number;
  textLinesRedacted: number;
}

const ALLOWED_MIME = [
  /^text\/css\b/i,
  /^font\//i,
  /^image\//i,
  /^application\/font/i,
  /^application\/x-font/i,
];
const TEXT_ENTRY = /\.(trace|stacks|network)$/;
const SANITIZE_YIELD_EVERY = 64;

/** Let timers (notably the run hard-watchdog) run during a bounded but busy trace sanitize. */
async function yieldSanitizer(count: number): Promise<void> {
  if (count % SANITIZE_YIELD_EVERY === 0)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Trace capture is diagnostic only.  These bounds keep a malformed or unexpectedly
 * busy trace from becoming a disk/RAM incident.  The sanitizer never reads more than
 * TRACE_MAX_UNCOMPRESSED_BYTES into memory and yields between work batches, so it cannot
 * starve the run watchdog for multi-GB input.
 */
export const TRACE_MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
export const TRACE_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const TRACE_SANITIZE_TIMEOUT_MS = 10_000;

async function withTraceTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`trace sanitization exceeded ${TRACE_SANITIZE_TIMEOUT_MS} ms cap`)),
      TRACE_SANITIZE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stripUrl(url: string): string {
  return url.replace(/[?#].*$/, "");
}

interface NetworkLine {
  type?: string;
  snapshot?: {
    request?: { url?: string; method?: string };
    response?: { status?: number; content?: { mimeType?: string; _sha1?: string } };
  };
  [k: string]: unknown;
}

/** Reduce a .network JSONL line to url/method/status/mimeType/sha1 (15 §3 step 4). */
export function reduceNetworkLine(
  line: string,
  allowedSha1: Set<string>,
  droppedSha1: Set<string>,
): string | null {
  let obj: NetworkLine;
  try {
    obj = JSON.parse(line) as NetworkLine;
  } catch {
    return null;
  }
  const req = obj.snapshot?.request;
  const res = obj.snapshot?.response;
  if (!req && !res) return null;
  const mime = res?.content?.mimeType ?? "";
  const sha1 = res?.content?._sha1;
  const allowed = ALLOWED_MIME.some((re) => re.test(mime));
  if (sha1) (allowed ? allowedSha1 : droppedSha1).add(sha1);
  const reduced = {
    type: obj.type ?? "resource-snapshot",
    snapshot: {
      request: { url: stripUrl(req?.url ?? ""), method: req?.method ?? "" },
      response: {
        status: res?.status ?? 0,
        content: { mimeType: mime, ...(allowed && sha1 ? { _sha1: sha1 } : {}) },
      },
    },
  };
  return JSON.stringify(reduced);
}

async function readZip(path: string, maxUncompressedBytes: number): Promise<Map<string, Buffer>> {
  return new Promise((resolvePromise, reject) => {
    const entries = new Map<string, Buffer>();
    let total = 0;
    yauzl.open(path, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("zip open failed"));
      zip.on("entry", (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        total += entry.uncompressedSize;
        if (total > maxUncompressedBytes) {
          zip.close();
          reject(new Error(`trace exceeds ${maxUncompressedBytes} byte uncompressed cap`));
          return;
        }
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error("zip stream failed"));
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
          stream.on("error", reject);
        });
      });
      zip.on("end", () => resolvePromise(entries));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

async function writeZip(path: string, entries: Map<string, Buffer>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const zip = new yazl.ZipFile();
  for (const [name, buf] of entries) zip.addBuffer(buf, name);
  zip.end();
  await new Promise<void>((resolvePromise, reject) => {
    const out = createWriteStream(path);
    zip.outputStream
      .pipe(out)
      .on("close", () => resolvePromise())
      .on("error", reject);
  });
}

/**
 * 15-SECURITY §3: reduce .network to header-less summaries, keep only allow-listed resources
 * (CSS / fonts / images / screencast frames), redact text entries line by line.
 */
export async function sanitizeEntries(entries: Map<string, Buffer>): Promise<{
  out: Map<string, Buffer>;
  report: SanitizeReport;
}> {
  const report: SanitizeReport = {
    networkEntriesReduced: 0,
    resourcesDropped: 0,
    resourcesKept: 0,
    textLinesRedacted: 0,
  };
  const allowedSha1 = new Set<string>();
  const droppedSha1 = new Set<string>();
  const out = new Map<string, Buffer>();

  // pass 1: network files first (they decide resource fate)
  let workItems = 0;
  for (const [name, buf] of entries) {
    await yieldSanitizer(++workItems);
    if (!name.endsWith(".network")) continue;
    const lines = buf.toString("utf8").split("\n");
    const kept: string[] = [];
    for (const line of lines) {
      await yieldSanitizer(++workItems);
      if (!line.trim()) continue;
      const r = reduceNetworkLine(line, allowedSha1, droppedSha1);
      if (r) {
        kept.push(r);
        report.networkEntriesReduced++;
      }
    }
    out.set(name, Buffer.from(`${kept.join("\n")}\n`, "utf8"));
  }
  // pass 1b: screencast frames are referenced from .trace, not .network
  const screencastSha1 = new Set<string>();
  for (const [name, buf] of entries) {
    await yieldSanitizer(++workItems);
    if (!name.endsWith(".trace")) continue;
    for (const line of buf.toString("utf8").split("\n")) {
      await yieldSanitizer(++workItems);
      if (!line.includes('"screencast-frame"')) continue;
      try {
        const obj = JSON.parse(line) as { type?: string; sha1?: string };
        if (obj.type === "screencast-frame" && obj.sha1) screencastSha1.add(obj.sha1);
      } catch {
        /* not JSON; ignore */
      }
    }
  }

  // pass 2: everything else. A resource survives only if .network allow-listed its MIME
  // or .trace references it as a screencast frame; extension alone is never enough.
  for (const [name, buf] of entries) {
    await yieldSanitizer(++workItems);
    if (name.endsWith(".network")) continue;
    if (name.startsWith("resources/")) {
      const base = name.slice("resources/".length);
      const sha1 = base.replace(/\.[A-Za-z0-9]+$/, "");
      const screencast = screencastSha1.has(sha1) || screencastSha1.has(base);
      const knownAllowed = allowedSha1.has(sha1) || allowedSha1.has(base);
      const knownDropped = droppedSha1.has(sha1) || droppedSha1.has(base);
      if ((knownAllowed || screencast) && !knownDropped) {
        out.set(name, buf);
        report.resourcesKept++;
      } else {
        report.resourcesDropped++;
      }
      continue;
    }
    if (TEXT_ENTRY.test(name)) {
      const lines = buf.toString("utf8").split("\n");
      const redacted: string[] = [];
      for (const line of lines) {
        await yieldSanitizer(++workItems);
        const r = redactSecrets(line);
        if (r !== line) report.textLinesRedacted++;
        redacted.push(r);
      }
      out.set(name, Buffer.from(redacted.join("\n"), "utf8"));
      continue;
    }
    // A-126 (Phase 0-C-5, ChatGPT Pro redesign review §2.15): entries that are none of the above
    // (not .network, not resources/*, not a known TEXT_ENTRY suffix) used to pass through
    // completely unmodified — a denylist by omission. If a future Playwright trace format version
    // adds a new text-like entry, it would carry secrets through unredacted. Classify by content
    // (same approach as A-125's attachment scan, not by name): redact any entry that looks
    // text-like; a genuinely binary unknown entry is passed through unchanged, matching the
    // existing accepted policy for resources/* binaries.
    const looksText = !buf.subarray(0, 8000).includes(0);
    if (looksText) {
      const lines = buf.toString("utf8").split("\n");
      const redacted: string[] = [];
      for (const line of lines) {
        await yieldSanitizer(++workItems);
        const r = redactSecrets(line);
        if (r !== line) report.textLinesRedacted++;
        redacted.push(r);
      }
      out.set(name, Buffer.from(redacted.join("\n"), "utf8"));
    } else {
      out.set(name, buf);
    }
  }
  return { out, report };
}

export async function sanitizeTraceZip(
  inputPath: string,
  outputPath: string,
): Promise<SanitizeReport> {
  return withTraceTimeout(
    (async () => {
      const input = await stat(inputPath);
      if (input.size > TRACE_MAX_COMPRESSED_BYTES) {
        throw new Error(`trace exceeds ${TRACE_MAX_COMPRESSED_BYTES} byte compressed cap`);
      }
      const entries = await readZip(inputPath, TRACE_MAX_UNCOMPRESSED_BYTES);
      const { out, report } = await sanitizeEntries(entries);
      await writeZip(outputPath, out);
      return report;
    })(),
  );
}

/** GitHub Git Database REST adapter. Credentials are injected by the host's existing provider.
 * No environment/keychain reads, login, token creation, redirects or arbitrary API destinations.
 */
import { createHash } from "node:crypto";
import { parseStrictJsonBytes } from "../contracts/task.js";

export interface GitPublicationBinding {
  whenPresentPath: string;
  bindingPath: string;
  bindingBlobSha: string;
}
export interface GitObjectStore {
  readonly destination?: { repositoryFullName: string; branch: string };
  snapshot(): Promise<GitSnapshot>;
  read(snapshot: GitSnapshot, path: string): Promise<Uint8Array | null>;
  append(files: ReadonlyMap<string, Uint8Array>, message: string): Promise<string>;
  /** Atomic all-or-absent publication with history binding rechecked at every retry snapshot. */
  appendConditional?(
    files: ReadonlyMap<string, Uint8Array>,
    message: string,
    bindings: readonly GitPublicationBinding[],
  ): Promise<string>;
}
export interface GitSnapshot {
  commit: string;
  tree: string;
  files: ReadonlyMap<string, string>;
  /** Complete bounded Git metadata; unrelated repository files are not task paths. */
  entries?: ReadonlyMap<string, { sha: string; type: "blob" | "tree" | "commit"; mode: string }>;
}
export interface GitHubCredentialProvider {
  /** Return an already provisioned credential. Never log it or persist it in task data. */
  authorization(): Promise<string>;
}
/** Already-authenticated host mediation, e.g. an approved connector. No credential transfer. */
export interface GitHubDatabasePort {
  request(
    input: {
      repositoryFullName: string;
      branch: string;
      path: string;
      method: string;
      body?: unknown;
    },
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}
export class GitHubHttpError extends Error {
  constructor(readonly status: number) {
    super(`github_http_${status}`);
  }
}
export function transportPath(path: string): void {
  if (
    !/^[a-zA-Z0-9_-][a-zA-Z0-9_./-]{0,500}$/.test(path) ||
    path.split("/").some((p) => !p || p === "." || p === ".." || p === ".git")
  )
    throw new Error("transport_path_denied");
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value))
    throw new Error("github_invalid_sha");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("github_invalid_response");
  return value as Record<string, unknown>;
}
export class GitHubGitStore implements GitObjectStore {
  readonly destination: { repositoryFullName: string; branch: string };
  private readonly root: string;
  private readonly ref: string;
  constructor(
    config: { owner: string; repository: string; branch: string },
    private readonly credentials: GitHubCredentialProvider | null,
    private readonly request: typeof fetch = fetch,
    private readonly limits = {
      timeoutMs: 10000,
      maxBytes: 4 * 1024 * 1024,
      maxFiles: 10000,
      conflicts: 4,
    },
    private readonly databasePort?: GitHubDatabasePort,
  ) {
    if (!credentials && !databasePort) throw new Error("github_credential_unavailable");
    if (databasePort)
      this.databasePort = Object.freeze({ request: databasePort.request.bind(databasePort) });
    if (
      ![config.owner, config.repository].every(
        (v) =>
          typeof v === "string" &&
          v.length <= 100 &&
          /^[a-zA-Z0-9_.-]+$/.test(v) &&
          ![".", ".."].includes(v),
      ) ||
      !/^[a-zA-Z0-9_/-]+$/.test(config.branch) ||
      config.branch.includes("//")
    )
      throw new Error("github_config_invalid");
    this.destination = Object.freeze({
      repositoryFullName: `${config.owner}/${config.repository}`,
      branch: config.branch,
    });
    this.root = `https://api.github.com/repos/${config.owner}/${config.repository}`;
    this.ref = config.branch.split("/").map(encodeURIComponent).join("/");
    if (
      !Number.isSafeInteger(limits.timeoutMs) ||
      limits.timeoutMs < 1 ||
      limits.timeoutMs > 60000 ||
      !Number.isSafeInteger(limits.maxBytes) ||
      limits.maxBytes < 1 ||
      limits.maxBytes > 64 * 1024 * 1024 ||
      !Number.isSafeInteger(limits.maxFiles) ||
      limits.maxFiles < 1 ||
      limits.maxFiles > 100000 ||
      !Number.isSafeInteger(limits.conflicts) ||
      limits.conflicts < 1 ||
      limits.conflicts > 10
    )
      throw new Error("github_limits_invalid");
    this.limits = Object.freeze({ ...limits });
  }
  private async api(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error("github_timeout"));
      }, this.limits.timeoutMs);
    });
    const operation = async () => {
      if (this.databasePort) {
        const bytes = await this.databasePort.request(
          {
            repositoryFullName: this.destination.repositoryFullName,
            branch: this.destination.branch,
            path,
            method,
            ...(body === undefined ? {} : { body: structuredClone(body) }),
          },
          abort.signal,
        );
        if (abort.signal.aborted) throw new Error("github_timeout");
        if (!(bytes instanceof Uint8Array) || bytes.length > this.limits.maxBytes)
          throw new Error("github_response_too_large");
        return object(parseStrictJsonBytes(bytes));
      }
      if (!this.credentials) throw new Error("github_credential_unavailable");
      const authorization = await this.credentials.authorization();
      if (abort.signal.aborted) throw new Error("github_timeout");
      if (!/^(Bearer|token) [^\s]+$/.test(authorization))
        throw new Error("github_credential_unavailable");
      if (abort.signal.aborted) throw new Error("github_timeout");
      const response = await this.request(`${this.root}${path}`, {
        method,
        redirect: "error",
        signal: abort.signal,
        headers: {
          Authorization: authorization,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new GitHubHttpError(response.status);
      }
      if (Number(response.headers.get("content-length")) > this.limits.maxBytes) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("github_response_too_large");
      }
      if (!response.body) throw new Error("github_response_empty");
      if (abort.signal.aborted) throw new Error("github_timeout");
      const reader = response.body.getReader();
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      abort.signal.addEventListener("abort", cancel, { once: true });
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (abort.signal.aborted) throw new Error("github_timeout");
          if (chunk.done) break;
          total += chunk.value.length;
          if (total > this.limits.maxBytes) {
            await reader.cancel();
            throw new Error("github_response_too_large");
          }
          chunks.push(chunk.value);
        }
      } finally {
        abort.signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
      return object(parseStrictJsonBytes(Buffer.concat(chunks)));
    };
    try {
      return await Promise.race([operation(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async snapshot(): Promise<GitSnapshot> {
    const reference = await this.api(`/git/ref/heads/${this.ref}`);
    const commit = sha(object(reference.object).sha);
    const value = await this.api(`/git/commits/${commit}`);
    if (sha(value.sha) !== commit) throw new Error("github_commit_mismatch");
    const tree = sha(object(value.tree).sha);
    return this.treeSnapshot(tree, commit);
  }
  private async treeSnapshot(tree: string, commit: string): Promise<GitSnapshot> {
    const data = await this.api(`/git/trees/${sha(tree)}?recursive=1`);
    if (sha(data.sha) !== tree) throw new Error("github_tree_mismatch");
    if (
      data.truncated !== false ||
      !Array.isArray(data.tree) ||
      data.tree.length > this.limits.maxFiles
    )
      throw new Error("github_tree_incomplete");
    const files = new Map<string, string>();
    const entries = new Map<
      string,
      { sha: string; type: "blob" | "tree" | "commit"; mode: string }
    >();
    for (const item of data.tree) {
      const entry = object(item);
      if (
        typeof entry.path !== "string" ||
        entry.path.length < 1 ||
        Buffer.byteLength(entry.path) > 4096 ||
        entry.path.includes("\0") ||
        entry.path.startsWith("/") ||
        entry.path.split("/").some((p) => !p || p === "." || p === "..") ||
        !["blob", "tree", "commit"].includes(String(entry.type)) ||
        typeof entry.mode !== "string" ||
        !(entry.type === "tree"
          ? entry.mode === "040000"
          : entry.type === "commit"
            ? entry.mode === "160000"
            : ["100644", "100755", "120000"].includes(entry.mode))
      )
        throw new Error("github_tree_invalid");
      if (entries.has(entry.path)) throw new Error("github_duplicate_path");
      const metadata = {
        sha: sha(entry.sha),
        type: entry.type as "blob" | "tree" | "commit",
        mode: entry.mode,
      };
      entries.set(entry.path, metadata);
      if (metadata.type === "blob") files.set(entry.path, metadata.sha);
    }
    return { commit, tree, files, entries };
  }

  async read(snapshot: GitSnapshot, path: string): Promise<Uint8Array | null> {
    transportPath(path);
    const expected = snapshot.files.get(path);
    const metadata = snapshot.entries?.get(path);
    if (metadata && (metadata.type !== "blob" || metadata.mode !== "100644"))
      throw new Error("github_unsafe_file");
    if (!expected) return null;
    if (snapshot.entries && (!metadata || metadata.sha !== expected))
      throw new Error("github_snapshot_inconsistent");
    const blob = await this.api(`/git/blobs/${sha(expected)}`);
    if (
      blob.encoding !== "base64" ||
      typeof blob.content !== "string" ||
      sha(blob.sha) !== expected ||
      !/^[a-zA-Z0-9+/=\r\n]*$/.test(blob.content)
    )
      throw new Error("github_blob_invalid");
    const bytes = Buffer.from(blob.content.replace(/[\r\n]/g, ""), "base64");
    if (
      bytes.length > this.limits.maxBytes ||
      blob.size !== bytes.length ||
      gitBlobSha(bytes) !== expected
    )
      throw new Error("github_blob_hash_mismatch");
    return bytes;
  }
  private verifyOverlay(
    base: GitSnapshot,
    created: GitSnapshot,
    desired: ReadonlyMap<string, string>,
  ): void {
    if (!base.entries || !created.entries) throw new Error("github_tree_metadata_missing");
    const expected = new Map([...base.entries].filter(([, e]) => e.type !== "tree"));
    for (const [path, hash] of desired)
      expected.set(path, { sha: hash, type: "blob", mode: "100644" });
    const leaves = [...created.entries].filter(([, e]) => e.type !== "tree");
    if (
      leaves.length !== expected.size ||
      leaves.some(([p, e]) => {
        const want = expected.get(p);
        return !want || want.sha !== e.sha || want.mode !== e.mode || want.type !== e.type;
      })
    )
      throw new Error("github_created_tree_mismatch");
    const affected = new Set<string>();
    for (const path of desired.keys()) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) affected.add(parts.slice(0, i).join("/"));
    }
    for (const [path, e] of base.entries) {
      if (e.type !== "tree") continue;
      const now = created.entries.get(path);
      if (now?.type !== "tree" || now.mode !== e.mode || (!affected.has(path) && now.sha !== e.sha))
        throw new Error("github_created_tree_mismatch");
    }
    for (const [path, e] of created.entries)
      if (e.type === "tree" && !base.entries.has(path) && !affected.has(path))
        throw new Error("github_created_tree_mismatch");
  }
  /** Append-only atomic batch. CAS is the non-force fast-forward of a single-parent commit.
   * A lost PATCH reply reconciles exact file blobs on the current head, never reexecutes a job. */
  async append(files: ReadonlyMap<string, Uint8Array>, message: string): Promise<string> {
    return this.appendBound(files, message, []);
  }
  async appendConditional(
    files: ReadonlyMap<string, Uint8Array>,
    message: string,
    bindings: readonly GitPublicationBinding[],
  ): Promise<string> {
    if (!bindings.length || bindings.length > 32)
      throw new Error("github_publication_binding_invalid");
    return this.appendBound(files, message, bindings);
  }
  private async appendBound(
    files: ReadonlyMap<string, Uint8Array>,
    message: string,
    inputBindings: readonly GitPublicationBinding[],
  ): Promise<string> {
    const bindings = inputBindings.map((v) => ({ ...v }));
    for (const b of bindings) {
      if (
        Object.keys(b).sort().join(",") !== "bindingBlobSha,bindingPath,whenPresentPath" ||
        !files.has(b.whenPresentPath) ||
        !files.has(b.bindingPath) ||
        !/^[a-f0-9]{40}(?![\s\S])/.test(b.bindingBlobSha) ||
        gitBlobSha(files.get(b.bindingPath) ?? new Uint8Array()) !== b.bindingBlobSha
      )
        throw new Error("github_publication_binding_invalid");
      transportPath(b.whenPresentPath);
      transportPath(b.bindingPath);
    }
    const assertBindings = (snapshot: GitSnapshot) => {
      for (const b of bindings)
        if (
          (snapshot.files.has(b.whenPresentPath) || snapshot.entries?.has(b.whenPresentPath)) &&
          (snapshot.files.get(b.bindingPath) !== b.bindingBlobSha ||
            (snapshot.entries &&
              (snapshot.entries.get(b.bindingPath)?.type !== "blob" ||
                snapshot.entries.get(b.bindingPath)?.mode !== "100644")))
        )
          throw new Error("github_publication_binding_conflict");
    };

    files = new Map([...files].map(([path, bytes]) => [path, Buffer.from(bytes)]));
    if (!files.size || files.size > 32 || message.length > 200)
      throw new Error("github_batch_invalid");
    const desired = new Map<string, string>();
    for (const [path, bytes] of files) {
      transportPath(path);
      if (bytes.length > this.limits.maxBytes / 2) throw new Error("github_file_too_large");
      desired.set(path, gitBlobSha(bytes));
    }
    const desiredPaths = [...desired.keys()];
    if (
      desiredPaths.some((path) =>
        desiredPaths.some((other) => other !== path && other.startsWith(`${path}/`)),
      )
    )
      throw new Error("github_batch_path_conflict");
    for (let attempt = 0; attempt < this.limits.conflicts; attempt++) {
      const base = await this.snapshot();
      assertBindings(base);
      let present = 0;
      for (const [path, hash] of desired) {
        const existing = base.files.get(path);
        const metadata = base.entries?.get(path);
        const ancestors = path
          .split("/")
          .slice(0, -1)
          .map((_, i) =>
            path
              .split("/")
              .slice(0, i + 1)
              .join("/"),
          );
        if (
          (metadata && (metadata.type !== "blob" || metadata.mode !== "100644")) ||
          ancestors.some(
            (p) =>
              base.files.has(p) || (base.entries?.has(p) && base.entries.get(p)?.type !== "tree"),
          ) ||
          [...(base.entries?.keys() ?? base.files.keys())].some((p) => p.startsWith(`${path}/`))
        )
          throw new Error("github_immutable_conflict");
        if (existing && existing !== hash) throw new Error("github_immutable_conflict");
        if (existing) present++;
      }
      if (present === files.size) return base.commit;
      // Partial prior publication cannot arise from this adapter's atomic writes.
      if (present) throw new Error("github_partial_batch_conflict");
      const entries = [];
      for (const [path, bytes] of files) {
        const blob = await this.api("/git/blobs", "POST", {
          content: Buffer.from(bytes).toString("base64"),
          encoding: "base64",
        });
        if (sha(blob.sha) !== desired.get(path)) throw new Error("github_uploaded_blob_mismatch");
        entries.push({ path, mode: "100644", type: "blob", sha: blob.sha });
      }
      const tree = await this.api("/git/trees", "POST", { base_tree: base.tree, tree: entries });
      const createdTree = sha(tree.sha);
      this.verifyOverlay(base, await this.treeSnapshot(createdTree, base.commit), desired);
      const commit = await this.api("/git/commits", "POST", {
        message,
        tree: createdTree,
        parents: [base.commit],
      });
      const head = sha(commit.sha);
      const confirmed = await this.api(`/git/commits/${head}`);
      if (
        sha(confirmed.sha) !== head ||
        sha(object(confirmed.tree).sha) !== createdTree ||
        !Array.isArray(confirmed.parents) ||
        confirmed.parents.length !== 1 ||
        sha(object(confirmed.parents[0]).sha) !== base.commit
      )
        throw new Error("github_created_commit_mismatch");
      try {
        await this.api(`/git/refs/heads/${this.ref}`, "PATCH", { sha: head, force: false });
        const visible = await this.snapshot();
        assertBindings(visible);
        if (
          ![...desired].every(
            ([path, hash]) =>
              visible.files.get(path) === hash &&
              visible.entries?.get(path)?.type === "blob" &&
              visible.entries?.get(path)?.mode === "100644",
          )
        )
          throw new Error("github_publication_unconfirmed");
        return visible.commit;
      } catch (error) {
        if (error instanceof GitHubHttpError && ![409, 422].includes(error.status)) throw error;
        // Network loss might mean PATCH succeeded. One bounded reread establishes that.
        const after = await this.snapshot();
        assertBindings(after);
        if (
          [...desired].every(
            ([path, hash]) =>
              after.files.get(path) === hash &&
              (!after.entries ||
                (after.entries.get(path)?.type === "blob" &&
                  after.entries.get(path)?.mode === "100644")),
          )
        )
          return after.commit;
        if (!(error instanceof GitHubHttpError)) throw new Error("github_commit_outcome_unknown");
      }
    }
    throw new Error("github_conflict_limit");
  }
}
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

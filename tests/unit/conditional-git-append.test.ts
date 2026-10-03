/** Actual append algorithm with inert Git metadata ports; no HTTP, credentials or repository writes. */
import { describe, expect, it, vi } from "vitest";
import {
  GitHubGitStore,
  GitHubHttpError,
  type GitPublicationBinding,
  type GitSnapshot,
  gitBlobSha,
} from "../../src/adapters/github-client.js";

const INDEX = "bridge-v2/request-index/00000000-0000-4000-8000-000000000001.json";
const PROOF =
  "bridge-v2/projects/product-a/requests/00000000-0000-4000-8000-000000000001/issuer_preparation.json";
const FILES = new Map([
  [INDEX, Buffer.from("signed-index")],
  [PROOF, Buffer.from("signed-preparation")],
]);
const BIND: GitPublicationBinding = {
  whenPresentPath: INDEX,
  bindingPath: PROOF,
  bindingBlobSha: gitBlobSha(FILES.get(PROOF) ?? Buffer.alloc(0)),
};
function snapshot(
  files = new Map<string, string>(),
  commit = "a".repeat(40),
  tree = "b".repeat(40),
): GitSnapshot {
  return {
    commit,
    tree,
    files: new Map(files),
    entries: new Map(
      [...files].map(([p, sha]) => [p, { sha, type: "blob" as const, mode: "100644" }]),
    ),
  };
}
function harness(initial = snapshot()) {
  const store = new GitHubGitStore(
    { owner: "owner", repository: "bus", branch: "main" },
    {
      authorization: async () => {
        throw new Error("no_credential_access");
      },
    },
    async () => {
      throw new Error("no_network");
    },
  );
  let current = initial,
    n = 100,
    conflict: (() => void) | undefined,
    lose = false;
  const trees = new Map<string, GitSnapshot>(),
    commits = new Map<string, { tree: string; parent: string }>();
  const read = vi
    .spyOn(store, "snapshot")
    .mockImplementation(async () => snapshot(new Map(current.files), current.commit, current.tree));
  const port = store as unknown as {
    api: (path: string, method?: string, body?: Record<string, unknown>) => Promise<unknown>;
    treeSnapshot: (tree: string, commit: string) => Promise<GitSnapshot>;
  };
  port.treeSnapshot = vi.fn(async (tree, commit) => {
    const t = trees.get(tree);
    if (!t) throw new Error("fixture_missing_tree");
    return { ...t, commit };
  });
  port.api = vi.fn(async (path, method = "GET", body) => {
    if (path === "/git/blobs")
      return { sha: gitBlobSha(Buffer.from(String(body?.content), "base64")) };
    if (path === "/git/trees") {
      const files = new Map(current.files);
      if (!body || !Array.isArray(body.tree)) throw new Error("fixture_invalid_tree");
      for (const entry of body.tree as { path: string; sha: string }[])
        files.set(entry.path, entry.sha);
      const sha = (++n).toString(16).padStart(40, "0");
      trees.set(sha, snapshot(files, current.commit, sha));
      return { sha };
    }
    if (path === "/git/commits") {
      const sha = (++n).toString(16).padStart(40, "0");
      if (!body || !Array.isArray(body.parents)) throw new Error("fixture_invalid_commit");
      commits.set(sha, { tree: String(body.tree), parent: String(body.parents[0] ?? "") });
      return { sha };
    }
    if (path.startsWith("/git/commits/")) {
      const sha = path.slice("/git/commits/".length),
        v = commits.get(sha);
      if (!v) throw new Error("fixture_missing_commit");
      return { sha, tree: { sha: v.tree }, parents: [{ sha: v.parent }] };
    }
    if (method === "PATCH") {
      if (conflict) {
        const c = conflict;
        conflict = undefined;
        c();
        throw new GitHubHttpError(409);
      }
      const sha = String(body?.sha),
        c = commits.get(sha);
      if (!c) throw new Error("fixture_missing_commit");
      const t = trees.get(c.tree);
      if (!t) throw new Error("fixture_missing_tree");
      current = snapshot(new Map(t.files), sha, c.tree);
      if (lose) {
        lose = false;
        throw new Error("fixture_lost_reply");
      }
      return { object: { sha } };
    }
    throw new Error("fixture_unexpected_api");
  });
  return {
    store,
    read,
    api: vi.mocked(port.api),
    get current() {
      return current;
    },
    conflictWith: (files: Map<string, string>) => {
      conflict = () => {
        current = snapshot(files, "c".repeat(40), "d".repeat(40));
      };
    },
    loseReply: () => {
      lose = true;
    },
  };
}
describe("conditional immutable Git append", () => {
  it("publishes index+preparation in the same commit and reuses an exact retry", async () => {
    const f = harness();
    const first = await f.store.appendConditional(FILES, "issuer", [BIND]);
    expect(f.current.files.get(PROOF)).toBe(BIND.bindingBlobSha);
    const count = f.api.mock.calls.length;
    expect(await f.store.appendConditional(FILES, "issuer", [BIND])).toBe(first);
    expect(f.api.mock.calls.length).toBe(count);
  });
  it("rejects legacy index without proof before any write", async () => {
    const f = harness(
      snapshot(new Map([[INDEX, gitBlobSha(FILES.get(INDEX) ?? Buffer.alloc(0))]])),
    );
    await expect(f.store.appendConditional(FILES, "issuer", [BIND])).rejects.toThrow(
      "github_publication_binding_conflict",
    );
    expect(f.api).not.toHaveBeenCalled();
  });
  it("rejects a different existing proof even if old task bytes match", async () => {
    const f = harness(
      snapshot(
        new Map([
          [INDEX, gitBlobSha(FILES.get(INDEX) ?? Buffer.alloc(0))],
          [PROOF, gitBlobSha(Buffer.from("another preparation"))],
        ]),
      ),
    );
    await expect(f.store.appendConditional(FILES, "issuer", [BIND])).rejects.toThrow(
      "github_publication_binding_conflict",
    );
    expect(f.api).not.toHaveBeenCalled();
  });
  it("rechecks binding after a competing legacy publication instead of adopting it", async () => {
    const f = harness();
    f.conflictWith(new Map([[INDEX, gitBlobSha(FILES.get(INDEX) ?? Buffer.alloc(0))]]));
    await expect(f.store.appendConditional(FILES, "issuer", [BIND])).rejects.toThrow(
      "github_publication_binding_conflict",
    );
    expect(f.api.mock.calls.filter((c) => c[1] === "PATCH")).toHaveLength(1);
    expect(f.current.files.has(PROOF)).toBe(false);
  });
  it("retries unrelated competing content without dropping it", async () => {
    const f = harness(),
      other = "outside/retained.txt";
    f.conflictWith(new Map([[other, gitBlobSha(Buffer.from("retained"))]]));
    await f.store.appendConditional(FILES, "issuer", [BIND]);
    expect(f.api.mock.calls.filter((c) => c[1] === "PATCH")).toHaveLength(2);
    expect(f.current.files.has(other)).toBe(true);
    expect(f.current.files.get(PROOF)).toBe(BIND.bindingBlobSha);
  });
  it("reconciles a successful ref update with a lost response without another mutation", async () => {
    const f = harness();
    f.loseReply();
    await f.store.appendConditional(FILES, "issuer", [BIND]);
    expect(f.api.mock.calls.filter((c) => c[1] === "PATCH")).toHaveLength(1);
  });
  it("validates that both trigger and bound proof belong to the atomic batch", async () => {
    const f = harness();
    await expect(
      f.store.appendConditional(FILES, "issuer", [
        { ...BIND, whenPresentPath: "other/index.json" },
      ]),
    ).rejects.toThrow("github_publication_binding_invalid");
    await expect(
      f.store.appendConditional(FILES, "issuer", [{ ...BIND, bindingBlobSha: "a".repeat(40) }]),
    ).rejects.toThrow("github_publication_binding_invalid");
    expect(f.read).not.toHaveBeenCalled();
  });
  it("copies mutable binding/file inputs before asynchronous snapshots", async () => {
    const f = harness(
      snapshot(new Map([[INDEX, gitBlobSha(FILES.get(INDEX) ?? Buffer.alloc(0))]])),
    );
    const bind = { ...BIND };
    let release!: () => void;
    const original = f.read.getMockImplementation();
    f.read.mockImplementationOnce(async () => {
      await new Promise<void>((r) => (release = r));
      return original?.() ?? snapshot();
    });
    const p = f.store.appendConditional(new Map(FILES), "issuer", [bind]);
    const denied = expect(p).rejects.toThrow("github_publication_binding_conflict");
    bind.whenPresentPath = "never-present";
    release();
    await denied;
    expect(f.api).not.toHaveBeenCalled();
  });
});

it("connector conditional publication cannot reference another namespace", async () => {
  const { GitHubConnectorStore } = await import("../../src/adapters/github-connector-store.js");
  const call = vi.fn(async () => {
    throw new Error("must_not_call_connector");
  });
  const store = new GitHubConnectorStore(
    { owner: "owner", repository: "bus", branch: "main", namespace: "bridge-v2" },
    { call },
  );
  await expect(
    store.appendConditional(FILES, "issuer", [{ ...BIND, whenPresentPath: "other/secret" }]),
  ).rejects.toThrow("connector_path_denied");
  expect(call).not.toHaveBeenCalled();
});

import { describe, expect, it, vi } from "vitest";
import { GitHubGitStore, gitBlobSha } from "../../src/adapters/github-client.js";
import {
  type GitHubConnectorHost,
  type GitHubConnectorOperation,
  GitHubConnectorStore,
} from "../../src/adapters/github-connector-store.js";

type Entry = { path: string; type: string; mode: string; sha: string };
class Host implements GitHubConnectorHost {
  calls: GitHubConnectorOperation[] = [];
  n = 10;
  head = "1".repeat(40);
  tree = "2".repeat(40);
  blobs = new Map<string, Buffer>();
  trees = new Map<string, Entry[]>();
  commits = new Map<string, string>();
  parents = new Map<string, string>();
  loseReply = false;
  constructor(extra: Entry[] = []) {
    const b = Buffer.from("unrelated\n"),
      h = gitBlobSha(b);
    this.blobs.set(h, b);
    this.trees.set(this.tree, [
      { path: ".gitignore", type: "blob", mode: "100644", sha: h },
      { path: "scripts/run.sh", type: "blob", mode: "100755", sha: h },
      { path: "notes/日本語.md", type: "blob", mode: "100644", sha: h },
      ...extra,
    ]);
    this.commits.set(this.head, this.tree);
  }
  next() {
    return String(++this.n).padStart(40, "0");
  }
  async call(op: GitHubConnectorOperation) {
    this.calls.push(structuredClone(op));
    const a = op.arguments;
    let value: unknown;
    if (op.tool === "github_fetch") {
      const url = String(a.url);
      if (!url.startsWith("https://api.github.com/repos/owner/bus/git/"))
        throw new Error("fixture_destination");
      const path = url.split("/git/")[1] ?? "";
      if (path.startsWith("ref/heads/")) value = { object: { sha: this.head } };
      else if (path.startsWith("commits/")) {
        const id = path.slice(8);
        value = {
          sha: id,
          tree: { sha: this.commits.get(id) },
          parents: this.parents.has(id) ? [{ sha: this.parents.get(id) }] : [],
        };
      } else if (path.startsWith("trees/")) {
        const id = path.slice(6).split("?")[0] ?? "";
        value = { sha: id, truncated: false, tree: this.trees.get(id) };
      } else if (path.startsWith("blobs/")) {
        const id = path.slice(6),
          b = this.blobs.get(id);
        if (!b) throw new Error("fixture_blob");
        value = { sha: id, encoding: "base64", content: b.toString("base64"), size: b.length };
      } else throw new Error("fixture_get");
      return { isError: false, structuredContent: { content: JSON.stringify(value) } };
    }
    if (a.repository_full_name !== "owner/bus") throw new Error("fixture_destination");
    if (op.tool === "github_create_blob") {
      const b = Buffer.from(String(a.content), "base64"),
        id = gitBlobSha(b);
      this.blobs.set(id, b);
      value = { sha: id };
    } else if (op.tool === "github_create_tree") {
      const id = this.next(),
        base = this.trees.get(String(a.base_tree_sha)) ?? [],
        entries = a.tree_elements as Entry[];
      this.trees.set(id, [
        ...base.filter((x) => !entries.some((e) => e.path === x.path)),
        ...entries,
      ]);
      value = { sha: id };
    } else if (op.tool === "github_create_commit") {
      const id = this.next();
      this.commits.set(id, String(a.tree_sha));
      this.parents.set(id, String(a.parent_sha));
      value = { sha: id };
    } else {
      expect(a.force).toBe(false);
      expect(a.branch_name).toBe("trial");
      this.head = String(a.sha);
      value = { branch: "trial" };
      if (this.loseReply) {
        this.loseReply = false;
        return { isError: true, structuredContent: {} };
      }
    }
    return { isError: false, structuredContent: value };
  }
}
const config = { owner: "owner", repository: "bus", branch: "trial", namespace: "bridge-v2" };
describe("connected Git-object host adapter, fake connector only", () => {
  it("performs real store algorithms through connector operations without credentials or HTTP", async () => {
    const host = new Host(),
      network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        throw new Error("network_forbidden");
      });
    try {
      const store = new GitHubConnectorStore(config, host);
      const bytes = Buffer.from("signed synthetic content");
      const commit = await store.append(
        new Map([["bridge-v2/request.json", bytes]]),
        "Bridge synthetic trial",
      );
      expect(commit).toBe(host.head);
      const snap = await store.snapshot();
      expect(snap.files.has(".gitignore")).toBe(true);
      expect(await store.read(snap, "bridge-v2/request.json")).toEqual(bytes);
      expect(snap.entries?.get("scripts/run.sh")?.mode).toBe("100755");
      expect(host.calls.some((x) => x.tool === "github_update_ref")).toBe(true);
      expect(JSON.stringify(host.calls)).not.toContain("Authorization");
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
  it("keeps immutable content and denies write/read outside namespace before any tool call", async () => {
    const host = new Host(),
      store = new GitHubConnectorStore(config, host);
    await expect(
      store.append(new Map([["elsewhere/result.json", Buffer.from("x")]]), "x"),
    ).rejects.toThrow("path_denied");
    expect(host.calls).toHaveLength(0);
    const snap = await store.snapshot();
    const before = host.calls.length;
    await expect(store.read(snap, ".gitignore")).rejects.toThrow("path_denied");
    expect(host.calls.length).toBe(before);
    await store.append(new Map([["bridge-v2/result.json", Buffer.from("one")]]), "x");
    await expect(
      store.append(new Map([["bridge-v2/result.json", Buffer.from("two")]]), "x"),
    ).rejects.toThrow("immutable_conflict");
  });
  it.each(["100755", "120000"])("does not overwrite occupied nonregular mode%s", async (mode) => {
    const host = new Host([
        {
          path: "bridge-v2/result.json",
          type: "blob",
          mode,
          sha: gitBlobSha(Buffer.from("unrelated\n")),
        },
      ]),
      store = new GitHubConnectorStore(config, host);
    const snap = await store.snapshot();
    await expect(store.read(snap, "bridge-v2/result.json")).rejects.toThrow("unsafe_file");
    await expect(
      store.append(new Map([["bridge-v2/result.json", Buffer.from("x")]]), "x"),
    ).rejects.toThrow("immutable_conflict");
    expect(host.calls.every((x) => x.tool === "github_fetch")).toBe(true);
  });
  it.each([
    { path: "bridge-v2", type: "blob", mode: "100644" },
    { path: "bridge-v2/result.json", type: "tree", mode: "040000" },
    { path: "bridge-v2/result.json/old", type: "blob", mode: "100644" },
  ])("rejects ancestor/directory/descendant collision %j", (entry) => {
    const host = new Host([{ ...entry, sha: gitBlobSha(Buffer.from("unrelated\n")) }]),
      store = new GitHubConnectorStore(config, host);
    return expect(
      store.append(new Map([["bridge-v2/result.json", Buffer.from("x")]]), "x"),
    ).rejects.toThrow("immutable_conflict");
  });
  it("rejects path conflicts within an atomic batch without contacting the host", async () => {
    const host = new Host(),
      store = new GitHubConnectorStore(config, host);
    await expect(
      store.append(
        new Map([
          ["bridge-v2/a", Buffer.from("x")],
          ["bridge-v2/a/b", Buffer.from("y")],
        ]),
        "x",
      ),
    ).rejects.toThrow("batch_path_conflict");
    expect(host.calls).toHaveLength(0);
  });
  it("reconciles a lost connector update reply without a second append", async () => {
    const host = new Host(),
      store = new GitHubConnectorStore(config, host);
    host.loseReply = true;
    await store.append(new Map([["bridge-v2/result.json", Buffer.from("x")]]), "x");
    expect(host.calls.filter((x) => x.tool === "github_update_ref")).toHaveLength(1);
  });
  it("bounds an unresponsive connector and never invokes fallback HTTP", async () => {
    let calls = 0;
    const store = new GitHubConnectorStore(
      config,
      {
        call: () => {
          calls++;
          return new Promise(() => {});
        },
      },
      { timeoutMs: 5, maxBytes: 1024, maxFiles: 10, conflicts: 1 },
    );
    await expect(store.snapshot()).rejects.toThrow("github_timeout");
    expect(calls).toBe(1);
  });
  it("does not permit absent credentials without an explicit database port", () => {
    expect(() => new GitHubGitStore(config, null)).toThrow("credential_unavailable");
  });
  it("rejects fabricated text-only tool replies and oversize connector payloads", async () => {
    const a = new GitHubConnectorStore(config, {
      call: async () => ({ content: [{ type: "text", text: '{"sha":"pretend"}' }] }),
    });
    await expect(a.snapshot()).rejects.toThrow("connector_response_invalid");
    const b = new GitHubConnectorStore(
      config,
      { call: async () => ({ structuredContent: { content: "x".repeat(2000) } }) },
      { timeoutMs: 100, maxBytes: 1024, maxFiles: 10, conflicts: 1 },
    );
    await expect(b.snapshot()).rejects.toThrow("connector_response_invalid");
  });
});

describe("independent portable boundary review", () => {
  it.each(["namespace", "owner", "repository", "branch"])(
    "rejects trailing LF in %s before host calls",
    async (field) => {
      const host = new Host();
      expect(
        () =>
          new GitHubConnectorStore(
            { ...config, [field]: `${config[field as keyof typeof config]}\n` },
            host,
          ),
      ).toThrow();
      expect(host.calls).toHaveLength(0);
    },
  );
  it("rejects trailing LF in requested artifact path before host calls", async () => {
    const host = new Host();
    const store = new GitHubConnectorStore(config, host);
    await expect(
      store.append(new Map([["bridge-v2/result.json\n", Buffer.from("new")]]), "x"),
    ).rejects.toThrow();
    expect(host.calls).toHaveLength(0);
  });
  it("rejects a response for a different tree before it overwrites an occupied artifact", async () => {
    const path = "bridge-v2/result.json";
    const old = Buffer.from("unrelated\n");
    const host = new Host([{ path, type: "blob", mode: "100644", sha: gitBlobSha(old) }]);
    const call = host.call.bind(host);
    host.call = async (op) => {
      if (op.tool === "github_fetch" && String(op.arguments.url).includes("/git/trees/")) {
        host.calls.push(structuredClone(op));
        return {
          isError: false,
          structuredContent: {
            content: JSON.stringify({ sha: "f".repeat(40), truncated: false, tree: [] }),
          },
        };
      }
      return call(op);
    };
    const store = new GitHubConnectorStore(config, host);
    await expect(
      store.append(new Map([[path, Buffer.from("replacement")]]), "x"),
    ).rejects.toThrow();
    expect(host.calls.every((x) => x.tool === "github_fetch")).toBe(true);
  });
  it("retains unrelated symlink and submodule without admitting them as artifact targets", async () => {
    const host = new Host([
      {
        path: "outside-link",
        type: "blob",
        mode: "120000",
        sha: gitBlobSha(Buffer.from("unrelated\n")),
      },
      { path: "vendor/sub", type: "commit", mode: "160000", sha: "c".repeat(40) },
    ]);
    const store = new GitHubConnectorStore(config, host);
    await store.append(new Map([["bridge-v2/result.json", Buffer.from("x")]]), "x");
    const snap = await store.snapshot();
    expect(snap.entries?.get("outside-link")?.mode).toBe("120000");
    expect(snap.entries?.get("vendor/sub")?.type).toBe("commit");
  });
  it("does not continue after a timed-out host finally replies", async () => {
    let release: ((v: unknown) => void) | undefined;
    let calls = 0;
    const store = new GitHubConnectorStore(
      config,
      {
        call: () => {
          calls++;
          return new Promise((r) => (release = r));
        },
      },
      { timeoutMs: 5, maxBytes: 1024, maxFiles: 10, conflicts: 1 },
    );
    await expect(store.snapshot()).rejects.toThrow("github_timeout");
    release?.({
      structuredContent: { content: JSON.stringify({ object: { sha: "1".repeat(40) } }) },
    });
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(1);
  });
  it("freezes requested byte content before awaiting host", async () => {
    const host = new Host();
    const store = new GitHubConnectorStore(config, host);
    const bytes = Buffer.from("old");
    const inputs = new Map([["bridge-v2/result.json", bytes]]);
    const pending = store.append(inputs, "x");
    bytes.fill("x");
    inputs.set("bridge-v2/other", Buffer.from("bad"));
    await pending;
    expect(await store.read(await store.snapshot(), "bridge-v2/result.json")).toEqual(
      Buffer.from("old"),
    );
    expect(await store.read(await store.snapshot(), "bridge-v2/other")).toBeNull();
  });
});

describe("independent portable publication evidence", () => {
  it("does not report append success when connector returns a different created tree", async () => {
    const host = new Host();
    const call = host.call.bind(host);
    host.call = async (op) => {
      if (op.tool === "github_create_tree") {
        host.calls.push(structuredClone(op));
        return { isError: false, structuredContent: { sha: host.tree } };
      }
      return call(op);
    };
    const store = new GitHubConnectorStore(config, host);
    await expect(
      store.append(new Map([["bridge-v2/result.json", Buffer.from("new")]]), "x"),
    ).rejects.toThrow();
  });
});

describe("independent portable uncertainty and occupied ancestors", () => {
  it.each([
    { type: "blob", mode: "120000" },
    { type: "commit", mode: "160000" },
  ])("blocks an occupied namespace ancestor %j before any write", async (e) => {
    const host = new Host([{ path: "bridge-v2", ...e, sha: "a".repeat(40) }]);
    const store = new GitHubConnectorStore(config, host);
    await expect(
      store.append(new Map([["bridge-v2/result.json", Buffer.from("new")]]), "x"),
    ).rejects.toThrow("immutable_conflict");
    expect(host.calls.every((x) => x.tool === "github_fetch")).toBe(true);
  });
  it("does not issue another mutation after an unconfirmed timed-out ref update", async () => {
    const host = new Host();
    const call = host.call.bind(host);
    host.call = async (op) => {
      if (op.tool === "github_update_ref") {
        host.calls.push(structuredClone(op));
        return new Promise(() => {});
      }
      return call(op);
    };
    const store = new GitHubConnectorStore(config, host, {
      timeoutMs: 5,
      maxBytes: 4096,
      maxFiles: 100,
      conflicts: 4,
    });
    await expect(
      store.append(new Map([["bridge-v2/result.json", Buffer.from("new")]]), "x"),
    ).rejects.toThrow("outcome_unknown");
    expect(host.calls.filter((x) => x.tool === "github_update_ref")).toHaveLength(1);
    expect(host.calls.filter((x) => x.tool === "github_create_commit")).toHaveLength(1);
  });
  it("rejects bytes whose SHA differs from the snapshot even if the response claims the expected SHA", async () => {
    const host = new Host();
    const store = new GitHubConnectorStore(config, host);
    await store.append(new Map([["bridge-v2/result.json", Buffer.from("new")]]), "x");
    const snapshot = await store.snapshot();
    const call = host.call.bind(host);
    host.call = async (op) => {
      const answer = await call(op);
      if (op.tool === "github_fetch" && String(op.arguments.url).includes("/git/blobs/")) {
        const data = JSON.parse(String((answer.structuredContent as { content: string }).content));
        data.content = Buffer.from("bad").toString("base64");
        return { isError: false, structuredContent: { content: JSON.stringify(data) } };
      }
      return answer;
    };
    // Use a fresh instance because the store freezes its original host callback.
    const reader = new GitHubConnectorStore(config, host);
    await expect(reader.read(snapshot, "bridge-v2/result.json")).rejects.toThrow("hash_mismatch");
  });
});

describe("verified publication overlay and commit ancestry", () => {
  it.each(["absent", "different"])(
    "rejects %s recursive tree identity before writes",
    async (mode) => {
      const h = new Host(),
        call = h.call.bind(h);
      h.call = async (op) => {
        const answer = await call(op);
        if (op.tool === "github_fetch" && String(op.arguments.url).includes("/trees/")) {
          const v = JSON.parse(String((answer.structuredContent as { content: string }).content));
          if (mode === "absent") delete v.sha;
          else v.sha = "f".repeat(40);
          return { isError: false, structuredContent: { content: JSON.stringify(v) } };
        }
        return answer;
      };
      await expect(
        new GitHubConnectorStore(config, h).append(
          new Map([["bridge-v2/a", Buffer.from("x")]]),
          "x",
        ),
      ).rejects.toThrow();
      expect(h.calls.every((c) => c.tool === "github_fetch")).toBe(true);
    },
  );
  it.each(["remove_unrelated", "replace_unrelated", "extra_leaf", "wrong_mode"])(
    "rejects created overlay %s before ref update",
    async (mode) => {
      const h = new Host(),
        call = h.call.bind(h);
      h.call = async (op) => {
        const answer = await call(op);
        if (op.tool === "github_create_tree") {
          const key = (answer.structuredContent as { sha: string }).sha,
            entries = h.trees.get(key) ?? [];
          if (mode === "remove_unrelated") entries.splice(0, 1);
          else if (mode === "extra_leaf")
            entries.push({
              path: "unrequested.txt",
              mode: "100644",
              type: "blob",
              sha: "a".repeat(40),
            });
          else {
            const e = entries[0];
            if (!e) throw new Error("fixture");
            if (mode === "wrong_mode") e.mode = "100755";
            else e.sha = "a".repeat(40);
          }
        }
        return answer;
      };
      await expect(
        new GitHubConnectorStore(config, h).append(
          new Map([["bridge-v2/a", Buffer.from("x")]]),
          "x",
        ),
      ).rejects.toThrow("created_tree_mismatch");
      expect(h.calls.some((c) => c.tool === "github_update_ref")).toBe(false);
    },
  );
  it.each(["parent", "tree"])(
    "rejects created commit %s mismatch before ref update",
    async (mode) => {
      const h = new Host(),
        call = h.call.bind(h);
      h.call = async (op) => {
        const answer = await call(op);
        if (op.tool === "github_create_commit") {
          const key = (answer.structuredContent as { sha: string }).sha;
          if (mode === "parent") h.parents.set(key, "f".repeat(40));
          else h.commits.set(key, h.tree);
        }
        return answer;
      };
      await expect(
        new GitHubConnectorStore(config, h).append(
          new Map([["bridge-v2/a", Buffer.from("x")]]),
          "x",
        ),
      ).rejects.toThrow("created_commit_mismatch");
      expect(h.calls.some((c) => c.tool === "github_update_ref")).toBe(false);
    },
  );
});

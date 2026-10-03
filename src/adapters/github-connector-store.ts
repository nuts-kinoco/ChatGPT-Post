/** Host-mediated connected GitHub adapter. It transfers no tokens and has no HTTP fallback. */
import { parseStrictJsonBytes } from "../contracts/task.js";
import {
  type GitHubDatabasePort,
  GitHubGitStore,
  type GitSnapshot,
  transportPath,
} from "./github-client.js";
export type GitHubConnectorOperation = {
  tool:
    | "github_fetch"
    | "github_create_blob"
    | "github_create_tree"
    | "github_create_commit"
    | "github_update_ref";
  arguments: Record<string, unknown>;
};
export interface GitHubConnectorHost {
  /** Must invoke the existing authorized connector, not execute text from a task/model stream. */
  call(operation: GitHubConnectorOperation, signal: AbortSignal): Promise<unknown>;
}
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("connector_response_invalid");
  return v as Record<string, unknown>;
}
function sha(v: unknown): string {
  if (typeof v !== "string" || !/^[a-f0-9]{40}$/.test(v) || v.length !== 40)
    throw new Error("connector_sha_invalid");
  return v;
}
function keys(v: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(v).length !== allowed.length || allowed.some((k) => !Object.hasOwn(v, k)))
    throw new Error("connector_operation_denied");
}
class ConnectedDatabasePort implements GitHubDatabasePort {
  private readonly call: GitHubConnectorHost["call"];
  constructor(
    private readonly repositoryFullName: string,
    private readonly branch: string,
    private readonly namespace: string,
    host: GitHubConnectorHost,
    private readonly maxBytes: number,
  ) {
    this.call = host.call.bind(host);
  }
  private async invoke(
    operation: GitHubConnectorOperation,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal.aborted) throw new Error("github_timeout");
    const result = record(await this.call(structuredClone(operation), signal));
    if (signal.aborted) throw new Error("github_timeout");
    if (result.isError === true) throw new Error("connector_operation_failed");
    const structured = record(result.structuredContent);
    if (operation.tool === "github_fetch") {
      if (
        typeof structured.content !== "string" ||
        Buffer.byteLength(structured.content) > this.maxBytes
      )
        throw new Error("connector_response_invalid");
      return record(parseStrictJsonBytes(Buffer.from(structured.content)));
    }
    const bytes = Buffer.from(JSON.stringify(structured));
    if (bytes.length > this.maxBytes) throw new Error("connector_response_too_large");
    return record(parseStrictJsonBytes(bytes));
  }
  async request(
    input: {
      repositoryFullName: string;
      branch: string;
      path: string;
      method: string;
      body?: unknown;
    },
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (input.repositoryFullName !== this.repositoryFullName || input.branch !== this.branch)
      throw new Error("connector_destination_denied");
    const repo = { repository_full_name: this.repositoryFullName },
      ref = this.branch.split("/").map(encodeURIComponent).join("/");
    let operation: GitHubConnectorOperation;
    if (input.method === "GET") {
      if (
        input.body !== undefined ||
        !(
          input.path === `/git/ref/heads/${ref}` ||
          /^\/git\/(commits|blobs)\/[a-f0-9]{40}$/.test(input.path) ||
          /^\/git\/trees\/[a-f0-9]{40}\?recursive=1$/.test(input.path)
        )
      )
        throw new Error("connector_operation_denied");
      operation = {
        tool: "github_fetch",
        arguments: { url: `https://api.github.com/repos/${this.repositoryFullName}${input.path}` },
      };
    } else {
      const body = record(input.body);
      if (input.method === "POST" && input.path === "/git/blobs") {
        keys(body, ["content", "encoding"]);
        if (
          body.encoding !== "base64" ||
          typeof body.content !== "string" ||
          body.content.length > this.maxBytes ||
          Buffer.from(body.content, "base64").toString("base64") !== body.content
        )
          throw new Error("connector_blob_denied");
        operation = {
          tool: "github_create_blob",
          arguments: { ...repo, content: body.content, encoding: "base64" },
        };
      } else if (input.method === "POST" && input.path === "/git/trees") {
        keys(body, ["base_tree", "tree"]);
        if (!Array.isArray(body.tree) || !body.tree.length || body.tree.length > 32)
          throw new Error("connector_tree_denied");
        for (const value of body.tree) {
          const entry = record(value);
          keys(entry, ["path", "mode", "type", "sha"]);
          if (
            typeof entry.path !== "string" ||
            !entry.path.startsWith(`${this.namespace}/`) ||
            entry.mode !== "100644" ||
            entry.type !== "blob"
          )
            throw new Error("connector_tree_denied");
          transportPath(entry.path);
          sha(entry.sha);
        }
        operation = {
          tool: "github_create_tree",
          arguments: {
            ...repo,
            base_tree_sha: sha(body.base_tree),
            tree_elements: structuredClone(body.tree),
          },
        };
      } else if (input.method === "POST" && input.path === "/git/commits") {
        keys(body, ["message", "tree", "parents"]);
        if (
          typeof body.message !== "string" ||
          body.message.length > 200 ||
          !Array.isArray(body.parents) ||
          body.parents.length !== 1
        )
          throw new Error("connector_commit_denied");
        operation = {
          tool: "github_create_commit",
          arguments: {
            ...repo,
            message: body.message,
            tree_sha: sha(body.tree),
            parent_sha: sha(body.parents[0]),
          },
        };
      } else if (input.method === "PATCH" && input.path === `/git/refs/heads/${ref}`) {
        keys(body, ["sha", "force"]);
        if (body.force !== false) throw new Error("connector_force_denied");
        operation = {
          tool: "github_update_ref",
          arguments: { ...repo, branch_name: this.branch, sha: sha(body.sha), force: false },
        };
      } else throw new Error("connector_operation_denied");
    }
    const response = await this.invoke(operation, signal);
    if (operation.tool === "github_update_ref") {
      const refResult = await this.invoke(
        {
          tool: "github_fetch",
          arguments: {
            url: `https://api.github.com/repos/${this.repositoryFullName}/git/ref/heads/${ref}`,
          },
        },
        signal,
      );
      if (sha(record(refResult.object).sha) !== operation.arguments.sha)
        throw new Error("connector_ref_unconfirmed");
      return Buffer.from(JSON.stringify(refResult));
    }
    return Buffer.from(JSON.stringify(response));
  }
}
export class GitHubConnectorStore extends GitHubGitStore {
  constructor(
    config: { owner: string; repository: string; branch: string; namespace: string },
    host: GitHubConnectorHost,
    limits = { timeoutMs: 60000, maxBytes: 4 * 1024 * 1024, maxFiles: 10000, conflicts: 4 },
  ) {
    transportPath(config.namespace);
    const namespace = config.namespace;
    super(
      config,
      null,
      undefined,
      limits,
      new ConnectedDatabasePort(
        `${config.owner}/${config.repository}`,
        config.branch,
        namespace,
        host,
        limits.maxBytes,
      ),
    );
    this.namespace = namespace;
  }
  private readonly namespace: string;
  override async read(snapshot: GitSnapshot, path: string) {
    if (!path.startsWith(`${this.namespace}/`)) throw new Error("connector_path_denied");
    return super.read(snapshot, path);
  }
  override async append(files: ReadonlyMap<string, Uint8Array>, message: string) {
    for (const path of files.keys())
      if (!path.startsWith(`${this.namespace}/`)) throw new Error("connector_path_denied");
    return super.append(new Map([...files].map(([p, b]) => [p, Buffer.from(b)])), message);
  }
}

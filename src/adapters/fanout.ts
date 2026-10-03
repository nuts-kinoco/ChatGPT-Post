/** Signed delivery grouping, separate from workflow execution authority. Each child keeps its own
 * approval, run, locks, timeout, immutable response and ACK. A blocked route cannot consume another.
 */

import { isDeepStrictEqual } from "node:util";
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";
import { applyFinalAppendGuard } from "./append-guard.js";
import type { FanoutMessage, GitHubTaskBus, IssuedMessage } from "./github-transport.js";
export interface FanoutInput {
  raw: Uint8Array;
  taskBytes: Uint8Array;
  recipientId: string;
  route: IssuedMessage["route"];
  outputContractRaw?: Uint8Array;
  expectedProjectRegistration?: import("../contracts/project-registry.js").ProjectRegistrationReference;
}
export interface FanoutChildView {
  requestId: string;
  route: IssuedMessage["route"];
  taskSpecHash: string;
  state: "pending" | "received" | "running" | "result_available" | "acknowledged" | "blocked";
  payloadSha256: string | null;
  outcome: string | null;
  result: unknown;
  error: string | null;
}
export class GitHubFanout {
  constructor(readonly bus: GitHubTaskBus) {}
  path(fanoutId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fanoutId))
      throw new Error("fanout_id_invalid");
    return `${this.bus.prefix}/workflows/${fanoutId}.json`;
  }
  async issue(
    fanoutId: string,
    requests: readonly FanoutInput[],
    finalAppendGuard?: () => void,
    issuerPreparation?: Uint8Array,
  ): Promise<string> {
    const path = this.path(fanoutId);
    if (requests.length < 2 || requests.length > 4) throw new Error("fanout_size_invalid");
    const files = new Map<string, Uint8Array>();
    const children: FanoutMessage["children"] = [];
    const issuances: IssuedMessage[] = [];
    for (const input of requests) {
      const prepared = await this.bus.prepareIssue(
        input.raw,
        input.taskBytes,
        input.recipientId,
        input.route,
        fanoutId,
        input.outputContractRaw,
        input.expectedProjectRegistration,
      );
      issuances.push(prepared.issued);
      if (
        children.some((child) => child.requestId === prepared.issued.requestId) ||
        prepared.issued.requestId === fanoutId
      )
        throw new Error("fanout_child_id_conflict");
      children.push({
        requestId: prepared.issued.requestId,
        taskSpecHash: prepared.issued.taskSpecHash,
        recipientId: input.recipientId,
        route: input.route,
      });
      for (const [name, bytes] of prepared.files) files.set(name, bytes);
    }
    const group: FanoutMessage = {
      kind: "fanout",
      fanoutId,
      requesterId: this.bus.codec.signer.actorId,
      children,
    };
    files.set(path, await this.bus.codec.encode(group));
    // One atomic Git commit publishes parent plus every child's JSON/MD/index; crash cannot leave
    // a half-published group. Retry uses identical UUIDs/bytes and never invokes either route.
    for (const issued of issuances) this.bus.assertPreparedIssueCurrent(issued);
    const bindings = issuerPreparation
      ? this.bus.attachIssuerPreparation(files, issuances, issuerPreparation)
      : null;
    if (bindings) {
      const append = this.bus.git.appendConditional;
      if (!append) throw new Error("issuer_conditional_append_unavailable");
      applyFinalAppendGuard(finalAppendGuard);
      return append.call(this.bus.git, files, `Bridge fanout ${fanoutId}`, bindings);
    }
    applyFinalAppendGuard(finalAppendGuard);
    return this.bus.git.append(files, `Bridge fanout ${fanoutId}`);
  }
  /** Bounded authenticated discovery. The next cursor is stable lexical order, not arrival time. */
  async list(
    after = "",
    limit = 32,
  ): Promise<{
    fanoutIds: string[];
    next: string | null;
    blocked: { fanoutId: string; reason: string }[];
  }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new Error("fanout_limit_invalid");
    const snapshot = await this.bus.git.snapshot();
    const prefix = `${this.bus.prefix}/workflows/`;
    const paths = [...snapshot.files.keys()]
      .filter((path) => path.startsWith(prefix) && path.endsWith(".json"))
      .map((path) => path.slice(prefix.length, -5))
      .filter(
        (id) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) && id > after,
      )
      .sort();
    const fanoutIds: string[] = [];
    const blocked: { fanoutId: string; reason: string }[] = [];
    let scanned = 0;
    let last: string | null = null;
    for (const id of paths) {
      if (scanned++ >= limit) break;
      last = id;
      try {
        const bytes = await this.bus.git.read(snapshot, this.path(id));
        if (!bytes) throw new Error("fanout_missing");
        const { message } = this.bus.codec.decode(bytes);
        if (message.kind !== "fanout" || message.fanoutId !== id)
          throw new Error("fanout_path_mismatch");
        if (message.requesterId === this.bus.codec.signer.actorId) fanoutIds.push(id);
      } catch (error) {
        blocked.push({
          fanoutId: id,
          reason:
            error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
              ? error.message
              : "fanout_read_failed",
        });
      }
    }
    return { fanoutIds, next: paths.length > limit ? last : null, blocked };
  }
  async collect(fanoutId: string): Promise<{
    fanoutId: string;
    commit: string;
    total: number;
    available: number;
    acknowledged: number;
    pending: number;
    children: FanoutChildView[];
  }> {
    const snapshot = await this.bus.git.snapshot();
    const bytes = await this.bus.git.read(snapshot, this.path(fanoutId));
    if (!bytes) throw new Error("fanout_not_found");
    const { message } = this.bus.codec.decode(bytes);
    if (
      message.kind !== "fanout" ||
      message.fanoutId !== fanoutId ||
      message.requesterId !== this.bus.codec.signer.actorId
    )
      throw new Error("fanout_requester_denied");
    const children: FanoutChildView[] = [];
    for (const child of message.children) {
      const view: FanoutChildView = {
        requestId: child.requestId,
        route: child.route,
        taskSpecHash: child.taskSpecHash,
        state: "pending",
        payloadSha256: null,
        outcome: null,
        result: null,
        error: null,
      };
      try {
        const { issued } = await this.bus.readIssued(
          snapshot,
          this.bus.path("inbox", child.requestId, "issued.json"),
        );
        if (
          issued.fanoutId !== fanoutId ||
          issued.requesterId !== message.requesterId ||
          issued.taskSpecHash !== child.taskSpecHash ||
          issued.recipientId !== child.recipientId ||
          issued.route !== child.route
        )
          throw new Error("fanout_child_binding_mismatch");
        const hosted = child.route === "ordinary_chat_browser";
        const event = hosted
          ? await this.bus.readHosted(snapshot, child.requestId, "hosted_result")
          : await this.bus.readEvent(snapshot, child.requestId, "terminal_result");
        if (event) {
          const payload = await this.bus.git.read(
            snapshot,
            this.bus.path(
              hosted ? "hosted" : "outbox",
              child.requestId,
              hosted ? "response.json" : "result.json",
            ),
          );
          if (
            !payload ||
            event.taskSpecHash !== child.taskSpecHash ||
            event.actorId !== child.recipientId ||
            sha256Bytes(payload) !== event.payloadSha256
          )
            throw new Error("fanout_result_unverified");
          view.result = parseStrictJsonBytes(payload);
          view.state = "result_available";
          view.payloadSha256 = event.payloadSha256;
          const result = view.result as { status?: unknown; result?: { status?: unknown } };
          const outcome = hosted ? result.result?.status : result.status;
          view.outcome = typeof outcome === "string" ? outcome : null;
          const ack = hosted
            ? await this.bus.readHosted(snapshot, child.requestId, "hosted_ack")
            : await this.bus.readEvent(snapshot, child.requestId, "result_ack");
          if (ack) {
            if (
              !isDeepStrictEqual(ack, {
                ...event,
                stage: hosted ? "hosted_ack" : "result_ack",
                actorId: message.requesterId,
              })
            )
              throw new Error("fanout_ack_mismatch");
            view.state = "acknowledged";
          }
        } else if (!hosted) {
          if (await this.bus.readEvent(snapshot, child.requestId, "start_receipt"))
            view.state = "running";
          else if (await this.bus.readEvent(snapshot, child.requestId, "receipt_ack"))
            view.state = "received";
        }
      } catch (error) {
        // Insufficient/corrupt ACK must not hide an already verified available result.
        if (view.state !== "result_available") view.state = "blocked";
        view.error =
          error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
            ? error.message
            : "fanout_collection_failed";
      }
      children.push(view);
    }
    const available = children.filter((child) =>
      ["result_available", "acknowledged"].includes(child.state),
    ).length;
    return {
      fanoutId,
      commit: snapshot.commit,
      total: children.length,
      available,
      acknowledged: children.filter((child) => child.state === "acknowledged").length,
      pending: children.length - available,
      children,
    };
  }
}

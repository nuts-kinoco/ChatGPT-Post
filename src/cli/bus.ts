/** Explicit host deployment entry point. Merely building/importing this module performs no IO. */

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ANTIGRAVITY_ADAPTER_CAPABILITIES } from "../adapters/antigravity.js";
import type { BridgeHost } from "../adapters/bridge-host.js";
import type { BrowserDeliveryService } from "../adapters/browser-delivery.js";
import { openTrustedDeployment } from "../adapters/deployment-loader.js";
import { GitHubFanout } from "../adapters/fanout.js";
import type { GitHubTaskBus } from "../adapters/github-transport.js";
import { parseStrictJsonBytes } from "../contracts/task.js";
import { checkFilesystemPath, checkRelativePath } from "../state/task-policy.js";
export interface BusDeployment {
  bus: GitHubTaskBus;
  host?: BridgeHost;
  materialize?(
    context: import("../adapters/github-transport.js").DeliveryAcceptanceContext,
  ): Promise<import("../contracts/materialization.js").MaterializationReceiptV1>;
  browser?: BrowserDeliveryService;
  /** Bound by the trusted local host login, never populated from arguments/task files. */
  localAuthority?(): { actorId: string; authenticated: true; expiresAt: string };
  close?(): Promise<void> | void;
}
const help = `Bridge GitHub transport host
Usage: node dist/cli/bus.js capabilities
       node dist/cli/bus.js --deployment /trusted/deployment.mjs tick
       node dist/cli/bus.js --deployment /trusted/deployment.mjs issue task.json task.md recipient cli|ordinary_chat_browser [output-contract.json]
       node dist/cli/bus.js --deployment /trusted/deployment.mjs approve request-id expected-task-sha256
       node dist/cli/bus.js --deployment /trusted/deployment.mjs browser-start request-id expected-task-sha256
       node dist/cli/bus.js --deployment /trusted/deployment.mjs fanout-issue fanout.json
       node dist/cli/bus.js --deployment /trusted/deployment.mjs fanout-result fanout-id
       node dist/cli/bus.js --deployment /trusted/deployment.mjs result request-id
       node dist/cli/bus.js --deployment /trusted/deployment.mjs ack request-id expected-payload-sha256
Deployment module exports openDeployment(): Promise<BusDeployment>. It must use already-authorized credential/signing providers.
No deployment, model CLI, authentication or persistent permissions are activated by capabilities.
Result only reads. ACK requires explicit acceptance plus verified requester-side durable materialization of result, receipt and artifacts. Never rerun an unknown request.`;
export async function runBusCli(args: string[]): Promise<unknown> {
  if (args.length === 1 && ["help", "capabilities"].includes(args[0] ?? ""))
    return args[0] === "help"
      ? { help }
      : {
          github: "implemented_unconfigured",
          actors: "ed25519_host_signer_required",
          cli: "broker_implemented_os_supervisor_required",
          ordinaryChat: "browser_delivery_implemented_live_unverified",
          quota: "public_app_server_management_only",
          antigravity: ANTIGRAVITY_ADAPTER_CAPABILITIES,
          liveActivated: false,
        };
  if (args[0] !== "--deployment" || !args[1] || !isAbsolute(args[1]))
    throw new Error("deployment_path_required");
  const command = args[2];
  if (
    !command ||
    ![
      "tick",
      "issue",
      "fanout-issue",
      "fanout-result",
      "approve",
      "browser-start",
      "result",
      "ack",
    ].includes(command)
  )
    throw new Error("bus_command_invalid");
  const deployment = await openTrustedDeployment<BusDeployment>(args[1]);
  try {
    const bus = deployment.bus;
    if (command === "tick") {
      if (args.length !== 3) throw new Error("bus_arguments_invalid");
      const [cli, browser] = await Promise.allSettled([
        deployment.host ? deployment.host.tick() : Promise.resolve(null),
        deployment.browser ? deployment.browser.tick() : Promise.resolve(null),
      ]);
      const value = (outcome: PromiseSettledResult<unknown>) =>
        outcome.status === "fulfilled"
          ? outcome.value
          : { error: "lane_tick_failed", reexecute: false };
      return { cli: value(cli), browser: value(browser) };
    }
    if (command === "issue") {
      const [request, task, recipient, route, outputContractFile] = args.slice(3);
      if (
        (args.length !== 7 && args.length !== 8) ||
        !request ||
        !task ||
        !recipient ||
        !["cli", "ordinary_chat_browser"].includes(route ?? "")
      )
        throw new Error("bus_arguments_invalid");
      return {
        commit: await bus.issue(
          await readFile(resolve(request)),
          await readFile(resolve(task)),
          recipient,
          route as "cli" | "ordinary_chat_browser",
          outputContractFile ? await readFile(resolve(outputContractFile)) : undefined,
        ),
      };
    }
    if (command === "fanout-issue") {
      if (args.length !== 4 || !args[3]) throw new Error("bus_arguments_invalid");
      const file = resolve(args[3]);
      const input = parseStrictJsonBytes(await readFile(file)) as {
        fanoutId?: unknown;
        requests?: unknown;
      };
      if (
        !input ||
        Object.keys(input).sort().join(",") !== "fanoutId,requests" ||
        typeof input.fanoutId !== "string" ||
        !Array.isArray(input.requests) ||
        input.requests.length < 2 ||
        input.requests.length > 4
      )
        throw new Error("fanout_manifest_invalid");
      const requests = [];
      for (const value of input.requests) {
        const item = value as Record<string, unknown>;
        if (
          !item ||
          ![
            "recipientId,requestFile,route,taskFile",
            "outputContractFile,recipientId,requestFile,route,taskFile",
          ].includes(Object.keys(item).sort().join(",")) ||
          (item.outputContractFile !== undefined && typeof item.outputContractFile !== "string") ||
          typeof item.requestFile !== "string" ||
          typeof item.taskFile !== "string" ||
          typeof item.recipientId !== "string" ||
          !["cli", "ordinary_chat_browser"].includes(String(item.route))
        )
          throw new Error("fanout_manifest_invalid");
        for (const path of [
          item.requestFile,
          item.taskFile,
          ...(typeof item.outputContractFile === "string" ? [item.outputContractFile] : []),
        ]) {
          checkRelativePath(path);
          await checkFilesystemPath(dirname(file), path);
        }
        requests.push({
          raw: await readFile(resolve(dirname(file), item.requestFile)),
          taskBytes: await readFile(resolve(dirname(file), item.taskFile)),
          recipientId: item.recipientId,
          route: item.route as "cli" | "ordinary_chat_browser",
          ...(typeof item.outputContractFile === "string"
            ? { outputContractRaw: await readFile(resolve(dirname(file), item.outputContractFile)) }
            : {}),
        });
      }
      return {
        commit: await new GitHubFanout(bus).issue(input.fanoutId, requests),
        fanoutId: input.fanoutId,
      };
    }
    const requestId = args[3];
    if (!requestId) throw new Error("bus_arguments_invalid");
    if (command === "fanout-result") {
      if (args.length !== 4) throw new Error("bus_arguments_invalid");
      return new GitHubFanout(bus).collect(requestId);
    }
    if (command === "approve" || command === "browser-start") {
      const taskHash = args[4];
      if (args.length !== 5 || !taskHash || !/^[0-9a-f]{64}$/.test(taskHash))
        throw new Error("bus_arguments_invalid");
      if (command === "approve") {
        const controller = deployment.host?.pump.controller;
        if (!controller || controller.store.get(requestId)?.result.task_spec_hash !== taskHash)
          throw new Error("approval_task_mismatch");
        const grant = await deployment.host?.authority.approve(requestId);
        if (!grant) throw new Error("approval_authority_unconfigured");
        return { result: controller.approve(requestId, grant).result };
      }
      const local = deployment.localAuthority?.();
      if (!local || !deployment.browser) throw new Error("approval_authority_unconfigured");
      deployment.browser.approve(requestId, { ...local, taskSpecHash: taskHash });
      await deployment.browser.start(requestId);
      return { result: await deployment.browser.reconcile(requestId) };
    }
    const snapshot = await bus.git.snapshot();
    const { issued } = await bus.readIssued(snapshot, bus.path("inbox", requestId, "issued.json"));
    const hosted = issued.route === "ordinary_chat_browser";
    if (command === "result") {
      if (args.length !== 4) throw new Error("bus_arguments_invalid");
      const event = hosted
        ? await bus.readHosted(snapshot, requestId, "hosted_result")
        : await bus.readEvent(snapshot, requestId, "terminal_result");
      if (!event) return { requestId, state: "pending", reexecute: false };
      const path = bus.path(
        hosted ? "hosted" : "outbox",
        requestId,
        hosted ? "response.json" : "result.json",
      );
      const bytes = await bus.git.read(snapshot, path);
      const { sha256Bytes } = await import("../contracts/task.js");
      if (
        !bytes ||
        event.taskSpecHash !== issued.taskSpecHash ||
        event.actorId !== issued.recipientId ||
        sha256Bytes(bytes) !== event.payloadSha256
      )
        throw new Error("transport_result_unverified");
      return {
        commit: snapshot.commit,
        event,
        result: parseStrictJsonBytes(bytes),
        reexecute: false,
      };
    }
    const hash = args[4];
    if (args.length !== 5 || !hash || !/^[0-9a-f]{64}$/.test(hash))
      throw new Error("bus_arguments_invalid");
    if (!deployment.materialize) throw new Error("delivery_materializer_unconfigured");
    const accept = async (
      _bytes: Uint8Array,
      event: { payloadSha256: string },
      context: import("../adapters/github-transport.js").DeliveryAcceptanceContext,
    ) => {
      if (event.payloadSha256 !== hash) throw new Error("ack_payload_changed");
      return deployment.materialize?.(context);
    };
    return {
      commit: hosted
        ? await bus.acceptHosted(requestId, accept)
        : await bus.acceptResult(requestId, accept),
      acknowledgedPayloadSha256: hash,
    };
  } finally {
    await deployment.close?.();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runBusCli(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(
        `${JSON.stringify({ error: error instanceof Error && /^[a-z_0-9]+$/.test(error.message) ? error.message : "bus_operation_failed", reexecute: false, nextAction: "Validate JSON and MD with task validate; inspect the same request ID/hash for transport errors. Do not reexecute an unknown dispatch." })}\n`,
      );
      process.exitCode = 1;
    },
  );
}

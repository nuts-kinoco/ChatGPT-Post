/** Explicit one-shot SDK text commands. Help/capabilities never load SDK or host configuration. */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openTrustedDeployment } from "../adapters/deployment-loader.js";
import type { SdkTextDeployment } from "../adapters/sdk-text-deployment.js";
import { runSdkTextRoundtrip } from "../adapters/sdk-text-roundtrip.js";
import { parseTextRequest, TEXT_BOUNDS, TEXT_MODEL } from "../contracts/sdk-text-inference.js";
import { sha256Bytes } from "../contracts/task.js";

const help = `Bridge official SDK synthetic text trial
node dist/cli/sdk-text.js capabilities
node dist/cli/sdk-text.js --deployment /trusted/deployment.mjs generate REPO_ID
node dist/cli/sdk-text.js --deployment /trusted/deployment.mjs trial request.json task.md
node dist/cli/sdk-text.js --deployment /trusted/deployment.mjs preflight
node dist/cli/sdk-text.js --deployment /trusted/deployment.mjs issue request.json task.md
node dist/cli/sdk-text.js --deployment /trusted/deployment.mjs receive|approve|start|reconcile|cancel REQUEST_ID EXPECTED_REQUEST_SHA256
node dist/cli/sdk-text.js --deployment /trusted/deployment.mjs status REQUEST_ID
node dist/cli/sdk-text.js --deployment /trusted/deployment.mjs collect REQUEST_ID EXPECTED_RESULT_SHA256
Configured module exports openDeployment(): SdkTextDeployment. Generate has no authority or writes. Preflight only performs documented read-only version/help/auth checks.
Start alone invokes the approved SDK query after durable intent. Unknown/crash/timeout is never automatically reexecuted. Collect saves verified bytes durably before signed ACK.
Runtime: official SDK managed, trusted host; no OS confinement or observed subprocess exit. Existing account/auth/signing configuration and explicit one-shot trial permission are required.`;
const uuid = (v: string | undefined) =>
  typeof v === "string" &&
  v.length === 36 &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hash = (v: string | undefined) =>
  typeof v === "string" && v.length === 64 && /^[a-f0-9]{64}$/.test(v);
async function bounded(path: string, max: number) {
  const p = resolve(path),
    s = await stat(p);
  if (!s.isFile() || s.size > max) throw new Error("sdk_text_input_bounds");
  const b = await readFile(p);
  if (b.length > max) throw new Error("sdk_text_input_bounds");
  return b;
}
export async function runSdkTextCli(
  args: string[],
  load = openTrustedDeployment<SdkTextDeployment>,
): Promise<unknown> {
  if (args.length === 1 && args[0] === "help") return { help };
  if (args.length === 1 && args[0] === "capabilities")
    return {
      route: "official-sdk-managed",
      sdkVersion: "0.3.287",
      cliVersion: "2.1.288",
      model: TEXT_MODEL,
      bounds: TEXT_BOUNDS,
      auth: "not_checked",
      configured: false,
      liveActivated: false,
      osConfinement: false,
      osProcessExit: "unobserved",
    };
  if (args[0] !== "--deployment" || !args[1] || !isAbsolute(args[1]))
    throw new Error("deployment_path_required");
  const action = args[2],
    id = args[3],
    expected = args[4];
  if (
    !action ||
    ![
      "generate",
      "trial",
      "preflight",
      "issue",
      "receive",
      "approve",
      "start",
      "reconcile",
      "cancel",
      "status",
      "collect",
    ].includes(action)
  )
    throw new Error("sdk_text_command_invalid");
  if (
    action === "preflight"
      ? args.length !== 3
      : action === "generate"
        ? args.length !== 4
        : action === "status"
          ? args.length !== 4 || !uuid(id)
          : action === "issue" || action === "trial"
            ? args.length !== 5
            : args.length !== 5 || !uuid(id) || !hash(expected)
  )
    throw new Error("sdk_text_arguments_invalid");
  const abort = new AbortController();
  let runtime: SdkTextDeployment | undefined,
    ownedRequestId = action === "start" ? id : undefined,
    ownedRequestHash = action === "start" ? expected : undefined;
  let closing: Promise<void> | null = null,
    closed = false,
    reportedPending = false;
  const attemptClose = async () => {
    if (!runtime || closed) return;
    if (closing) return closing;
    closing = Promise.resolve().then(() => runtime?.close());
    try {
      await closing;
      closed = true;
    } finally {
      closing = null;
    }
  };
  const stop = () => {
    if (!abort.signal.aborted) {
      abort.abort();
      if (runtime && ownedRequestId) {
        try {
          if (runtime.recipient?.get(ownedRequestId)?.requestSha256 === ownedRequestHash)
            runtime.recipient?.cancel(ownedRequestId);
        } catch {
          /* Durable unknown remains inspectable. */
        }
      }
      try {
        runtime?.beginShutdown?.();
      } catch {
        /* drain below retains the same runtime */
      }
    }
    if (runtime && !runtime.beginShutdown) void attemptClose().catch(() => undefined);
  };
  // An SDK iterator can be pending without a Node handle; retain ownership throughout the action and drain.
  const keepalive = setInterval(() => {}, 1000);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    try {
      runtime = await load(args[1], { signal: abort.signal });
    } catch (error) {
      if (abort.signal.aborted) throw new Error("sdk_text_stopping");
      throw error;
    }
    if (abort.signal.aborted) {
      stop();
      throw new Error("sdk_text_stopping");
    }
    if (action === "generate") return runtime.generate(String(id));
    if (action === "trial") {
      if (!id || !expected) throw new Error("sdk_text_arguments_invalid");
      const raw = await bounded(id, 16384),
        md = await bounded(expected, 4096);
      ownedRequestId = parseTextRequest(raw, md).requestId;
      ownedRequestHash = sha256Bytes(raw);
      if (abort.signal.aborted) {
        stop();
        throw new Error("sdk_text_stopping");
      }
      return await runSdkTextRoundtrip(runtime, raw, md, abort.signal);
    }
    if (action === "preflight") {
      if (!runtime.preflight) throw new Error("sdk_text_preflight_unconfigured");
      return await runtime.preflight();
    }
    if (action === "issue") {
      if (!id || !expected) throw new Error("sdk_text_arguments_invalid");
      const raw = await bounded(id, 16384),
        md = await bounded(expected, 4096);
      parseTextRequest(raw, md);
      return { commit: await runtime.requester.issue(runtime.requesterBus, raw, md, new Date()) };
    }
    if (!id) throw new Error("sdk_text_arguments_invalid");
    if (action === "collect") {
      const terminal = await runtime.requesterBus.readStage(id, "result");
      if (!terminal || terminal.packet.bodySha256 !== expected)
        throw new Error("sdk_text_result_hash_mismatch");
      return await runtime.requester.collect(runtime.requesterBus, id, new Date(), expected);
    }
    const service = runtime.recipient;
    if (!service) throw new Error("sdk_text_recipient_unconfigured");
    if (action === "status") {
      const job = service.get(id);
      return job
        ? {
            requestId: id,
            requestSha256: job.requestSha256,
            state: job.state,
            cancelled: !!job.cancelledAt,
            hasIntent: !!job.intentBase64,
            hasResult: !!job.resultBase64,
          }
        : null;
    }
    if (action === "receive") {
      const issued = await runtime.requesterBus.read(id);
      if (issued.packet.requestSha256 !== expected)
        throw new Error("sdk_text_request_hash_mismatch");
      return await service.receive(id);
    }
    if (service.get(id)?.requestSha256 !== expected)
      throw new Error("sdk_text_request_hash_mismatch");
    if (action === "approve") return await service.approve(id);
    if (action === "start") return await service.start(id, abort.signal);
    if (action === "reconcile") return await service.reconcile(id);
    return service.cancel(id);
  } finally {
    // Retain this exact runtime until its iterator/store drain confirms.
    try {
      for (;;) {
        try {
          await attemptClose();
          break;
        } catch {
          if (!reportedPending) {
            reportedPending = true;
            process.stderr.write(
              `${JSON.stringify({ error: "sdk_text_drain_pending", requestId: ownedRequestId ?? null, reexecute: false, retainingRuntime: true })}\n`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    } finally {
      clearInterval(keepalive);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  }
}
const safeErrors = new Set([
  "deployment_path_required",
  "deployment_file_untrusted",
  "deployment_directory_untrusted",
  "deployment_symlink_denied",
  "deployment_factory_missing",
  "sdk_text_arguments_invalid",
  "sdk_text_command_invalid",
  "sdk_text_request_hash_mismatch",
  "sdk_text_result_hash_mismatch",
  "sdk_text_recipient_unconfigured",
  "sdk_text_preflight_unconfigured",
  "sdk_text_drain_pending",
  "sdk_text_stopping",
  "sdk_text_trial_approval_required",
  "sdk_text_trial_config_required",
  "sdk_text_trial_config_invalid",
  "sdk_text_trial_command_required",
  "sdk_text_trial_already_admitted",
  "sdk_text_trial_authority_denied",
  "sdk_text_approval_required",
  "sdk_text_authority_unavailable",
  "sdk_text_authority_timeout",
  "sdk_text_host_scope_denied",
  "sdk_text_claim_owned_elsewhere",
  "sdk_text_probe_stale_or_changed",
  "sdk_text_recovery_binding_invalid",
  "sdk_text_recovery_observation_invalid",
  "sdk_text_cancelled",
  "sdk_text_database_untrusted",
  "sdk_text_version_unsupported",
  "text_host_auth_unavailable",
  "text_host_installation_changed",
  "text_host_capability_missing",
  "text_host_profile_invalid",
  "text_host_cwd_not_empty",
  "text_host_managed_metadata_out_of_profile",
  "text_request_missing",
  "text_requester_pin_required",
  "text_requester_pin_conflict",
  "text_requester_root_mismatch",
  "text_requester_existing_issue_unpinned",
  "text_registry_stale",
  "github_timeout",
  "github_immutable_conflict",
  "github_commit_outcome_unknown",
  "github_created_tree_mismatch",
  "github_created_commit_mismatch",
  "transport_signature_invalid",
  "archive_root_identity_changed",
  "archive_content_hash_mismatch",
  "archive_path_not_owned",
  "text_approval_expired",
  "text_dispatch_stopped",
]);
export async function sdkTextMain(args: string[]): Promise<number> {
  try {
    const result = await runSdkTextCli(args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const code =
      error instanceof Error && safeErrors.has(error.message)
        ? error.message
        : "sdk_text_operation_failed";
    process.stderr.write(
      `${JSON.stringify({ error: code, reexecute: false, nextAction: "Inspect the same request ID and persisted evidence; never reexecute unknown. Configure only the approved existing host/account route." })}\n`,
    );
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void sdkTextMain(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

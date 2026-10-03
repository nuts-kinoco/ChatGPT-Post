/** Loopback-only capability server. Static assets never include the per-launch token. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AntigravityMetadataHostPort,
  openAntigravityMetadataHost,
  unavailableMetadataView,
} from "../adapters/antigravity-metadata-host.js";
import type { AntigravityMetadataConfiguration } from "../adapters/antigravity-metadata-store.js";
import { openTrustedDeployment } from "../adapters/deployment-loader.js";
import type { ResidentWorkerLifecycle } from "../adapters/resident-worker.js";
import { ArchiveError } from "../archive/types.js";
import { parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";
import {
  type UiAck,
  type UiBinding,
  type UiDemoOutcome,
  type UiDemoTask,
  UiError,
  type UiErrorEnvelope,
  type UiImport,
  validateUiBody,
} from "../contracts/ui.js";
import { archiveOperationsSource, UiArchiveApi, type UiArchivePort } from "./archive-api.js";
import { UiComposer, type UiComposerPort } from "./composer.js";
import { buildUiOperationsSources, type UiOperationsFactory } from "./deployment-operations.js";
import {
  type NotificationPreferencesStore,
  openNotificationPreferencesStore,
} from "./notification-preferences.js";
import { type NotificationCataloguePort, UiNotificationSettings } from "./notification-settings.js";
import { UiOperationsService } from "./operations.js";
import { openPresentationStore, type PresentationStore } from "./presentation.js";
import type { ProObservationStore } from "./pro-counter.js";
import { UiProCounterSettings } from "./pro-counter-settings.js";
import { UiProjectSettings } from "./project-settings.js";
import { openUiService, type TaskUiService, type UiServiceOptions } from "./service.js";

export const MAX_UI_BODY_BYTES = 2 * 1024 * 1024;
export interface UiServerOptions extends UiServiceOptions {
  port?: number;
  antigravityMetadata?: AntigravityMetadataConfiguration;
  deploymentModule?: string;
  publicDir?: string;
  /** Trusted Electron host capability; never accepted from an HTTP body. */
  nativeControls?: boolean;
  /** Trusted deployment read/action ports. Never accepted from request JSON. */
  operationsSources?: UiOperationsFactory;
  composer?: UiComposerPort;
  archiveOperations?: UiArchivePort;
  proCounter?: ProObservationStore;
  notificationPreferences?: NotificationPreferencesStore;
  notificationCatalogue?: NotificationCataloguePort;
}
export interface UiServerHandle {
  server: Server;
  origin: string;
  url: string;
  token: string;
  service: TaskUiService;
  operations: UiOperationsService;
  presentation: PresentationStore;
  close(): Promise<void>;
}
const ASSETS: Record<string, { name: string; type: string }> = {
  "/": { name: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
  "/provider-catalog-view.js": {
    name: "provider-catalog-view.js",
    type: "text/javascript; charset=utf-8",
  },
  "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
  "/notification-view.js": { name: "notification-view.js", type: "text/javascript; charset=utf-8" },
  "/pro-counter-view.js": { name: "pro-counter-view.js", type: "text/javascript; charset=utf-8" },
  "/archive-view.js": { name: "archive-view.js", type: "text/javascript; charset=utf-8" },
  "/composer-view.js": { name: "composer-view.js", type: "text/javascript; charset=utf-8" },
  "/operations-view.js": { name: "operations-view.js", type: "text/javascript; charset=utf-8" },
  "/presentation.js": { name: "presentation.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { name: "styles.css", type: "text/css; charset=utf-8" },
};
function secureHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  );
}
function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}
function safeError(error: unknown): UiError {
  if (error instanceof UiError) return error;
  if (error instanceof ArchiveError)
    return new UiError(
      error.code,
      "Archive operation stopped safely; preserve the request and inspect storage",
      409,
    );
  const code = error instanceof Error ? error.message.split(":")[0] : "";
  const known = new Set([
    "request_id_conflict",
    "fixture_not_executable",
    "approval_required",
    "approval_state_invalid",
    "approval_stale_or_mismatched",
    "approval_policy_binding_mismatch",
    "session_resume_denied",
    "session_paused",
    "session_limit",
    "session_stopped",
    "session_unknown_pause",
    "session_limit_or_stopped",
    "worktree_write_locked",
    "approval_consumed",
    "approval_missing",
    "start_already_claimed",
    "write_lock_busy",
    "resource_locked",
    "stale_observation",
    "delivery_not_terminal",
    "delivery_identity_mismatch",
    "demo_scope_denied",
    "demo_observation_lost_after_restart",
    "demo_run_not_running",
    "policy_expired_or_revoked",
    "repo_or_policy_denied",
    "base_commit_mismatch",
    "agent_model_denied",
    "mode_denied",
    "sandbox_capability_unavailable",
    "quota_observation_or_authorization_required",
  ]);
  if (code && known.has(code))
    return new UiError(
      code,
      `Operation stopped safely (${code}); inspect the current task before continuing`,
      409,
    );
  return new UiError(
    "operation_failed",
    "Operation could not be completed safely; no automatic reexecution was requested",
    500,
  );
}
function errorEnvelope(error: UiError): UiErrorEnvelope {
  return {
    error: { code: error.code, message: error.message, retryable: false, reexecute: false },
  };
}
function singleHeader(request: IncomingMessage, name: string): boolean {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]?.toLowerCase() === name) count++;
  return count <= 1;
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? ""))
    throw new UiError("content_type_required", "Use application/json for API request bodies", 415);
  const length = request.headers["content-length"];
  if (length && Number(length) > MAX_UI_BODY_BYTES)
    throw new UiError("body_too_large", "Request body exceeds the local UI limit", 413);
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    request.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_UI_BODY_BYTES) {
        failed = true;
        chunks.length = 0;
        reject(new UiError("body_too_large", "Request body exceeds the local UI limit", 413));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    request.on("error", () =>
      reject(new UiError("request_interrupted", "Request body was interrupted")),
    );
    request.on("aborted", () =>
      reject(new UiError("request_interrupted", "Request body was interrupted")),
    );
  });
  try {
    return parseStrictJsonBytes(bytes);
  } catch {
    throw new UiError(
      "invalid_json",
      "Request must contain strict UTF-8 JSON without duplicate keys",
    );
  }
}
export async function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new UiError("invalid_port", "Port must be an integer between 0 and 65535");
  if (options.deploymentModule && (options.runtime || options.profile === "demo"))
    throw new Error("deployment_profile_conflict");
  const deployment = options.deploymentModule
    ? await openTrustedDeployment<{
        antigravityMetadata?: AntigravityMetadataConfiguration;
        uiRuntime?: import("./service.js").UiRuntime;
        uiOperationsSources?: UiOperationsFactory;
        uiComposer?: UiComposerPort;
        archiveOperations?: UiArchivePort;
        proCounter?: ProObservationStore;
        notificationPreferences?: NotificationPreferencesStore;
        notificationCatalogue?: NotificationCataloguePort;
        /** Explicit trusted opt-in; no HTTP request or browser preference can enable this worker. */
        residentWorker?: Pick<ResidentWorkerLifecycle, "start" | "close">;
        close?(): Promise<void> | void;
      }>(options.deploymentModule)
    : null;
  if (deployment && !deployment.uiRuntime) {
    await deployment.close?.();
    throw new Error("deployment_ui_runtime_missing");
  }
  if (options.antigravityMetadata && deployment?.antigravityMetadata) {
    await deployment.close?.();
    throw new Error("deployment_metadata_configuration_conflict");
  }
  const metadataConfig = options.antigravityMetadata ?? deployment?.antigravityMetadata;
  let metadataHost: AntigravityMetadataHostPort | null = null;
  let metadataUnavailable = unavailableMetadataView(
    options.profile === "demo"
      ? "demo_disabled"
      : metadataConfig && !metadataConfig.enabled
        ? "disabled"
        : "unconfigured",
  );
  const metadataView = () => metadataHost?.view() ?? metadataUnavailable;
  let service: TaskUiService;
  try {
    service = await openUiService(
      deployment?.uiRuntime ? { ...options, runtime: deployment.uiRuntime } : options,
    );
  } catch (error) {
    if (deployment?.close) await deployment.close();
    else deployment?.uiRuntime?.store.close();
    throw error;
  }
  const closeRuntime = async () => {
    if (deployment?.close) await deployment.close();
    else service.close();
  };
  let presentation: PresentationStore;
  try {
    presentation = await openPresentationStore(options.stateDir);
  } catch (error) {
    await closeRuntime();
    throw error;
  }
  const presentationView = () => ({
    ...service.metadata(),
    presentation: presentation.snapshot(),
    nativeControls: {
      available: options.nativeControls === true,
      reason:
        options.nativeControls === true
          ? "Desktop window controls are available"
          : "Desktop window controls require the Bridge desktop app",
    },
  });

  let operations: UiOperationsService;
  let archiveApi: UiArchiveApi;
  const archivePort = options.archiveOperations ?? deployment?.archiveOperations;
  try {
    const sourceFactory = options.operationsSources ?? deployment?.uiOperationsSources;
    const sources =
      typeof sourceFactory === "function" ? await sourceFactory(service) : sourceFactory;
    operations = new UiOperationsService(
      buildUiOperationsSources(service, {
        ...sources,
        ...(!sources?.archive && archivePort
          ? {
              archive: archiveOperationsSource(archivePort, (binding) =>
                archiveApi.collect({ version: "bridge-operations-1", binding }),
              ),
            }
          : {}),
      }),
    );
    service.bindProjectRegistry(operations.sources.registry);
  } catch (error) {
    try {
      await closeRuntime();
    } finally {
      presentation.close();
    }
    throw error;
  }
  const projectSettings = new UiProjectSettings(operations.sources.registry);
  const composer = new UiComposer(operations, options.composer ?? deployment?.uiComposer);
  archiveApi = new UiArchiveApi(operations, archivePort);
  const counterStore = options.proCounter ?? deployment?.proCounter;
  if (counterStore && counterStore.synthetic !== (service.profile === "demo")) {
    try {
      await closeRuntime();
    } finally {
      presentation.close();
    }
    throw new UiError("counter_profile_mismatch", "Counter and task profiles must match", 500);
  }
  const proCounterSettings = new UiProCounterSettings(counterStore);
  let notificationStore = options.notificationPreferences ?? deployment?.notificationPreferences;
  let ownNotificationStore = false;
  let storageUnavailableReason:
    | "notification_storage_verifier_unavailable"
    | "notification_storage_untrusted"
    | "notification_storage_unavailable"
    | undefined;
  if (!notificationStore)
    try {
      notificationStore = await openNotificationPreferencesStore({
        stateDir: options.stateDir,
        profile: service.profile,
      });
      ownNotificationStore = true;
    } catch (error) {
      storageUnavailableReason =
        error instanceof UiError && error.code === "notification_storage_verifier_unavailable"
          ? "notification_storage_verifier_unavailable"
          : error instanceof UiError && error.code === "notification_storage_untrusted"
            ? "notification_storage_untrusted"
            : "notification_storage_unavailable";
    }
  const catalogue = options.notificationCatalogue ?? deployment?.notificationCatalogue;
  let notifications: UiNotificationSettings;
  try {
    notifications = new UiNotificationSettings({
      ...(notificationStore ? { store: notificationStore } : {}),
      authenticatedActorId: service.authenticatedRequesterId,
      profile: service.profile,
      ...(catalogue ? { catalogue } : {}),
      ...(storageUnavailableReason ? { storageUnavailableReason } : {}),
    });
  } catch (error) {
    try {
      await closeRuntime();
    } finally {
      presentation.close();
      if (ownNotificationStore) notificationStore?.close();
    }
    throw error;
  }
  const closeCosmetics = () => {
    presentation.close();
    if (ownNotificationStore) notificationStore?.close();
  };
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const publicDir = options.publicDir ?? fileURLToPath(new URL("./public/", import.meta.url));
  let shutdownStarted = false;
  let origin = "";
  let host = "";
  const server = createServer(async (request, response) => {
    secureHeaders(response);
    try {
      if (!singleHeader(request, "host") || request.headers.host !== host)
        throw new UiError("host_denied", "Only the exact loopback host is accepted", 403);
      if (
        !singleHeader(request, "origin") ||
        (request.headers.origin !== undefined && request.headers.origin !== origin)
      )
        throw new UiError("origin_denied", "Cross-origin requests are not accepted", 403);
      const site = request.headers["sec-fetch-site"];
      if (site !== undefined && site !== "same-origin" && site !== "none")
        throw new UiError("cross_site_denied", "Cross-site requests are not accepted", 403);
      const suppliedUrl = request.url ?? "/";
      if (
        !suppliedUrl.startsWith("/") ||
        suppliedUrl.startsWith("//") ||
        suppliedUrl.includes("#") ||
        suppliedUrl.includes("%") ||
        suppliedUrl.includes("\\")
      )
        throw new UiError("route_not_found", "Route not found", 404);
      const [rawUrl = "/", query] = suppliedUrl.split("?");
      if (query !== undefined) {
        const params = new URLSearchParams(query);
        const allowed: Record<string, RegExp> = {
          view: /^(dock|detail|resident)$/,
          tab: /^(approval|payload|evidence|recovery)$/,
          task: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
        };
        if (
          rawUrl !== "/" ||
          suppliedUrl.split("?").length !== 2 ||
          !params.has("view") ||
          [...params].some(
            ([key, value]) =>
              !Object.hasOwn(allowed, key) ||
              !allowed[key]?.test(value) ||
              params.getAll(key).length !== 1,
          )
        )
          throw new UiError("route_not_found", "Route not found", 404);
      }
      if (rawUrl === "/api" || rawUrl.startsWith("/api/")) {
        const supplied = Buffer.from(request.headers.authorization ?? "");
        if (
          !singleHeader(request, "authorization") ||
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        )
          throw new UiError(
            "authentication_required",
            "A per-launch local capability token is required",
            401,
          );
        const method = request.method;
        if (method !== "GET" && method !== "POST")
          throw new UiError("method_not_allowed", "Only GET and POST are supported", 405);
        if (method === "GET") {
          if (rawUrl === "/api/provider-catalog")
            return sendJson(response, { ...service.metadata(), metadata: metadataView() });
          if (rawUrl === "/api/settings/notifications")
            return sendJson(response, {
              ...service.metadata(),
              notifications: await notifications.view(),
            });
          if (rawUrl === "/api/settings/pro-counter")
            return sendJson(response, {
              ...service.metadata(),
              proCounter: proCounterSettings.view(),
            });
          if (rawUrl === "/api/archive")
            return sendJson(response, {
              ...service.metadata(),
              capability: archiveApi.capability(),
            });
          if (rawUrl === "/api/composer")
            return sendJson(response, { ...service.metadata(), capability: composer.capability() });
          if (rawUrl === "/api/settings/projects")
            return sendJson(response, { ...service.metadata(), settings: projectSettings.view() });
          if (rawUrl === "/api/setup")
            return sendJson(response, { ...service.metadata(), setup: await operations.setup() });
          if (rawUrl === "/api/operations")
            return sendJson(response, {
              ...service.metadata(),
              operations: await operations.overview(),
            });
          const operationMatch =
            /^\/api\/operations\/(local_execution|hosted_delivery|fanout)\/([a-f0-9-]{36})$/.exec(
              rawUrl,
            );
          if (operationMatch?.[1] && operationMatch[2])
            return sendJson(response, {
              ...service.metadata(),
              operation: await operations.detail(
                operationMatch[1] as "local_execution" | "hosted_delivery" | "fanout",
                operationMatch[2],
              ),
            });
          if (rawUrl === "/api/presentation") return sendJson(response, presentationView());
          const bootstrapPageMatch = /^\/api\/bootstrap\/page(?:\/([a-f0-9-]{36}))?$/.exec(rawUrl);
          if (bootstrapPageMatch)
            return sendJson(response, service.bootstrapPage(bootstrapPageMatch[1] ?? ""));
          const legacyArchive = /^\/api\/legacy\/archive\/([a-f0-9-]{36})$/.exec(rawUrl);
          if (legacyArchive?.[1]) {
            service.task(legacyArchive[1]);
            return sendJson(response, service.inspectArchive(legacyArchive[1]));
          }
          if (rawUrl === "/api/bootstrap") return sendJson(response, service.bootstrap());
          if (rawUrl === "/api/tasks")
            return sendJson(response, { ...service.metadata(), tasks: service.bootstrap().tasks });
          if (rawUrl === "/api/diagnostics")
            return sendJson(response, {
              ...service.metadata(),
              diagnostics: service.diagnostics(),
            });
          const match =
            /^\/api\/tasks\/([a-f0-9-]+)(?:\/(events|receipts|result|preflight))?$/.exec(rawUrl);
          if (match?.[1]) {
            const detail = service.task(match[1]);
            switch (match[2]) {
              case "events":
                return sendJson(response, { ...service.metadata(), events: detail.task.events });
              case "receipts":
                return sendJson(response, {
                  ...service.metadata(),
                  handshakes: detail.task.handshakes,
                  receipt: detail.task.result.receipt,
                  approvals: detail.task.approvals,
                });
              case "result":
                return sendJson(response, {
                  ...service.metadata(),
                  result: JSON.parse(service.resultPayload(match[1])) as unknown,
                  payloadSha256: detail.task.delivery.payloadSha256,
                });
              case "preflight":
                return sendJson(response, {
                  ...service.metadata(),
                  preflight: detail.task.preflight,
                });
              default:
                return sendJson(response, detail);
            }
          }
        } else {
          const input = await body(request);
          if (shutdownStarted) {
            response.setHeader("connection", "close");
            throw new UiError(
              "runtime_shutting_down",
              "New mutations are disabled during shutdown",
              409,
            );
          }
          if (rawUrl === "/api/provider-catalog/refresh") {
            if (
              !input ||
              typeof input !== "object" ||
              Array.isArray(input) ||
              Object.keys(input).join() !== "version" ||
              (input as { version?: unknown }).version !== "bridge-antigravity-metadata-host-1"
            )
              throw new UiError(
                "metadata_refresh_invalid",
                "Use the fixed metadata refresh request",
              );
            return sendJson(response, {
              ...service.metadata(),
              metadata: metadataHost ? await metadataHost.refresh() : metadataView(),
            });
          }
          if (rawUrl === "/api/settings/notifications")
            return sendJson(response, {
              ...service.metadata(),
              notifications: await notifications.update(input),
            });
          if (rawUrl === "/api/settings/pro-counter")
            return sendJson(response, {
              ...service.metadata(),
              proCounter: proCounterSettings.update(input),
            });
          if (rawUrl === "/api/archive/collect")
            return sendJson(response, {
              ...service.metadata(),
              archive: await archiveApi.collect(input),
            });
          if (rawUrl === "/api/archive/inspect")
            return sendJson(response, {
              ...service.metadata(),
              archive: await archiveApi.inspect(input),
            });
          if (rawUrl === "/api/archive/export")
            return sendJson(response, {
              ...service.metadata(),
              diagnostic: await archiveApi.export(input),
            });
          if (rawUrl === "/api/archive/probe")
            return sendJson(response, {
              ...service.metadata(),
              probe: await archiveApi.probe(input),
            });
          if (rawUrl === "/api/composer/preview") {
            const preview = await composer.preview(input);
            return sendJson(response, {
              ...service.metadata(),
              preview,
              previewSha256: sha256Bytes(Buffer.from(JSON.stringify(preview))),
            });
          }
          if (rawUrl === "/api/composer/issue")
            return sendJson(response, {
              ...service.metadata(),
              issued: await composer.issue(input),
            });
          if (rawUrl === "/api/settings/projects")
            return sendJson(response, {
              ...service.metadata(),
              settings: projectSettings.update(input),
            });
          if (rawUrl === "/api/operations/query") {
            if (
              !input ||
              typeof input !== "object" ||
              Array.isArray(input) ||
              Object.keys(input).some(
                (key) => !["limit", "localAfter", "hostedAfter", "fanoutAfter"].includes(key),
              )
            )
              throw new UiError(
                "invalid_operations_query",
                "Only bounded page parameters are accepted",
              );
            return sendJson(response, {
              ...service.metadata(),
              operations: await operations.overview(input),
            });
          }
          if (rawUrl === "/api/operations/actions")
            return sendJson(response, {
              ...service.metadata(),
              operation: await operations.mutate(input),
            });
          if (rawUrl === "/api/presentation") {
            presentation.update(input, options.nativeControls === true);
            return sendJson(response, presentationView());
          }
          if (rawUrl === "/api/validate" || rawUrl === "/api/tasks") {
            validateUiBody("import", input);
            return sendJson(
              response,
              rawUrl === "/api/validate"
                ? service.validate(input as UiImport)
                : service.import(input as UiImport),
              rawUrl === "/api/tasks" ? 201 : 200,
            );
          }
          if (rawUrl === "/api/demo/tasks") {
            validateUiBody("demo", input);
            return sendJson(response, service.createDemo(input as UiDemoTask), 201);
          }
          const match =
            /^\/api\/tasks\/([a-f0-9-]+)\/(approve|start|cancel|reconcile|ack|demo-observation)$/.exec(
              rawUrl,
            );
          if (match?.[1]) {
            const id = match[1];
            switch (match[2]) {
              case "approve":
                validateUiBody("bound", input);
                return sendJson(response, await service.approve(id, input as UiBinding));
              case "start":
                validateUiBody("bound", input);
                return sendJson(response, await service.start(id, input as UiBinding));
              case "cancel":
                validateUiBody("empty", input);
                return sendJson(response, await service.cancel(id));
              case "reconcile":
                validateUiBody("empty", input);
                return sendJson(response, await service.reconcile(id));
              case "ack":
                validateUiBody("ack", input);
                return sendJson(response, await service.acknowledge(id, input as UiAck));
              case "demo-observation":
                validateUiBody("observation", input);
                return sendJson(
                  response,
                  await service.demoObservation(id, (input as { outcome: UiDemoOutcome }).outcome),
                );
            }
          }
        }
        throw new UiError("route_not_found", "API route not found", 404);
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        throw new UiError("method_not_allowed", "Static assets support GET and HEAD only", 405);
      const asset = Object.hasOwn(ASSETS, rawUrl) ? ASSETS[rawUrl] : undefined;
      if (!asset) throw new UiError("route_not_found", "Asset not found", 404);
      let content: Buffer;
      try {
        content = await readFile(join(publicDir, asset.name));
      } catch {
        throw new UiError(
          "asset_unavailable",
          "The UI asset is unavailable; build or restore the packaged UI assets",
          503,
        );
      }
      response.setHeader("Content-Type", asset.type);
      response.setHeader("Content-Length", content.byteLength);
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      const safe = safeError(error);
      if (!response.headersSent) {
        if (safe.status === 413) response.setHeader("Connection", "close");
        sendJson(response, errorEnvelope(safe), safe.status);
      } else response.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback_bind_failed");
    host = `127.0.0.1:${address.port}`;
    origin = `http://${host}`;
    if (options.profile !== "demo" && metadataConfig?.enabled) {
      try {
        metadataHost = await openAntigravityMetadataHost(metadataConfig, options.stateDir);
        metadataHost.start();
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        const reason = new Set([
          "metadata_context_changed",
          "metadata_ownership_unknown",
          "metadata_platform_unsupported",
          "metadata_storage_invalid",
          "metadata_storage_untrusted",
          "metadata_configuration_invalid",
        ]).has(code)
          ? code.replace(/^metadata_/, "")
          : "storage_unavailable";
        metadataUnavailable = unavailableMetadataView(reason);
      }
    }
    deployment?.residentWorker?.start();
  } catch (error) {
    server.close();
    try {
      await (metadataHost as AntigravityMetadataHostPort | null)?.close();
      await deployment?.residentWorker?.close();
      await closeRuntime();
    } finally {
      closeCosmetics();
    }
    throw error;
  }
  let closed = false;
  let closing: Promise<void> | null = null;
  let httpClosed: Promise<void> | null = null;
  const stopHttp = () => {
    httpClosed ??= new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections();
    });
    return httpClosed;
  };
  return {
    server,
    origin,
    url: `${origin}/#token=${token}`,
    token,
    service,
    operations,
    presentation,
    close: async () => {
      if (closed) return;
      if (closing) return closing;
      shutdownStarted = true;
      metadataHost?.beginShutdown();
      service.beginShutdown();
      operations.beginShutdown();
      closing = (async () => {
        const drainedHttp = stopHttp();
        // Keep stores open if either owned worker or outstanding API handlers cannot drain.
        // The same pending HTTP close is awaited again on an explicit shutdown retry.
        await metadataHost?.close();
        await deployment?.residentWorker?.close();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            drainedHttp,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new UiError(
                      "ui_shutdown_pending",
                      "Outstanding requests have not finished; runtime stores remain open",
                      409,
                    ),
                  ),
                5000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        await closeRuntime();
        closeCosmetics();
        closed = true;
      })();
      try {
        await closing;
      } finally {
        closing = null;
      }
    },
  };
}

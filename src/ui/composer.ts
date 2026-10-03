/** Explicit manual convenience over registered host recipes and existing transport issue. No grants. */
import { randomUUID } from "node:crypto";
import type { RegisteredOperationDestination } from "../contracts/operations.js";
import type { HostedExpectedOutputPolicy } from "../contracts/output-contract.js";
import type { ProjectRegistration } from "../contracts/project-registry.js";
import { loadTaskSpec, sha256Bytes, verifyTaskFileBytes } from "../contracts/task.js";
import type { TaskSpec } from "../contracts/task-types.js";
import { UiError } from "../contracts/ui.js";
import { encodeTaskBrief } from "../prompt-rendering/brief.js";
import { prepareHostedPromptPreview } from "../prompt-rendering/hosted-renderer.js";
import type { UiOperationsService } from "./operations.js";
import {
  type ComposerPromptFormat,
  type ComposerPromptFormatResolver,
  readComposerPromptFormat,
} from "./prompt-format.js";
export interface ComposerRecipeInput {
  requestId: string;
  project: ProjectRegistration;
  destination: RegisteredOperationDestination;
  modelId: string;
  title: string;
  instruction: string;
  /** Exact codec bytes, prepared before the recipe hashes the original task file. */
  taskMarkdown?: string;
}
export interface ComposerChild {
  destinationId: string;
  recipientActorId: string;
  route: RegisteredOperationDestination["route"];
  requestId: string;
  taskSpecHash: string;
  taskFileHash: string;
  rawSpec: string;
  taskMarkdown: string;
  outputPolicy?: HostedExpectedOutputPolicy | null;
  promptFormat?: ComposerPromptFormat;
  promptPreview?: ReturnType<typeof prepareHostedPromptPreview>;
}
export interface UiComposerPort {
  /** Trusted deployment registry only. Request JSON cannot supply a renderer or profile. */
  promptFormat?: ComposerPromptFormatResolver;
  prepareTimeoutMs?: number;
  /** A trusted deployment template supplies policy, base commit, evaluators, and bounds. */
  prepare(input: ComposerRecipeInput):
    | Promise<{
        rawSpec: string;
        taskMarkdown: string;
        outputPolicy?: HostedExpectedOutputPolicy | null;
      }>
    | { rawSpec: string; taskMarkdown: string; outputPolicy?: HostedExpectedOutputPolicy | null };
  /** Must atomically issue these exact immutable UUIDs/bytes through existing bus/fanout authority. */
  issue(
    preview: {
      fanoutId: string | null;
      registryRevision: number;
      registrySha256: string;
      projectId: string;
      children: readonly ComposerChild[];
    },
    finalAppendGuard?: () => void,
    issuerPreparation?: Uint8Array,
  ): Promise<{ commit: string }>;
}
export interface ComposerPreview {
  version: "bridge-composer-preview-1" | "bridge-composer-preview-2";
  previewId: string;
  fanoutId: string | null;
  registryRevision: number;
  registrySha256: string;
  projectId: string;
  expiresAt: string;
  children: ComposerChild[];
}
export interface PreparedComposerPreview {
  preview: ComposerPreview;
  catalogue: string[];
  promptFormats: string[];
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys.sort().join()
  )
    throw new UiError("composer_input_invalid", "Composer input fields are invalid");
  return value as Record<string, unknown>;
}
export function destinationFingerprint(destination: RegisteredOperationDestination): string {
  return sha256Bytes(
    Buffer.from(
      JSON.stringify({
        destinationId: destination.destinationId,
        route: destination.route,
        recipientActorId: destination.recipientActorId,
        providerId: destination.providerId,
        modelIds: destination.modelIds,
        policyHash: destination.policyHash,
      }),
    ),
  );
}
/** One bounded shared recipe path. Late pure results cannot cache or issue a request. */
export async function prepareTaskRecipe(port: UiComposerPort, input: ComposerRecipeInput) {
  const timeoutMs = port.prepareTimeoutMs === undefined ? 1000 : port.prepareTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
    throw new UiError(
      "composer_recipe_timeout_invalid",
      "Pure recipe deadline must be between 1 and 5000 milliseconds",
      500,
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => port.prepare(input)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new UiError(
                "composer_recipe_timeout",
                "Trusted recipe deadline expired; no request was issued",
                504,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export function validatePreparedRecipe(
  prepared: { rawSpec: string; taskMarkdown: string },
  input: ComposerRecipeInput,
) {
  const parsed = loadTaskSpec(Buffer.from(prepared.rawSpec));
  if (
    !parsed.valid ||
    !verifyTaskFileBytes(parsed.task, Buffer.from(prepared.taskMarkdown)).valid ||
    parsed.task.request_id !== input.requestId ||
    parsed.task.repo !== input.project.repoId ||
    parsed.task.agent !== input.destination.providerId ||
    parsed.task.requested_model !== input.modelId ||
    parsed.task.policy_snapshot_sha256 !== input.destination.policyHash ||
    parsed.task.mode === "design_fixture" ||
    (input.taskMarkdown !== undefined && prepared.taskMarkdown !== input.taskMarkdown)
  )
    throw new UiError(
      "composer_recipe_invalid",
      "Trusted recipe did not produce the exact registered agent, route destination and task contract",
      409,
    );
  return parsed.task;
}
export class UiComposer {
  private readonly previews = new Map<
    string,
    {
      preview: ComposerPreview;
      catalogue: string[];
      promptFormats: string[];
      pending: boolean;
      receipt: { commit: string } | null;
    }
  >();
  constructor(
    private readonly operations: UiOperationsService,
    private readonly port: UiComposerPort | undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly identities?: {
      previewId: string;
      requestIds: readonly string[];
      fanoutId: string | null;
    },
  ) {}
  capability() {
    return {
      enabled:
        !!this.port && !!this.operations.sources.registry && !!this.operations.sources.destinations,
      reason: this.port
        ? "Registered project, destination and trusted recipe are required"
        : "Trusted task recipe and issue transport are not configured",
    };
  }
  /** Metadata-only route. Does not call the recipe, allocate UUIDs or prepare dispatch bytes. */
  async promptFormats() {
    const version = "bridge-composer-prompt-formats-1" as const;
    if (!this.port?.promptFormat) return { version, formats: [] };
    const setup = await this.operations.setup();
    const formats = [];
    if (setup.destinations.state === "available")
      for (const destination of setup.destinations.value) {
        if (destination.unavailableReason) continue;
        for (const modelId of destination.modelIds) {
          const format = readComposerPromptFormat(this.port.promptFormat, destination, modelId);
          formats.push({
            destinationId: destination.destinationId,
            modelId,
            promptFormat: format.metadata,
          });
        }
      }
    return { version, formats };
  }
  async preview(input: unknown): Promise<ComposerPreview> {
    if (!this.port || !this.capability().enabled)
      throw new UiError("composer_unconfigured", "Trusted composer is unavailable", 409);
    const mode =
      input && typeof input === "object" ? (input as { mode?: unknown }).mode : undefined;
    const briefMode = mode === "bridge-task-brief-1";
    if (mode !== undefined && mode !== "legacy-verbatim" && !briefMode)
      throw new UiError("composer_input_invalid", "Unknown composer task-file mode");
    const body = exact(input, [
      "registryRevision",
      "projectId",
      "destinations",
      "title",
      "instruction",
      ...(mode === undefined ? [] : ["mode"]),
      ...(briefMode ? ["taskKind", "constraints", "deliverables", "acceptance"] : []),
    ]);
    if (
      !Number.isSafeInteger(body.registryRevision) ||
      typeof body.projectId !== "string" ||
      !UUID.test(body.projectId) ||
      typeof body.title !== "string" ||
      body.title.trim().length < 1 ||
      body.title.length > 120 ||
      /[\r\n]/.test(body.title) ||
      typeof body.instruction !== "string" ||
      body.instruction.trim().length < 1 ||
      Buffer.byteLength(body.instruction) > 512 * 1024 ||
      !Array.isArray(body.destinations) ||
      body.destinations.length < 1 ||
      body.destinations.length > 4
    )
      throw new UiError(
        "composer_input_invalid",
        "Project, bounded text and one to four registered destinations are required",
      );
    let taskMarkdown: string | undefined;
    if (briefMode) {
      try {
        taskMarkdown = Buffer.from(
          encodeTaskBrief({
            taskKind: body.taskKind,
            objective: `# ${body.title}\n\n${body.instruction}`,
            constraints: body.constraints,
            deliverables: body.deliverables,
            acceptance: body.acceptance,
            context: [],
          }),
        ).toString("utf8");
      } catch {
        throw new UiError("composer_brief_invalid", "Common brief fields are invalid or too large");
      }
    }
    const registry = this.operations.sources.registry;
    if (!registry || registry.currentRevision() !== body.registryRevision)
      throw new UiError(
        "composer_registry_stale",
        "Project registration changed; refresh before creating a draft",
        409,
      );
    const snapshot = registry.snapshot(Number(body.registryRevision));
    const project = snapshot.projects.find((p) => p.projectId === body.projectId);
    if (!project) throw new UiError("composer_project_missing", "Project is not registered", 409);
    const setup = await this.operations.setup();
    if (setup.destinations.state !== "available")
      throw new UiError(
        "composer_destinations_unavailable",
        "Destination catalogue is unavailable",
        409,
      );
    const selected: { destination: RegisteredOperationDestination; modelId: string }[] = [];
    const seen = new Set<string>();
    for (const item of body.destinations) {
      const value = exact(item, ["destinationId", "modelId"]);
      const destination = setup.destinations.value.find(
        (d) => d.destinationId === value.destinationId,
      );
      if (
        !destination ||
        destination.unavailableReason ||
        typeof value.modelId !== "string" ||
        !destination.modelIds.includes(value.modelId) ||
        seen.has(destination.destinationId)
      )
        throw new UiError(
          "composer_destination_denied",
          "Destination or model is not available from the trusted catalogue",
          409,
        );
      seen.add(destination.destinationId);
      selected.push({ destination, modelId: value.modelId });
    }
    if (this.identities) {
      const ids = [
        this.identities.previewId,
        ...this.identities.requestIds,
        ...(this.identities.fanoutId ? [this.identities.fanoutId] : []),
      ];
      if (
        this.identities.requestIds.length !== selected.length ||
        selected.length > 1 !== (this.identities.fanoutId !== null) ||
        ids.some((id) => !UUID.test(id)) ||
        new Set(ids).size !== ids.length
      )
        throw new UiError("composer_identity_invalid", "Host preparation identities are invalid");
    }
    const children: ComposerChild[] = [];
    const promptFormats: string[] = [];
    for (const { destination, modelId } of selected) {
      const format = readComposerPromptFormat(this.port.promptFormat, destination, modelId);
      if (briefMode !== !!format.renderer)
        throw new UiError(
          "composer_prompt_format_unsupported",
          briefMode
            ? "Common brief requires an exact registered production prompt profile"
            : "This destination requires explicit common-brief mode",
          409,
        );
      const requestId = this.identities?.requestIds[children.length] ?? randomUUID();
      const recipeInput: ComposerRecipeInput = {
        requestId,
        project,
        destination,
        modelId,
        title: body.title,
        instruction: body.instruction,
        ...(taskMarkdown === undefined ? {} : { taskMarkdown }),
      };
      const raw = await prepareTaskRecipe(this.port, structuredClone(recipeInput));
      validatePreparedRecipe(raw, recipeInput);
      const afterFormat = readComposerPromptFormat(this.port.promptFormat, destination, modelId);
      if (afterFormat.fingerprint !== format.fingerprint)
        throw new UiError(
          "composer_prompt_format_stale",
          "Prompt registration changed during preview",
          409,
        );
      promptFormats.push(format.fingerprint);
      children.push({
        destinationId: destination.destinationId,
        recipientActorId: destination.recipientActorId,
        route: destination.route,
        requestId,
        taskSpecHash: sha256Bytes(Buffer.from(raw.rawSpec)),
        taskFileHash: sha256Bytes(Buffer.from(raw.taskMarkdown)),
        ...raw,
        ...(format.renderer
          ? {
              promptFormat: format.metadata,
              promptPreview: prepareHostedPromptPreview({
                renderer: format.renderer,
                rawTaskSpec: Buffer.from(raw.rawSpec),
                taskFileBytes: Buffer.from(raw.taskMarkdown),
                policySnapshotSha256: destination.policyHash,
              }),
            }
          : {}),
      });
    }
    if (registry.currentRevision() !== body.registryRevision)
      throw new UiError(
        "composer_registry_stale",
        "Registration changed while preparing the preview",
        409,
      );
    const preview: ComposerPreview = {
      version: briefMode ? "bridge-composer-preview-2" : "bridge-composer-preview-1",
      previewId: this.identities?.previewId ?? randomUUID(),
      fanoutId: this.identities
        ? this.identities.fanoutId
        : children.length > 1
          ? randomUUID()
          : null,
      registryRevision: Number(body.registryRevision),
      registrySha256: registry.snapshotHash(Number(body.registryRevision)),
      projectId: body.projectId,
      expiresAt: new Date(this.now().getTime() + 300000).toISOString(),
      children,
    };
    for (const [id, entry] of this.previews)
      if (!entry.pending && Date.parse(entry.preview.expiresAt) < this.now().getTime())
        this.previews.delete(id);
    if (this.previews.size >= 64)
      throw new UiError(
        "composer_capacity",
        "Too many previews are retained; wait for expiry",
        409,
      );
    this.previews.set(preview.previewId, {
      preview,
      catalogue: selected.map((x) => destinationFingerprint(x.destination)),
      promptFormats,
      pending: false,
      receipt: null,
    });
    return structuredClone(preview);
  }
  /** Host-only export for a signed preparation receipt; HTTP cannot import or replace cached previews. */
  preparation(previewId: string, expectedHash: string): PreparedComposerPreview {
    const entry = this.previews.get(previewId);
    if (!entry || sha256Bytes(Buffer.from(JSON.stringify(entry.preview))) !== expectedHash)
      throw new UiError("composer_preview_mismatch", "Prepared preview was not found", 409);
    return structuredClone({
      preview: entry.preview,
      catalogue: entry.catalogue,
      promptFormats: entry.promptFormats,
    });
  }
  /** Shared validation for the original UI cache and authenticated immutable issuer receipts. */
  async validatePreparation(entry: PreparedComposerPreview): Promise<void> {
    if (!this.port)
      throw new UiError("composer_unconfigured", "Trusted composer is unavailable", 409);
    if (Date.parse(entry.preview.expiresAt) <= this.now().getTime())
      throw new UiError(
        "composer_preview_expired",
        "Preview expired. Inspect previous UUIDs before explicitly preparing a replacement",
        409,
      );
    const registry = this.operations.sources.registry;
    const setup = await this.operations.setup();
    if (
      !registry ||
      registry.currentRevision() !== entry.preview.registryRevision ||
      registry.snapshotHash(entry.preview.registryRevision) !== entry.preview.registrySha256 ||
      setup.destinations.state !== "available"
    )
      throw new UiError(
        "composer_registry_stale",
        "Registration or destination changed; create an explicit new preview",
        409,
      );
    const catalogue = setup.destinations.value;
    if (
      entry.preview.children.some((child, index) => {
        const current = catalogue.find((d) => d.destinationId === child.destinationId);
        return (
          !current ||
          !!current.unavailableReason ||
          destinationFingerprint(current) !== entry.catalogue[index]
        );
      })
    )
      throw new UiError(
        "composer_destination_stale",
        "Destination policy or model changed after preview",
        409,
      );
    for (const [index, child] of entry.preview.children.entries()) {
      const destination = catalogue.find((value) => value.destinationId === child.destinationId);
      const parsed = loadTaskSpec(Buffer.from(child.rawSpec));
      if (!destination || !parsed.valid)
        throw new UiError(
          "composer_prompt_format_stale",
          "Prompt registration is unavailable",
          409,
        );
      const current = readComposerPromptFormat(
        this.port.promptFormat,
        destination,
        parsed.task.requested_model,
      );
      if (current.fingerprint !== entry.promptFormats[index])
        throw new UiError(
          "composer_prompt_format_stale",
          "Prompt profile or renderer changed after preview",
          409,
        );
    }
  }
  async issue(input: unknown) {
    if (!this.port)
      throw new UiError("composer_unconfigured", "Issue transport is unavailable", 409);
    const body = exact(input, ["previewId", "previewSha256"]);
    const entry = this.previews.get(String(body.previewId));
    if (!entry || body.previewSha256 !== sha256Bytes(Buffer.from(JSON.stringify(entry.preview))))
      throw new UiError(
        "composer_preview_mismatch",
        "Preview identity/hash was not found. Inspect any previous request UUID before making another draft",
        409,
      );
    if (entry.receipt)
      return {
        ...entry.receipt,
        previewId: entry.preview.previewId,
        requestIds: entry.preview.children.map((x) => x.requestId),
      };
    if (entry.pending)
      throw new UiError(
        "composer_issue_pending",
        "This exact preview is already being issued; inspect its original UUIDs",
        409,
      );
    await this.validatePreparation(entry);
    // A second request may have crossed the asynchronous catalogue read above.
    const cached = this.previews.get(String(body.previewId))?.receipt;
    if (cached)
      return {
        ...cached,
        previewId: entry.preview.previewId,
        requestIds: entry.preview.children.map((x) => x.requestId),
      };
    if (entry.pending)
      throw new UiError(
        "composer_issue_pending",
        "This exact preview is already being issued; inspect its original UUIDs",
        409,
      );
    if (
      this.previews.get(String(body.previewId)) !== entry ||
      Date.parse(entry.preview.expiresAt) <= this.now().getTime()
    )
      throw new UiError(
        "composer_preview_expired",
        "Preview expired or was replaced during validation; no issue was sent",
        409,
      );
    entry.pending = true;
    try {
      const receipt = await this.port.issue(structuredClone(entry.preview));
      if (!/^[a-f0-9]{40}$/.test(receipt.commit)) throw new Error("invalid_issue_receipt");
      entry.receipt = receipt;
      return {
        ...receipt,
        previewId: entry.preview.previewId,
        requestIds: entry.preview.children.map((x) => x.requestId),
      };
    } catch {
      throw new UiError(
        "composer_issue_unconfirmed",
        "Issue may have reached transport. Inspect the original request UUIDs; never generate a retry automatically",
        409,
      );
    } finally {
      entry.pending = false;
    }
  }
}
/** A host-selected static manual template is metadata, not an approval envelope. */
export function manualTaskTemplate(
  template: TaskSpec,
): (input: ComposerRecipeInput) => { rawSpec: string; taskMarkdown: string } {
  if (template.approval.tier !== "manual" || template.approval.preauthorization !== null)
    throw new Error("manual_template_required");
  return (input) => {
    const taskMarkdown = input.taskMarkdown ?? `# ${input.title}\n\n${input.instruction}`;
    const task = {
      ...structuredClone(template),
      request_id: input.requestId,
      repo: input.project.repoId,
      requested_model: input.modelId,
      task_file_hash: sha256Bytes(Buffer.from(taskMarkdown)),
    };
    return { rawSpec: `${JSON.stringify(task, null, 2)}\n`, taskMarkdown };
  };
}

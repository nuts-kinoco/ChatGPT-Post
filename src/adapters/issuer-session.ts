/** Configured local-CLI issuer facade. Identity and scope are host ports, never request claims. */

import { isDeepStrictEqual } from "node:util";
import {
  assertCapabilityFresh,
  type IssuerPreparationV1,
  type IssuerSessionBindingV1,
  issuerRecord,
  issuerTime,
  MAX_ISSUER_RECORD_BYTES,
  parsePreparedComposer,
  type RecipientCapabilityV1,
  strictBase64,
  validateIssuerPreparation,
  validateIssuerSession,
  validateRecipientCapability,
} from "../contracts/issuer.js";
import type { MaterializationReceiptV1 } from "../contracts/materialization.js";
import type { RegisteredOperationDestination } from "../contracts/operations.js";
import { loadTaskSpec, parseStrictJsonBytes, sha256Bytes } from "../contracts/task.js";
import {
  destinationFingerprint,
  type PreparedComposerPreview,
  UiComposer,
  type UiComposerPort,
} from "../ui/composer.js";
import { composerTransportPort } from "../ui/composer-transport.js";
import { issuerReadPort } from "../ui/issuer-read-port.js";
import type { UiOperationsService } from "../ui/operations.js";
import { readComposerPromptFormat } from "../ui/prompt-format.js";
import type {
  DeliveryAcceptanceContext,
  GitHubTaskBus,
  SignedBusCodec,
} from "./github-transport.js";

export interface RecipientCapabilitySource {
  codec: SignedBusCodec;
  /** Synchronous cached observation; this must not probe, refresh quota, authenticate or dispatch. */
  current(): RecipientCapabilityV1;
}
export interface IssuerSessionOptions {
  bus: GitHubTaskBus;
  operations: UiOperationsService;
  recipe: UiComposerPort;
  session(): IssuerSessionBindingV1;
  /** Same host registrations as operations. Synchronous final-append revalidation, no I/O. */
  currentDestinations(): readonly RegisteredOperationDestination[];
  capabilities: readonly RecipientCapabilitySource[];
  materialize?(context: DeliveryAcceptanceContext): Promise<MaterializationReceiptV1>;
  now?: () => Date;
  maxCapabilityAgeMs?: number;
}
export interface IssuerFacade {
  catalogue(): Promise<unknown>;
  template(projectId: string, destinationId: string, modelId?: string): Promise<unknown>;
  prepare(input: unknown): Promise<{
    signedPreparationBase64: string;
    preparationSha256: string;
    prepared: PreparedComposerPreview;
  }>;
  issue(signedPreparation: Uint8Array): Promise<unknown>;
  result(signedPreparation: Uint8Array, requestId: string): Promise<unknown>;
  acknowledge(
    signedPreparation: Uint8Array,
    requestId: string,
    payloadSha256: string,
  ): Promise<unknown>;
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const digest = (value: unknown) => sha256Bytes(encode(value));
function bounded(value: unknown): Buffer {
  const b = encode(value);
  if (b.length > MAX_ISSUER_RECORD_BYTES) throw new Error("issuer_record_too_large");
  return b;
}
export function createIssuerSession(options: IssuerSessionOptions): IssuerFacade {
  const { bus, operations, recipe } = options,
    now = options.now ?? (() => new Date()),
    maxAge = options.maxCapabilityAgeMs ?? 30000;
  if (
    !bus.registry ||
    operations.sources.registry !== bus.registry ||
    !Number.isSafeInteger(maxAge) ||
    maxAge < 1 ||
    maxAge > 60000 ||
    options.capabilities.length > 32
  )
    throw new Error("issuer_configuration_invalid");
  const fixedRequesterId = bus.codec.signer.actorId;
  const sources = [...options.capabilities],
    transport = composerTransportPort(bus, recipe.prepare.bind(recipe));
  if (recipe.promptFormat) transport.promptFormat = recipe.promptFormat;
  const session = () => {
    const s = validateIssuerSession(options.session(), now());
    if (s.requesterActorId !== fixedRequesterId || bus.codec.signer.actorId !== fixedRequesterId)
      throw new Error("issuer_signer_mismatch");
    return s;
  };
  function currentCapabilities() {
    const values = sources.map((source) => {
      const v = validateRecipientCapability(source.current());
      if (v.recipientActorId !== source.codec.signer.actorId)
        throw new Error("issuer_capability_signer_mismatch");
      source.codec.role(v.recipientActorId, "recipient");
      return { source, value: v };
    });
    if (new Set(values.map((v) => v.value.destinationId)).size !== values.length)
      throw new Error("issuer_capability_duplicate");
    return values;
  }
  function scope(s: IssuerSessionBindingV1, prepared: PreparedComposerPreview, requestId?: string) {
    const children =
      requestId === undefined
        ? prepared.preview.children
        : prepared.preview.children.filter((c) => c.requestId === requestId);
    if (!children.length) throw new Error("issuer_request_scope_denied");
    if (
      !s.allowedProjectIds.includes(prepared.preview.projectId) ||
      children.some((c) => !s.allowedDestinationIds.includes(c.destinationId))
    )
      throw new Error("issuer_scope_denied");
  }
  function bindings(
    prepared: PreparedComposerPreview,
    caps: readonly RecipientCapabilityV1[],
    fresh: boolean,
  ) {
    const registry = bus.registry;
    if (!registry) throw new Error("issuer_registry_unavailable");
    const p = prepared.preview;
    const destinations = fresh ? options.currentDestinations() : [];
    if (!Array.isArray(destinations) || destinations.length > 256)
      throw new Error("issuer_destinations_invalid");
    for (const [index, child] of p.children.entries()) {
      const parsed = loadTaskSpec(Buffer.from(child.rawSpec));
      if (!parsed.valid) throw new Error("issuer_preparation_invalid");
      const cap = caps.find((c) => c.destinationId === child.destinationId);
      if (
        !cap ||
        cap.recipientActorId !== child.recipientActorId ||
        cap.route !== child.route ||
        cap.providerId !== parsed.task.agent ||
        !cap.modelIds.includes(parsed.task.requested_model) ||
        cap.policySha256 !== parsed.task.policy_snapshot_sha256 ||
        !cap.projects.some(
          (ref) =>
            ref.projectId === p.projectId &&
            ref.registryRevision === p.registryRevision &&
            ref.snapshotSha256 === p.registrySha256,
        )
      )
        throw new Error("issuer_capability_binding_mismatch");
      if (fresh) {
        assertCapabilityFresh(cap, now(), maxAge);
        if (!cap.actions.issue.available) throw new Error("issuer_capability_unavailable");
        const destination = destinations.find((d) => d.destinationId === child.destinationId);
        if (
          !destination ||
          destination.unavailableReason ||
          destinationFingerprint(destination) !== prepared.catalogue[index] ||
          destination.recipientActorId !== cap.recipientActorId ||
          destination.providerId !== cap.providerId ||
          destination.route !== cap.route ||
          destination.policyHash !== cap.policySha256 ||
          !destination.modelIds.includes(parsed.task.requested_model)
        )
          throw new Error("issuer_destination_changed");
        if (
          readComposerPromptFormat(recipe.promptFormat, destination, parsed.task.requested_model)
            .fingerprint !== prepared.promptFormats[index]
        )
          throw new Error("issuer_prompt_changed");
      }
    }
    if (
      fresh &&
      (registry.currentRevision() !== p.registryRevision ||
        registry.snapshotHash(p.registryRevision) !== p.registrySha256)
    )
      throw new Error("issuer_registry_changed");
  }
  function decodePreparation(bytes: Uint8Array, historical: boolean, requestId?: string) {
    const decoded = bus.codec.decode(bytes);
    if (decoded.message.kind !== "issuer_preparation")
      throw new Error("issuer_preparation_required");
    const receipt = validateIssuerPreparation(decoded.message.preparation),
      s = session();
    if (receipt.requesterActorId !== s.requesterActorId || decoded.actorId !== s.requesterActorId)
      throw new Error("issuer_requester_denied");
    if (issuerTime(receipt.createdAt) > now().getTime())
      throw new Error("issuer_preparation_time_invalid");
    if (
      !historical &&
      (receipt.sessionId !== s.sessionId || issuerTime(receipt.expiresAt) <= now().getTime())
    )
      throw new Error("issuer_preparation_expired");
    const prepared = parsePreparedComposer(strictBase64(receipt.preparedBase64));
    scope(s, prepared, historical ? requestId : undefined);
    const caps = receipt.capabilities.map((item) => {
      const d = bus.codec.decode(strictBase64(item.signedBase64, 32768));
      if (
        d.message.kind !== "issuer_capability" ||
        d.message.capability.destinationId !== item.destinationId
      )
        throw new Error("issuer_capability_binding_mismatch");
      return d.message.capability;
    });
    bindings(prepared, caps, !historical);
    return { receipt, prepared, caps, session: s, signedPreparationSha256: sha256Bytes(bytes) };
  }
  function sameScopedCapability(
    observed: RecipientCapabilityV1 | undefined,
    captured: RecipientCapabilityV1,
    s: IssuerSessionBindingV1,
  ): boolean {
    return (
      !!observed &&
      captured.projects.every(
        (ref) =>
          s.allowedProjectIds.includes(ref.projectId) &&
          observed.projects.some((current) => isDeepStrictEqual(current, ref)),
      ) &&
      isDeepStrictEqual({ ...observed, projects: captured.projects }, captured)
    );
  }
  function finalGuard(captured: ReturnType<typeof decodePreparation>) {
    const originalSession = structuredClone(captured.session),
      caps = structuredClone(captured.caps),
      fingerprint = digest(captured.prepared);
    return () => {
      const s = session();
      if (!isDeepStrictEqual(s, originalSession) || digest(captured.prepared) !== fingerprint)
        throw new Error("issuer_binding_changed");
      scope(s, captured.prepared);
      bindings(captured.prepared, caps, true);
      const current = currentCapabilities();
      for (const c of caps)
        if (
          !sameScopedCapability(
            current.find((x) => x.value.destinationId === c.destinationId)?.value,
            c,
            s,
          )
        )
          throw new Error("issuer_capability_changed");
    };
  }
  async function issuance(captured: ReturnType<typeof decodePreparation>, requestId: string) {
    const child = captured.prepared.preview.children.find((c) => c.requestId === requestId);
    if (!child) throw new Error("issuer_request_scope_denied");
    const snapshot = await bus.git.snapshot();
    const { issued, raw, taskBytes } = await bus.readIssued(
      snapshot,
      bus.path("inbox", requestId, "issued.json"),
    );
    if (
      issued.requesterId !== captured.session.requesterActorId ||
      issued.requesterId !== captured.receipt.requesterActorId ||
      issued.requestId !== child.requestId ||
      issued.recipientId !== child.recipientActorId ||
      issued.route !== child.route ||
      issued.taskSpecHash !== child.taskSpecHash ||
      issued.taskFileHash !== child.taskFileHash ||
      issued.fanoutId !== captured.prepared.preview.fanoutId ||
      sha256Bytes(raw) !== child.taskSpecHash ||
      sha256Bytes(taskBytes) !== child.taskFileHash ||
      !isDeepStrictEqual(issued.projectRegistration, {
        projectId: captured.prepared.preview.projectId,
        registryRevision: captured.prepared.preview.registryRevision,
        snapshotSha256: captured.prepared.preview.registrySha256,
      })
    )
      throw new Error("issuer_issuance_binding_mismatch");
    const publishedPreparation = await bus.git.read(
      snapshot,
      bus.path("outbox", requestId, "issuer_preparation.json"),
    );
    if (
      !publishedPreparation ||
      sha256Bytes(publishedPreparation) !== captured.signedPreparationSha256
    )
      throw new Error("issuer_publication_binding_mismatch");
    const published = bus.codec.decode(publishedPreparation);
    if (
      published.message.kind !== "issuer_preparation" ||
      !isDeepStrictEqual(published.message.preparation, captured.receipt)
    )
      throw new Error("issuer_publication_binding_mismatch");
    scope(session(), captured.prepared, requestId);
    return { snapshot, issued, child };
  }
  const facade: IssuerFacade = {
    async catalogue() {
      const s = session(),
        values = currentCapabilities()
          .filter(
            ({ value }) =>
              s.allowedDestinationIds.includes(value.destinationId) &&
              value.projects.some((p) => s.allowedProjectIds.includes(p.projectId)),
          )
          .map(({ source, value }) => ({
            source,
            value: {
              ...value,
              projects: value.projects.filter((p) => s.allowedProjectIds.includes(p.projectId)),
            },
          }));
      const signed = [];
      for (const { source, value } of values) {
        assertCapabilityFresh(value, now(), maxAge);
        const bytes = await source.codec.encode({ kind: "issuer_capability", capability: value });
        signed.push({
          destinationId: value.destinationId,
          sha256: sha256Bytes(bytes),
          signedBase64: Buffer.from(bytes).toString("base64"),
          capability: structuredClone(value),
        });
      }
      if (!isDeepStrictEqual(session(), s)) throw new Error("issuer_binding_changed");
      const current = currentCapabilities();
      for (const { value } of values) {
        assertCapabilityFresh(value, now(), maxAge);
        if (
          !sameScopedCapability(
            current.find((x) => x.value.destinationId === value.destinationId)?.value,
            value,
            s,
          )
        )
          throw new Error("issuer_capability_changed");
      }
      const registry = bus.registry;
      if (!registry) throw new Error("issuer_registry_unavailable");
      const revision = registry.currentRevision();
      const projects = registry
        .snapshot(revision)
        .projects.filter((p) => s.allowedProjectIds.includes(p.projectId))
        .map(({ projectId, repoId, storageSlug, displayName }) => ({
          projectId,
          repoId,
          storageSlug,
          displayName,
        }));
      return {
        schema: "bridge-issuer-catalogue-1",
        session: s,
        conditionalPublication: bus.git.appendConditional ? "supported" : "unavailable",
        registry: { revision, snapshotSha256: registry.snapshotHash(revision), projects },
        capabilities: signed,
      };
    },
    async template(projectId, destinationId, modelId) {
      const before = session();
      if (
        !before.allowedProjectIds.includes(projectId) ||
        !before.allowedDestinationIds.includes(destinationId)
      )
        throw new Error("issuer_scope_denied");
      const cap = currentCapabilities().find((c) => c.value.destinationId === destinationId)?.value;
      if (!cap) throw new Error("issuer_capability_unavailable");
      assertCapabilityFresh(cap, now(), maxAge);
      const value = await issuerReadPort(operations, recipe).template(
        projectId,
        destinationId,
        modelId,
      );
      if (
        !isDeepStrictEqual(session(), before) ||
        !isDeepStrictEqual(
          currentCapabilities().find((c) => c.value.destinationId === destinationId)?.value,
          cap,
        )
      )
        throw new Error("issuer_binding_changed");
      assertCapabilityFresh(cap, now(), maxAge);
      const destination = options
        .currentDestinations()
        .find((d) => d.destinationId === destinationId);
      if (
        !destination ||
        destination.unavailableReason ||
        !cap.actions.issue.available ||
        destination.recipientActorId !== cap.recipientActorId ||
        destination.providerId !== cap.providerId ||
        destination.route !== cap.route ||
        destination.policyHash !== cap.policySha256 ||
        value.taskSpecTemplate.agent !== cap.providerId ||
        value.taskSpecTemplate.policy_snapshot_sha256 !== cap.policySha256 ||
        !cap.modelIds.includes(value.modelId) ||
        !cap.projects.some(
          (p) =>
            p.projectId === projectId &&
            p.registryRevision === value.registryRevision &&
            p.snapshotSha256 === value.registrySha256,
        )
      )
        throw new Error("issuer_capability_binding_mismatch");
      return value;
    },
    async prepare(input) {
      input = structuredClone(input);
      const value = issuerRecord(input, ["identities", "request"]),
        identity = issuerRecord(value.identities, ["previewId", "requestIds", "fanoutId"]);
      const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?![\s\S])/;
      if (
        typeof identity.previewId !== "string" ||
        !uuid.test(identity.previewId) ||
        !Array.isArray(identity.requestIds) ||
        identity.requestIds.length < 1 ||
        identity.requestIds.length > 4 ||
        identity.requestIds.some((id) => typeof id !== "string" || !uuid.test(id)) ||
        (identity.fanoutId !== null &&
          (typeof identity.fanoutId !== "string" || !uuid.test(identity.fanoutId)))
      )
        throw new Error("issuer_arguments_invalid");
      const s = session(),
        catalogue = (await facade.catalogue()) as {
          capabilities: { destinationId: string; sha256: string; signedBase64: string }[];
        };
      const composer = new UiComposer(
        operations,
        recipe,
        now,
        identity as unknown as { previewId: string; requestIds: string[]; fanoutId: string | null },
      );
      const preview = await composer.preview(value.request),
        prepared = composer.preparation(preview.previewId, digest(preview));
      scope(s, prepared);
      const capabilities = prepared.preview.children.map((child) => {
        const c = catalogue.capabilities.find((c) => c.destinationId === child.destinationId);
        if (!c) throw new Error("issuer_scope_denied");
        return { destinationId: c.destinationId, sha256: c.sha256, signedBase64: c.signedBase64 };
      });
      const receipt: IssuerPreparationV1 = {
        schema: "bridge-issuer-preparation-1",
        preparationId: preview.previewId,
        sessionId: s.sessionId,
        requesterActorId: s.requesterActorId,
        createdAt: now().toISOString(),
        expiresAt: preview.expiresAt,
        preparedSha256: digest(prepared),
        preparedBase64: bounded(prepared).toString("base64"),
        capabilities,
      };
      const raw = await bus.codec.encode({
        kind: "issuer_preparation",
        preparation: validateIssuerPreparation(receipt),
      });
      const captured = decodePreparation(raw, false);
      if (!isDeepStrictEqual(captured.session, s)) throw new Error("issuer_binding_changed");
      finalGuard(captured)();
      return {
        signedPreparationBase64: Buffer.from(raw).toString("base64"),
        preparationSha256: sha256Bytes(raw),
        prepared,
      };
    },
    async issue(raw) {
      raw = Buffer.from(raw);
      const captured = decodePreparation(raw, false);
      const composer = new UiComposer(operations, recipe, now);
      await composer.validatePreparation(captured.prepared);
      const guard = finalGuard(captured);
      guard();
      const result = await transport.issue(captured.prepared.preview, guard, raw);
      return {
        ...result,
        requestIds: captured.prepared.preview.children.map((c) => c.requestId),
        reexecute: false,
      };
    },
    async result(raw, requestId) {
      raw = Buffer.from(raw);
      const captured = decodePreparation(raw, true, requestId),
        { snapshot, issued } = await issuance(captured, requestId),
        hosted = issued.route === "ordinary_chat_browser";
      const event = hosted
        ? await bus.readHosted(snapshot, requestId, "hosted_result")
        : await bus.readEvent(snapshot, requestId, "terminal_result");
      // Even a pending projection must use the still-valid requester scope after awaited reads.
      scope(session(), captured.prepared, requestId);
      if (!event) return { requestId, state: "pending", reexecute: false };
      const bytes = await bus.git.read(
        snapshot,
        bus.path(hosted ? "hosted" : "outbox", requestId, hosted ? "response.json" : "result.json"),
      );
      if (
        !bytes ||
        sha256Bytes(bytes) !== event.payloadSha256 ||
        event.actorId !== issued.recipientId ||
        event.taskSpecHash !== issued.taskSpecHash
      )
        throw new Error("issuer_result_unverified");
      const current = session();
      if (current.requesterActorId !== captured.receipt.requesterActorId)
        throw new Error("issuer_requester_denied");
      scope(current, captured.prepared, requestId);
      return {
        commit: snapshot.commit,
        event,
        result: parseStrictJsonBytes(bytes),
        reexecute: false,
      };
    },
    async acknowledge(raw, requestId, payloadSha256) {
      raw = Buffer.from(raw);
      if (!/^[a-f0-9]{64}(?![\s\S])/.test(payloadSha256)) throw new Error("issuer_hash_invalid");
      const captured = decodePreparation(raw, true, requestId),
        { issued } = await issuance(captured, requestId);
      if (!options.materialize) throw new Error("delivery_materializer_unconfigured");
      const accept = async (
        _bytes: Uint8Array,
        event: { payloadSha256: string },
        context: DeliveryAcceptanceContext,
      ) => {
        if (
          event.payloadSha256 !== payloadSha256 ||
          context.issued.requesterId !== captured.receipt.requesterActorId ||
          context.issued.taskSpecHash !==
            captured.prepared.preview.children.find((c) => c.requestId === requestId)?.taskSpecHash
        )
          throw new Error("issuer_ack_binding_changed");
        const s = session();
        if (s.requesterActorId !== captured.receipt.requesterActorId)
          throw new Error("issuer_requester_denied");
        scope(s, captured.prepared, requestId);
        const proof = await options.materialize?.(context);
        const after = session();
        if (after.requesterActorId !== s.requesterActorId)
          throw new Error("issuer_requester_denied");
        scope(after, captured.prepared, requestId);
        return proof;
      };
      const ackGuard = () => {
        const s = session();
        if (s.requesterActorId !== captured.receipt.requesterActorId)
          throw new Error("issuer_requester_denied");
        scope(s, captured.prepared, requestId);
      };
      const commit =
        issued.route === "ordinary_chat_browser"
          ? await bus.acceptHosted(requestId, accept, ackGuard)
          : await bus.acceptResult(requestId, accept, ackGuard);
      return { commit, requestId, acknowledgedPayloadSha256: payloadSha256, reexecute: false };
    },
  };
  return facade;
}

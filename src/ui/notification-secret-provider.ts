/** Concrete notification-only credential host. No Electron import, native call or transport on import. */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import {
  type DiscordNotificationTransportOptions,
  type PreparedNotificationTransport,
  prepareDiscordNotificationTransport,
  prepareEmailNotificationTransport,
  prepareLeasedNotificationTransport,
} from "../adapters/notification-transports.js";
import type { NotificationPreferencesStore } from "./notification-preferences.js";
import { claimNotificationProviderOwnership } from "./notification-private-state.js";
import {
  type NotificationBinding,
  type NotificationCredentialSessionV2,
  NotificationRuntime,
  type SecureNotificationRegistry,
} from "./notification-runtime.js";
import {
  type NotificationSecretSlot,
  NotificationSecretStore,
} from "./notification-secret-store.js";
export interface NotificationNativePorts {
  cipher: { seal(plaintext: string): Uint8Array; open(ciphertext: Uint8Array): string };
  dialog: {
    open(input: {
      view: {
        label: string;
        channel: "discord" | "email";
        hasRecord: boolean;
        expectedTarget: string | null;
        leaseLifetimeMs: number;
      };
      submit(value: unknown): void;
      cancel(): void;
    }): { close(): void };
  };
}
export interface NotificationSlotConfiguration {
  destinationId: string;
  channel: "discord" | "email";
  label: string;
  /** Email is exclusively host-prebound. No default recipient, provider, or auth scheme. */
  email?: {
    targetId: string;
    validateCredential(secret: string): boolean;
    resolveSender(
      secret: string,
      signal: AbortSignal,
    ): Promise<PreparedNotificationTransport | null>;
  };
}
export interface NotificationProviderConfiguration {
  slots?: readonly NotificationSlotConfiguration[];
  leaseLifetimeMs?: number;
  authorizeSend?(actor: string, destination: string, kind: "human_check" | "test"): boolean;
}
interface Lease {
  secret: string | null;
  slot: NotificationSecretSlot;
  epoch: number;
  deadline: number;
  monotonicDeadline: number;
  born: number;
  monotonicBorn: number;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout>;
}
interface Admission {
  session: NotificationCredentialSessionV2;
  epoch: number;
  dialog?: { close(): void };
  submitted: boolean;
  installed?: boolean;
  candidate?: object;
}
interface Candidate {
  before: NotificationSecretSlot;
  next: NotificationSecretSlot;
  ciphertext: Uint8Array;
  secret: string | null;
  actionId: string;
  epoch: number;
  committed: boolean;
}
const WEBHOOK = /^https:\/\/discord\.com\/api\/webhooks\/([0-9]{1,24})\/[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_LIFETIME = 8 * 60 * 60 * 1000;
function fail(): never {
  throw new Error("notification_credentials_unavailable");
}
export class NativeNotificationRegistry implements SecureNotificationRegistry {
  readonly credentialProtocol = "bridge-notification-credentials-2" as const;
  readonly store: NotificationSecretStore;
  private readonly ownership;
  private readonly specifications: readonly NotificationSlotConfiguration[];
  private readonly lifetime: number;
  private readonly leases = new Map<string, Lease>();
  private readonly admissions = new Map<string, Admission>();
  private readonly candidates = new Map<object, Candidate>();
  private readonly epochs = new Map<string, number>();
  private closed = false;
  constructor(
    private readonly options: {
      preferences: NotificationPreferencesStore;
      actorId: string;
      native: NotificationNativePorts;
      configuration?: NotificationProviderConfiguration;
      now?: () => Date;
      monotonic?: () => number;
      /** Deterministic transport ports only; never populated from HTTP or production environment. */
      discordTransport?: Pick<
        DiscordNotificationTransportOptions,
        "resolveAddresses" | "httpsRequest"
      >;
    },
  ) {
    this.lifetime = options.configuration?.leaseLifetimeMs ?? DEFAULT_LIFETIME;
    if (
      !Number.isSafeInteger(this.lifetime) ||
      this.lifetime < 60000 ||
      this.lifetime > 24 * 3600000
    )
      throw new Error("notification_lease_lifetime_invalid");
    this.specifications = (
      options.configuration?.slots ?? [
        { destinationId: "discord-personal", channel: "discord", label: "Personal Discord" },
      ]
    ).map((value) =>
      Object.freeze({
        ...value,
        ...(value.email ? { email: Object.freeze({ ...value.email }) } : {}),
      }),
    );
    if (
      this.specifications.some(
        (s) => !["discord", "email"].includes(s.channel) || (s.channel === "discord" && s.email),
      )
    )
      fail();
    this.ownership = claimNotificationProviderOwnership(options.preferences);
    try {
      this.store = new NotificationSecretStore(
        options.preferences,
        options.actorId,
        this.specifications,
        this.now(),
      );
    } catch (error) {
      this.ownership.close();
      throw error;
    }
  }
  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
  private mono(): number {
    return this.options.monotonic?.() ?? performance.now();
  }
  private slot(
    actor: string,
    destination: string,
    db?: DatabaseSync,
  ): NotificationSecretSlot | null {
    if (
      this.closed ||
      actor !== this.options.actorId ||
      !this.specifications.some((s) => s.destinationId === destination)
    )
      return null;
    this.ownership.verify();
    return this.store.get(actor, destination, db);
  }
  private epoch(destination: string): number {
    return this.epochs.get(destination) ?? 0;
  }
  private revoke(destination: string): void {
    this.epochs.set(destination, this.epoch(destination) + 1);
    const lease = this.leases.get(destination);
    if (lease) {
      clearTimeout(lease.timer);
      lease.secret = null;
      lease.abort.abort();
      this.leases.delete(destination);
    }
  }
  private lease(slot: NotificationSecretSlot): Lease | null {
    const lease = this.leases.get(slot.destination);
    if (!lease) return null;
    if (
      lease.epoch !== this.epoch(slot.destination) ||
      !lease.secret ||
      lease.slot.generation !== slot.generation ||
      lease.slot.revision !== slot.revision ||
      this.now().getTime() < lease.born ||
      this.now().getTime() >= lease.deadline ||
      this.mono() < lease.monotonicBorn ||
      this.mono() >= lease.monotonicDeadline ||
      lease.abort.signal.aborted
    ) {
      this.revoke(slot.destination);
      return null;
    }
    return lease;
  }
  isCurrent(actor: string, destination: string, generation: string, revision: number): boolean {
    try {
      const slot = this.slot(actor, destination);
      if (!slot || slot.generation !== generation || slot.revision !== revision) return false;
      return this.options.preferences.withRuntimeRead((db) => {
        if (
          !db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='notification_bindings'",
            )
            .get()
        )
          return true;
        const row = db
          .prepare(
            "SELECT state,generation,revision FROM notification_bindings WHERE actor=? AND destination=?",
          )
          .get(actor, destination);
        return (
          !row ||
          (row.state === "ready" && row.generation === generation && row.revision === revision)
        );
      });
    } catch {
      return false;
    }
  }
  async list(actor: string, signal: AbortSignal): Promise<readonly NotificationBinding[]> {
    if (this.closed || signal.aborted || actor !== this.options.actorId) return [];
    return this.specifications.map((spec) => {
      const slot = this.slot(actor, spec.destinationId) ?? fail();
      let credentialState: NotificationBinding["credentialState"] = "unavailable";
      try {
        const record = this.store.readRecord(slot);
        credentialState =
          spec.channel === "email" && !this.email(spec)
            ? "unavailable"
            : this.lease(slot)
              ? "configured"
              : record
                ? "locked"
                : "missing";
      } catch {
        /* Corrupt records stay unavailable and are never overwritten implicitly. */
      }
      return {
        destinationId: slot.destination,
        channel: slot.channel,
        label: slot.label,
        generation: slot.generation,
        revision: slot.revision,
        activatedAt: slot.activatedAt,
        credentialState,
        prepare: async (prepareSignal) => {
          const lease = this.lease(slot);
          if (!lease || !this.isCurrent(actor, slot.destination, slot.generation, slot.revision))
            return null;
          const current = () =>
            this.lease(slot) === lease &&
            this.isCurrent(actor, slot.destination, slot.generation, slot.revision);
          const transport = prepareLeasedNotificationTransport(
            {
              leaseSignal: lease.abort.signal,
              isCurrent: current,
              prepare: async (sendSignal, remainingMs) => {
                if (!current() || !lease.secret) return null;
                if (spec.channel === "discord")
                  return prepareDiscordNotificationTransport(
                    {
                      ...this.options.discordTransport,
                      totalTimeoutMs: remainingMs,
                      readWebhook: async () => (current() ? lease.secret : null),
                    },
                    sendSignal,
                  );
                const email = this.email(spec);
                return email
                  ? prepareEmailNotificationTransport(
                      {
                        totalTimeoutMs: remainingMs,
                        resolveSender: async (innerSignal) =>
                          current() && lease.secret
                            ? email.resolveSender(lease.secret, innerSignal)
                            : null,
                      },
                      sendSignal,
                    )
                  : null;
              },
            },
            prepareSignal,
          );
          return transport
            ? { generation: slot.generation, revision: slot.revision, transport }
            : null;
        },
      };
    });
  }
  private email(
    spec: NotificationSlotConfiguration,
  ): NotificationSlotConfiguration["email"] | null {
    return spec.email &&
      typeof spec.email.targetId === "string" &&
      spec.email.targetId.length > 0 &&
      spec.email.targetId.length <= 128 &&
      /^[A-Za-z0-9_.:-]+$/.test(spec.email.targetId) &&
      typeof spec.email.validateCredential === "function" &&
      typeof spec.email.resolveSender === "function"
      ? spec.email
      : null;
  }
  authorizeSend(actor: string, destination: string, kind: "human_check" | "test"): boolean {
    try {
      const slot = this.slot(actor, destination);
      return (
        !!slot?.target &&
        !!slot.consent &&
        !!this.store.readRecord(slot) &&
        this.isCurrent(actor, destination, slot.generation, slot.revision) &&
        (this.options.configuration?.authorizeSend?.(actor, destination, kind) ?? true) === true
      );
    } catch {
      return false;
    }
  }
  admitCredentialInteraction(session: NotificationCredentialSessionV2): void {
    if (this.closed || this.admissions.size || !this.slot(session.actorId, session.destinationId))
      fail();
    this.revoke(session.destinationId);
    this.admissions.set(session.actionId, {
      session,
      epoch: this.epoch(session.destinationId),
      submitted: false,
    });
  }
  beginCredentialInteractionV2(session: NotificationCredentialSessionV2): void {
    const admission = this.admissions.get(session.actionId);
    if (
      !admission ||
      admission.session !== session ||
      !session.isActive() ||
      this.epoch(session.destinationId) !== admission.epoch
    )
      return;
    try {
      const slot = this.slot(session.actorId, session.destinationId) ?? fail();
      const spec = this.specifications.find((s) => s.destinationId === slot.destination) ?? fail();
      if (spec.channel === "email" && !this.email(spec)) fail();
      const record = this.store.readRecord(slot);
      admission.dialog = this.options.native.dialog.open({
        view: {
          label: slot.label,
          channel: slot.channel,
          hasRecord: !!record,
          expectedTarget: slot.target ?? this.email(spec)?.targetId ?? null,
          leaseLifetimeMs: this.lifetime,
        },
        submit: (value) => this.submit(admission, value),
        cancel: () => {
          if (this.admissions.get(session.actionId) === admission) {
            session.complete("cancelled");
            this.cancelCredentialInteraction(session.actionId);
          }
        },
      });
      if (!session.isActive() || this.admissions.get(session.actionId) !== admission) {
        admission.dialog.close();
        this.cancelCredentialInteraction(session.actionId);
      }
    } catch {
      session.complete("rejected");
      this.cancelCredentialInteraction(session.actionId);
    }
  }
  private submit(admission: Admission, value: unknown): void {
    const session = admission.session;
    if (
      admission.submitted ||
      this.admissions.get(session.actionId) !== admission ||
      !session.isActive()
    )
      return;
    admission.submitted = true;
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) fail();
      const v = value as { mode: string; secret?: string; consent?: boolean };
      if (
        Object.keys(v).some((k) => !["mode", "secret", "consent"].includes(k)) ||
        !["register", "replace", "unlock"].includes(v.mode)
      )
        fail();
      const before = this.slot(session.actorId, session.destinationId) ?? fail();
      if (
        before.generation !== session.expectedGeneration ||
        before.revision !== session.expectedBindingRevision
      )
        fail();
      const spec =
        this.specifications.find((s) => s.destinationId === before.destination) ?? fail();
      const existing = this.store.readRecord(before);
      if (
        (v.mode === "register") !== !existing ||
        (v.mode === "register" && v.consent !== true) ||
        (v.mode === "unlock" && (v.secret !== undefined || !existing))
      )
        fail();
      let secret =
        v.mode === "unlock"
          ? this.store.decode(
              before,
              this.options.native.cipher.open(existing?.ciphertext ?? fail()),
            )
          : v.secret;
      if (
        typeof secret !== "string" ||
        !secret ||
        Buffer.byteLength(secret) > 4096 ||
        /[\0\r\n]/.test(secret)
      )
        fail();
      const target =
        before.channel === "discord" ? WEBHOOK.exec(secret)?.[1] : this.email(spec)?.targetId;
      if (
        !target ||
        (before.channel === "email" && this.email(spec)?.validateCredential(secret) !== true)
      )
        fail();
      if (before.target && before.target !== target)
        throw new Error("notification_retarget_requires_registration");
      if (
        !session.isActive() ||
        admission.epoch !== this.epoch(before.destination) ||
        session.signal.aborted ||
        this.now().getTime() >= session.deadlineAt
      )
        fail();
      const next: NotificationSecretSlot = {
        ...before,
        generation: randomUUID(),
        revision: before.revision + 1,
        activatedAt: this.now().toISOString(),
        target,
        consent: before.consent ?? randomUUID(),
      };
      if (!Number.isSafeInteger(next.revision) || next.activatedAt < before.activatedAt) fail();
      const plaintext = JSON.stringify({ ...this.store.metadata(next), secret });
      if (Buffer.byteLength(plaintext) > 8192) fail();
      const ciphertext = this.options.native.cipher.seal(plaintext);
      if (
        !(ciphertext instanceof Uint8Array) ||
        !ciphertext.byteLength ||
        ciphertext.byteLength > 32768 ||
        !session.isActive() ||
        session.signal.aborted ||
        this.now().getTime() >= session.deadlineAt ||
        admission.epoch !== this.epoch(before.destination)
      )
        fail();
      const candidate = Object.freeze({});
      admission.candidate = candidate;
      this.candidates.set(candidate, {
        before,
        next,
        ciphertext: Buffer.from(ciphertext),
        secret,
        actionId: session.actionId,
        epoch: admission.epoch,
        committed: false,
      });
      secret = "";
      session.complete("saved", candidate);
    } catch {
      session.complete("rejected");
    } finally {
      this.cancelCredentialInteraction(session.actionId, false);
    }
  }
  commitCredentialCandidate(
    candidate: unknown,
    db: DatabaseSync,
    session: {
      actorId: string;
      destinationId: string;
      actionId: string;
      expectedGeneration: string;
      expectedBindingRevision: number;
    },
  ): { generation: string; revision: number; activatedAt: string } {
    if (!candidate || typeof candidate !== "object") fail();
    const value = this.candidates.get(candidate);
    const admission = this.admissions.get(session.actionId);
    if (
      !value ||
      !admission ||
      value.committed ||
      this.closed ||
      value.epoch !== this.epoch(session.destinationId) ||
      value.actionId !== session.actionId ||
      value.before.actor !== session.actorId ||
      value.before.destination !== session.destinationId ||
      value.before.generation !== session.expectedGeneration ||
      value.before.revision !== session.expectedBindingRevision ||
      admission.session.signal.aborted ||
      this.now().getTime() >= admission.session.deadlineAt
    )
      fail();
    this.ownership.verify();
    this.store.commit(db, value.before, value.next, value.ciphertext);
    value.committed = true;
    return {
      generation: value.next.generation,
      revision: value.next.revision,
      activatedAt: value.next.activatedAt,
    };
  }
  installCredentialCandidate(candidate: unknown): void {
    if (!candidate || typeof candidate !== "object") return;
    const value = this.candidates.get(candidate);
    if (!value) return;
    try {
      const current = this.slot(value.next.actor, value.next.destination);
      if (
        this.closed ||
        !value.committed ||
        !value.secret ||
        value.epoch !== this.epoch(value.next.destination) ||
        current?.generation !== value.next.generation ||
        current.revision !== value.next.revision
      )
        return;
      // A rolled-back commit cannot install: verify the exact durable record after COMMIT.
      if (!this.store.readRecord(current)) return;
      const born = this.now().getTime();
      const monotonicBorn = this.mono();
      const timer = setTimeout(() => this.revoke(current.destination), this.lifetime);
      timer.unref?.();
      this.leases.set(current.destination, {
        secret: value.secret,
        slot: current,
        epoch: value.epoch,
        born,
        monotonicBorn,
        deadline: born + this.lifetime,
        monotonicDeadline: monotonicBorn + this.lifetime,
        abort: new AbortController(),
        timer,
      });
      const admission = this.admissions.get(value.actionId);
      if (admission) admission.installed = true;
    } finally {
      value.secret = null;
      this.candidates.delete(candidate);
    }
  }
  cancelCredentialInteraction(actionId: string, revoke = true): void {
    const admission = this.admissions.get(actionId);
    if (!admission) return;
    this.admissions.delete(actionId);
    if (revoke && !admission.installed) this.revoke(admission.session.destinationId);
    if (admission.candidate) {
      const candidate = this.candidates.get(admission.candidate);
      if (candidate) candidate.secret = null;
      this.candidates.delete(admission.candidate);
    }
    admission.dialog?.close();
  }
  lock(): void {
    for (const spec of this.specifications) this.revoke(spec.destinationId);
    for (const [id] of this.admissions) this.cancelCredentialInteraction(id);
    for (const value of this.candidates.values()) value.secret = null;
    this.candidates.clear();
  }
  close(): void {
    if (this.closed) return;
    this.lock();
    this.closed = true;
    this.ownership.close();
  }
}
export function createNotificationProviderHost(options: {
  preferences: NotificationPreferencesStore;
  actorId: string;
  profile: string;
  configuration?: NotificationProviderConfiguration;
  native: NotificationNativePorts;
}): { runtime: NotificationRuntime; lock(): void; close(): Promise<void> } {
  if (options.profile !== "production" || options.preferences.profile !== options.profile)
    throw new Error("notification_profile_mismatch");
  const registry = new NativeNotificationRegistry(options);
  let runtime: NotificationRuntime;
  try {
    runtime = new NotificationRuntime(options.preferences, {
      registry,
      authorizeSend: (actor, destination, kind) => registry.authorizeSend(actor, destination, kind),
    });
  } catch (error) {
    registry.close();
    throw error;
  }
  return {
    runtime,
    lock() {
      registry.lock();
      runtime.lockCredentials();
    },
    async close() {
      registry.lock();
      try {
        await runtime.close();
      } finally {
        registry.close();
      }
    },
  };
}

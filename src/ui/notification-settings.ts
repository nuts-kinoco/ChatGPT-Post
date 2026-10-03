/** Per-actor registered-recipient preferences and explicit, host-owned notification actions. */
import type { OperationSource } from "../contracts/operations.js";
import { UiError, type UiProfile } from "../contracts/ui.js";
import {
  type AuthBlockNotificationPreferences,
  type NotificationPreferenceSnapshot,
  type NotificationPreferencesStore,
  validateNotificationActor,
  validateNotificationPreferences,
} from "./notification-preferences.js";
import type {
  NotificationActionView,
  NotificationControlsView,
  NotificationRuntime,
} from "./notification-runtime.js";
export interface RegisteredNotificationDestination {
  destinationId: string;
  channel: "email" | "discord";
  label: string;
  transportAvailable: boolean;
  unavailableReason: string | null;
}
export interface NotificationCataloguePort {
  /** Host returns only the exact destinations this authenticated actor may select. */
  list(
    actorId: string,
  ):
    | readonly RegisteredNotificationDestination[]
    | Promise<readonly RegisteredNotificationDestination[]>;
}
export type NotificationSettingsView =
  | {
      version: "bridge-notification-settings-1";
      state: "available";
      profile: UiProfile;
      preferences: NotificationPreferenceSnapshot;
      destinations: OperationSource<RegisteredNotificationDestination[]>;
      configurable: true;
      canEnable: boolean;
      unavailableReason: string | null;
      sendingImplemented: boolean;
      controls: NotificationControlsView | null;
    }
  | {
      version: "bridge-notification-settings-1";
      state: "unavailable";
      profile: UiProfile;
      configurable: false;
      reason: string;
      sendingImplemented: boolean;
      controls: NotificationControlsView | null;
    };
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
function catalogue(
  values: readonly RegisteredNotificationDestination[],
): RegisteredNotificationDestination[] {
  if (
    !Array.isArray(values) ||
    values.length > 64 ||
    new Set(values.map((value) => value.destinationId)).size !== values.length
  )
    throw new Error("notification_catalogue_invalid");
  return values.map((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join() !==
        "channel,destinationId,label,transportAvailable,unavailableReason" ||
      typeof value.destinationId !== "string" ||
      !ID.test(value.destinationId) ||
      !["email", "discord"].includes(value.channel) ||
      typeof value.label !== "string" ||
      !value.label.trim() ||
      value.label.length > 128 ||
      /[\0\r\n]|https?:\/\//i.test(value.label) ||
      typeof value.transportAvailable !== "boolean" ||
      (value.transportAvailable
        ? value.unavailableReason !== null
        : typeof value.unavailableReason !== "string" ||
          !/^[a-z][a-z0-9_]{0,95}$/.test(value.unavailableReason))
    )
      throw new Error("notification_destination_invalid");
    return {
      destinationId: value.destinationId,
      channel: value.channel,
      label: value.label,
      transportAvailable: value.transportAvailable,
      unavailableReason: value.unavailableReason,
    };
  });
}
const DELIVERY_STATES = ["queued", "sending", "delivered", "not_sent", "uncertain", "cancelled"];
/** Rebuild the bounded view rather than reflecting any provider-owned data. */
function safeControls(value: NotificationControlsView | undefined): NotificationControlsView {
  if (
    value?.version !== "bridge-notification-controls-1" ||
    typeof value.credentialInteractionAvailable !== "boolean" ||
    !Array.isArray(value.destinations) ||
    value.destinations.length > 64 ||
    !Array.isArray(value.recent) ||
    value.recent.length > 16 ||
    new Set(value.destinations.map((row) => row.destinationId)).size !== value.destinations.length
  )
    throw new Error("notification_controls_invalid");
  return {
    version: "bridge-notification-controls-1",
    credentialInteractionAvailable: value.credentialInteractionAvailable,
    destinations: value.destinations.map((row) => {
      if (
        !ID.test(row.destinationId) ||
        !["configured", "missing", "locked", "unavailable"].includes(row.credentialState)
      )
        throw new Error("notification_controls_invalid");
      return {
        destinationId: row.destinationId,
        credentialState: row.credentialState,
        masked: row.credentialState === "configured" ? "••••••••" : null,
      };
    }),
    recent: value.recent.map((row) => {
      if (
        !ID.test(row.destinationId) ||
        !["test", "human_check"].includes(row.kind) ||
        !DELIVERY_STATES.includes(row.state) ||
        !Number.isSafeInteger(row.attempts) ||
        row.attempts < 0 ||
        row.attempts > 3
      )
        throw new Error("notification_controls_invalid");
      return {
        destinationId: row.destinationId,
        kind: row.kind,
        state: row.state,
        attempts: row.attempts,
      };
    }),
  };
}
export class UiNotificationSettings {
  private readonly timeoutMs: number;
  constructor(
    private readonly options: {
      store?: NotificationPreferencesStore;
      authenticatedActorId?: string;
      profile: UiProfile;
      catalogue?: NotificationCataloguePort;
      runtime?: NotificationRuntime;
      readTimeoutMs?: number;
      storageUnavailableReason?:
        | "notification_storage_verifier_unavailable"
        | "notification_storage_untrusted"
        | "notification_storage_unavailable";
    },
  ) {
    if (options.runtime && options.runtime.preferences !== options.store)
      throw new UiError(
        "notification_runtime_store_mismatch",
        "Notification controls must share the settings store",
        500,
      );
    if (options.runtime && options.catalogue && options.catalogue !== options.runtime)
      throw new UiError(
        "notification_runtime_catalogue_mismatch",
        "Notification controls must share the registered destination catalogue",
        500,
      );
    this.timeoutMs = options.readTimeoutMs ?? 1000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 5000)
      throw new UiError(
        "invalid_notification_timeout",
        "Notification read timeout must be between 1 and 5000 ms",
        500,
      );
    if (
      !["production", "demo"].includes(options.profile) ||
      (options.store && options.store.profile !== options.profile)
    )
      throw new UiError(
        "notification_profile_mismatch",
        "Notification settings profile must match the injected store",
        500,
      );
  }
  private actor(): string {
    validateNotificationActor(this.options.authenticatedActorId);
    return this.options.authenticatedActorId;
  }
  private async destinations(): Promise<OperationSource<RegisteredNotificationDestination[]>> {
    const source = this.options.runtime ?? this.options.catalogue;
    if (!source)
      return { state: "unavailable", reason: "notification_destination_catalogue_unconfigured" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => source.list(this.actor()))
          .then(
            (values): OperationSource<RegisteredNotificationDestination[]> => ({
              state: "available",
              value: catalogue(values),
            }),
          )
          .catch(
            (): OperationSource<RegisteredNotificationDestination[]> => ({
              state: "error",
              reason: "notification_catalogue_read_failed",
            }),
          ),
        new Promise<OperationSource<RegisteredNotificationDestination[]>>((resolve) => {
          timer = setTimeout(
            () => resolve({ state: "timeout", reason: "notification_catalogue_read_timeout" }),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async controlsView(): Promise<{
    value: NotificationControlsView | null;
    reason: string | null;
  }> {
    if (!this.options.runtime) return { value: null, reason: null };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => this.options.runtime?.view(this.actor()))
          .then((value) => ({ value: safeControls(value), reason: null }))
          .catch(() => ({ value: null, reason: "notification_controls_read_failed" })),
        new Promise<{ value: null; reason: string }>((resolve) => {
          timer = setTimeout(
            () => resolve({ value: null, reason: "notification_controls_read_timeout" }),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private runtime(): NotificationRuntime {
    if (!this.options.runtime)
      throw new UiError(
        "notification_controls_unconfigured",
        "Notification sending and secure credential setup are not configured",
        409,
      );
    return this.options.runtime;
  }
  async test(input: unknown): Promise<NotificationActionView> {
    const actor = this.actor();
    return this.runtime().test(actor, input);
  }
  async credentials(input: unknown): Promise<NotificationActionView> {
    const actor = this.actor();
    return this.runtime().credentials(actor, input);
  }
  takeCredentialActivation(actionId: string): (() => void) | null {
    return this.runtime().takeCredentialActivation(this.actor(), actionId);
  }
  activateCredentialInteraction(actionId: string): void {
    this.runtime().activateCredentialInteraction(this.actor(), actionId);
  }
  cancelCredentials(input: unknown): NotificationActionView | null {
    return this.runtime().cancelCredentials(this.actor(), input);
  }
  credentialActions(): NotificationActionView[] {
    return this.runtime().credentialActions(this.actor());
  }
  actionStatus(actionId: string): NotificationActionView | null {
    const actor = this.actor();
    return this.runtime().status(actor, actionId);
  }
  async view(): Promise<NotificationSettingsView> {
    const base = {
      version: "bridge-notification-settings-1" as const,
      profile: this.options.profile,
      sendingImplemented: !!this.options.runtime,
      controls: null,
    };
    if (!this.options.store)
      return {
        ...base,
        state: "unavailable",
        configurable: false,
        reason: [
          "notification_storage_verifier_unavailable",
          "notification_storage_untrusted",
          "notification_storage_unavailable",
        ].includes(this.options.storageUnavailableReason ?? "")
          ? (this.options.storageUnavailableReason as string)
          : "notification_preferences_store_unconfigured",
      };
    let preferences: NotificationPreferenceSnapshot;
    try {
      preferences = this.options.store.snapshot(this.actor());
    } catch (error) {
      return {
        ...base,
        state: "unavailable",
        configurable: false,
        reason:
          error instanceof UiError && error.code === "notification_actor_unavailable"
            ? error.code
            : "notification_preferences_unavailable",
      };
    }
    const [destinations, controlsSource] = await Promise.all([
      this.destinations(),
      this.controlsView(),
    ]);
    const canEnable =
      destinations.state === "available" &&
      destinations.value.some((value) => value.transportAvailable);
    const selectedUnavailable =
      destinations.state === "available" && preferences.authBlocked.enabled
        ? preferences.authBlocked.destinationIds.find(
            (id) =>
              !destinations.value.some((row) => row.destinationId === id && row.transportAvailable),
          )
        : null;
    const unavailableReason =
      controlsSource.reason ??
      (destinations.state !== "available"
        ? destinations.reason
        : selectedUnavailable
          ? (destinations.value.find((row) => row.destinationId === selectedUnavailable)
              ?.unavailableReason ?? "notification_destination_no_longer_registered")
          : canEnable
            ? null
            : (destinations.value[0]?.unavailableReason ?? "notification_transports_unconfigured"));
    return {
      ...base,
      state: "available",
      configurable: true,
      preferences,
      controls: controlsSource.value,
      destinations,
      canEnable,
      unavailableReason,
    };
  }
  async update(input: unknown): Promise<NotificationSettingsView> {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join() !== "expectedRevision,settings"
    )
      throw new UiError(
        "invalid_notification_request",
        "Only expectedRevision and auth-block settings are accepted",
      );
    const value = input as { expectedRevision: unknown; settings: unknown };
    if (
      !Number.isSafeInteger(value.expectedRevision) ||
      Number(value.expectedRevision) < 0 ||
      Number(value.expectedRevision) >= 10000
    )
      throw new UiError(
        "invalid_notification_revision",
        "Expected revision must be an integer below 10000",
      );
    validateNotificationPreferences(value.settings);
    const store = this.options.store;
    if (!store)
      throw new UiError(
        "notification_preferences_store_unconfigured",
        "Notification preferences are not configured",
        409,
      );
    const actor = this.actor();
    const previous = store.snapshot(actor);
    if (previous.revision !== value.expectedRevision)
      throw new UiError(
        "stale_notification_preferences",
        "Notification preferences changed; refresh before saving",
        409,
      );
    // Turning OFF remains possible when a transport/catalogue is down. It adds no recipient.
    const destinationView =
      value.settings.enabled ||
      value.settings.destinationIds.some((id) => !previous.authBlocked.destinationIds.includes(id))
        ? await this.destinations()
        : null;
    this.validateSelection(value.settings, destinationView, previous.authBlocked.destinationIds);
    try {
      store.update(actor, Number(value.expectedRevision), value.settings);
      this.options.runtime?.invalidate(actor);
    } catch (error) {
      if (error instanceof UiError) throw error;
      throw new UiError(
        "notification_update_unavailable",
        "Notification settings could not be saved; refresh before retrying",
        409,
      );
    }
    return this.view();
  }
  private validateSelection(
    settings: AuthBlockNotificationPreferences,
    source: OperationSource<RegisteredNotificationDestination[]> | null,
    previous: string[],
  ): void {
    for (const id of settings.destinationIds) {
      if (!settings.enabled && previous.includes(id)) continue;
      if (source?.state !== "available")
        throw new UiError(
          "notification_catalogue_unavailable",
          source?.reason ?? "notification_destination_catalogue_unconfigured",
          409,
        );
      const destination = source.value.find((row) => row.destinationId === id);
      if (!destination)
        throw new UiError(
          "notification_destination_not_registered",
          "Choose an exact destination registered for this authenticated actor",
          409,
        );
      if (settings.enabled && !destination.transportAvailable)
        throw new UiError(
          "notification_transport_unavailable",
          destination.unavailableReason ?? "notification_transport_unconfigured",
          409,
        );
    }
  }
}

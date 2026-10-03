/** Per-actor registered-recipient preferences. Saving does not send, test-send, or install a transport. */
import type { OperationSource } from "../contracts/operations.js";
import { UiError, type UiProfile } from "../contracts/ui.js";
import {
  type AuthBlockNotificationPreferences,
  type NotificationPreferenceSnapshot,
  type NotificationPreferencesStore,
  validateNotificationActor,
  validateNotificationPreferences,
} from "./notification-preferences.js";
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
      sendingImplemented: false;
    }
  | {
      version: "bridge-notification-settings-1";
      state: "unavailable";
      profile: UiProfile;
      configurable: false;
      reason: string;
      sendingImplemented: false;
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
export class UiNotificationSettings {
  private readonly timeoutMs: number;
  constructor(
    private readonly options: {
      store?: NotificationPreferencesStore;
      authenticatedActorId?: string;
      profile: UiProfile;
      catalogue?: NotificationCataloguePort;
      readTimeoutMs?: number;
      storageUnavailableReason?:
        | "notification_storage_verifier_unavailable"
        | "notification_storage_untrusted"
        | "notification_storage_unavailable";
    },
  ) {
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
    const source = this.options.catalogue;
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
  async view(): Promise<NotificationSettingsView> {
    const base = {
      version: "bridge-notification-settings-1" as const,
      profile: this.options.profile,
      sendingImplemented: false as const,
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
    const destinations = await this.destinations();
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
      destinations.state !== "available"
        ? destinations.reason
        : selectedUnavailable
          ? (destinations.value.find((row) => row.destinationId === selectedUnavailable)
              ?.unavailableReason ?? "notification_destination_no_longer_registered")
          : canEnable
            ? null
            : (destinations.value[0]?.unavailableReason ?? "notification_transports_unconfigured");
    return {
      ...base,
      state: "available",
      configurable: true,
      preferences,
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

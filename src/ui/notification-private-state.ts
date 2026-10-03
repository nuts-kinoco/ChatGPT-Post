/** No permission repair and no Windows fallback. This is host-private storage ownership. */
import { closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type NotificationPreferencesStore,
  verifiedNotificationStorePath,
} from "./notification-preferences.js";

const owners = new Set<string>();
function unavailable(): never {
  throw new Error("notification_storage_untrusted");
}
function file(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    unavailable();
}
function sidecars(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      file(path + suffix);
    } catch (error) {
      if (suffix && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}
export function isVerifiedNotificationStore(store: NotificationPreferencesStore): boolean {
  return process.platform !== "win32" && !!verifiedNotificationStorePath(store);
}
export function verifyNotificationPrivateState(store: NotificationPreferencesStore): string {
  if (process.platform === "win32") throw new Error("notification_storage_verifier_unavailable");
  const path = verifiedNotificationStorePath(store);
  if (!path) throw new Error("notification_storage_verifier_unavailable");
  const directory = dirname(path),
    info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    realpathSync(directory) !== directory ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    unavailable();
  sidecars(path);
  return path;
}
export function claimNotificationProviderOwnership(store: NotificationPreferencesStore): {
  verify(): void;
  close(): void;
} {
  const path = verifyNotificationPrivateState(store);
  if (owners.has(path)) throw new Error("notification_provider_already_owned");
  const lockPath = join(dirname(path), "notification-provider-owner.db");
  try {
    closeSync(openSync(lockPath, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  sidecars(lockPath);
  let lock: DatabaseSync | undefined;
  try {
    lock = new DatabaseSync(lockPath);
    lock.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;");
    sidecars(lockPath);
    owners.add(path);
  } catch {
    lock?.close();
    throw new Error("notification_provider_already_owned");
  }
  const held = lock;
  let closed = false;
  return {
    verify() {
      if (closed) throw new Error("notification_provider_closed");
      verifyNotificationPrivateState(store);
      sidecars(lockPath);
    },
    close() {
      if (closed) return;
      closed = true;
      owners.delete(path);
      try {
        held.exec("ROLLBACK");
      } finally {
        held.close();
      }
    },
  };
}

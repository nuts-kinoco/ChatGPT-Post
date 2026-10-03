/** No Electron import or native call occurs until an explicit seal/open invocation. */
export interface NotificationSafeStoragePort {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(plaintext: string): Uint8Array;
  decryptString(ciphertext: Buffer): string;
}
export interface NotificationCipher {
  seal(plaintext: string): Uint8Array;
  open(ciphertext: Uint8Array): string;
}
const PLAINTEXT_LIMIT = 8 * 1024;
const CIPHERTEXT_LIMIT = 32 * 1024;
const LINUX_BACKENDS = new Set(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]);
function unavailable(): never { throw new Error("notification_native_storage_unavailable"); }
function validPlaintext(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= PLAINTEXT_LIMIT
    && Buffer.from(value, "utf8").toString("utf8") === value;
}
function validCiphertext(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= CIPHERTEXT_LIMIT;
}

export function createNotificationSafeStorageCipher(options: {
  getSafeStorage(): NotificationSafeStoragePort;
  isReady(): boolean;
  platform: string;
}): NotificationCipher {
  function storage(): NotificationSafeStoragePort {
    // Windows notification storage remains unavailable pending its separate verifier.
    if (!options.isReady() || !["darwin", "linux"].includes(options.platform)) return unavailable();
    const native = options.getSafeStorage();
    if (options.platform === "linux" && !LINUX_BACKENDS.has(native.getSelectedStorageBackend())) return unavailable();
    if (!native.isEncryptionAvailable()) return unavailable();
    return native;
  }
  return Object.freeze({
    seal(plaintext: string): Uint8Array {
      try {
        if (!validPlaintext(plaintext)) return unavailable();
        const ciphertext = storage().encryptString(plaintext);
        if (!validCiphertext(ciphertext)) return unavailable();
        return new Uint8Array(ciphertext);
      } catch { return unavailable(); }
    },
    open(ciphertext: Uint8Array): string {
      try {
        if (!validCiphertext(ciphertext)) return unavailable();
        const plaintext = storage().decryptString(Buffer.from(ciphertext));
        if (!validPlaintext(plaintext)) return unavailable();
        return plaintext;
      } catch { return unavailable(); }
    },
  });
}

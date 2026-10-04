/** Private metadata observation. This type provides no trust or access decision. */
export interface ArchiveWin32Entry {
  path: string;
  finalPath: string;
  /** Little-endian bytes of the 64-bit volume serial, hexadecimal. */
  volumeSerialBytes: string;
  fileId128: string;
  ownerSid: string;
  /** Complete ACL bytes, including ACE masks, flags and SIDs; hexadecimal. */
  daclHex: string;
  daclProtected: boolean;
  attributes: number;
  reparseTag: number;
  linkCount: number;
  directory: boolean;
  aceTypes: number[];
}
/** Synchronous, bounded metadata observation; throws on unknown/error/change. */
export function inspectChain(path: string): {
  schema: "archive-win32-observation-1";
  entries: ArchiveWin32Entry[];
};

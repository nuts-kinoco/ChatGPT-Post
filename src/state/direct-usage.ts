import type { BridgeResult } from "../contracts/types.js";
import type { SubmissionBinding, SubmitMarker } from "./marker.js";
/** Trusted in-process host port, never populated from request JSON. */
export interface DirectUsagePort {
  readonly scopeId: string;
  beginRun(requestId: string, requestPath: string, startedAt: string): Promise<void>;
  markerWritten(marker: SubmitMarker): Promise<void>;
  resolveNotSent(binding: SubmissionBinding, result: BridgeResult): Promise<void>;
  resultWritten(result: BridgeResult): Promise<void>;
}

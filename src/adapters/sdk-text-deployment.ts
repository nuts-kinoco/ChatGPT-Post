/** Trusted configured composition; import and catalogue never invoke query or probe authentication. */
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { syncDirectory } from "../archive/durable.js";
import { checkedDirectory } from "../archive/paths.js";
import {
  parseTextRequest,
  TEXT_BOUNDS,
  TEXT_MODEL,
  type TextRequest,
  textChallenge,
} from "../contracts/sdk-text-inference.js";
import { sha256Bytes } from "../contracts/task.js";
import { SdkTextLedger } from "../state/sdk-text-ledger.js";
import { SdkTextRequesterJournal } from "../state/sdk-text-requester-journal.js";
import {
  type ClaudeSdkHostProfile,
  cloneClaudeSdkHostProfile,
  probeClaudeSdkHost,
} from "./claude-sdk-profile.js";
import { sdkProfileDigest } from "./claude-sdk-text.js";
import type { GitHubSdkTextBus } from "./sdk-text-bus.js";
import {
  createSdkTextService,
  type SdkTextApprovalAuthority,
  type SdkTextService,
} from "./sdk-text-service.js";
export interface SdkTextDeployment {
  requesterBus: GitHubSdkTextBus;
  recipient?: SdkTextService;
  requester: SdkTextRequesterJournal;
  generate(repoId: string): {
    request: TextRequest;
    rawRequest: string;
    markdown: string;
    requestSha256: string;
    authorized: false;
  };
  preflight?(): Promise<unknown>;
  beginShutdown?(): void;
  close(): Promise<void>;
}
export function generateSdkTextRequest(
  bus: GitHubSdkTextBus,
  profile: ClaudeSdkHostProfile,
  repoId: string,
  now = new Date(),
) {
  const p = cloneClaudeSdkHostProfile(profile),
    registry = bus.bus.registry;
  if (!registry) throw new Error("text_registry_required");
  const revision = registry.currentRevision(),
    project = registry.resolve(revision, repoId),
    destination = project.githubDestination;
  if (
    !destination ||
    destination.namespace !== bus.bus.prefix ||
    destination.repositoryFullName !== bus.bus.git.destination?.repositoryFullName ||
    destination.branch !== bus.bus.git.destination?.branch
  )
    throw new Error("text_destination_mismatch");
  const requestId = randomUUID(),
    md = textChallenge(requestId);
  const request: TextRequest = {
    schema: "sdk-text-request-1",
    requestId,
    projectRegistration: {
      projectId: project.projectId,
      registryRevision: revision,
      snapshotSha256: registry.snapshotHash(revision),
    },
    repoId,
    requesterId: bus.bus.codec.signer.actorId,
    recipientId: p.recipientId,
    destination,
    provider: "claude",
    model: TEXT_MODEL,
    policySha256: p.policySha256,
    sdkProfileSha256: sdkProfileDigest(p),
    executionProfile: "official-sdk-managed",
    taskFile: "task.md",
    taskFileSha256: sha256Bytes(md),
    syntheticInput: true,
    purpose: "handshake",
    response: "echo_request_identity",
    bounds: TEXT_BOUNDS,
    modelTools: "none",
    taskFilesystem: "none",
    taskCommands: "none",
    taskNetwork: "none",
    providerNetwork: "configured_auth_route_only",
    effort: "unsupported",
    thinking: "off_requested",
    expiresAt: new Date(now.getTime() + 300000).toISOString(),
    retryPolicy: "no-automatic-reexecution",
  };
  const rawRequest = JSON.stringify(request);
  parseTextRequest(Buffer.from(rawRequest), md);
  return {
    request,
    rawRequest,
    markdown: Buffer.from(md).toString(),
    requestSha256: sha256Bytes(Buffer.from(rawRequest)),
    authorized: false as const,
  };
}
/** Application state only; never an auth/signing key store. Requires an already owned private directory. */
export async function createSdkTextDeployment(options: {
  requesterBus: GitHubSdkTextBus;
  recipientBus: GitHubSdkTextBus;
  profile: () => ClaudeSdkHostProfile;
  privateRoot: string;
  authority?: SdkTextApprovalAuthority;
}): Promise<SdkTextDeployment> {
  checkedDirectory(options.privateRoot, {}, true);
  const registry = options.requesterBus.bus.registry;
  if (!registry || options.recipientBus.bus.registry !== registry)
    throw new Error("sdk_text_registry_context_mismatch");
  const path = join(options.privateRoot, "sdk-text.db");
  if (!existsSync(path)) {
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(fd);
    syncDirectory(options.privateRoot);
  }
  const st = lstatSync(path);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.nlink !== 1 ||
    st.uid !== process.getuid?.() ||
    (st.mode & 0o077) !== 0
  )
    throw new Error("sdk_text_database_untrusted");
  const db = new DatabaseSync(path);
  let closed = false;
  let closing: Promise<void> | null = null;
  try {
    db.exec(
      "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sdk_host_identity(id INTEGER PRIMARY KEY CHECK(id=1),claimant TEXT NOT NULL);",
    );
    db.prepare("INSERT OR IGNORE INTO sdk_host_identity VALUES(1,?)").run(randomUUID());
    const claimant = String(
      db.prepare("SELECT claimant FROM sdk_host_identity WHERE id=1").get()?.claimant,
    );
    const ledger = new SdkTextLedger(db, claimant),
      requester = new SdkTextRequesterJournal(
        db,
        registry,
        options.requesterBus.bus.codec.signer.actorId,
      );
    const recipient = await createSdkTextService({
      bus: options.recipientBus,
      ledger,
      profile: options.profile,
      privateRoot: options.privateRoot,
      ...(options.authority ? { authority: options.authority } : {}),
    });
    return {
      requesterBus: options.requesterBus,
      requester,
      recipient,
      generate: (repoId) => generateSdkTextRequest(options.requesterBus, options.profile(), repoId),
      preflight: () => probeClaudeSdkHost(options.profile()),
      beginShutdown: () => recipient.beginShutdown(),
      close: async () => {
        if (closed) return;
        if (closing) return closing;
        closing = (async () => {
          await recipient.close();
          if (!closed) {
            db.close();
            closed = true;
          }
        })();
        try {
          await closing;
        } finally {
          closing = null;
        }
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

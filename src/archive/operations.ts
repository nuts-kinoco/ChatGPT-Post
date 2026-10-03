/** Reachable host operations shared by CLI and UI adapters. No implicit execution or file sharing. */
import type { BrowserDeliveryService } from "../adapters/browser-delivery.js";
import type { TaskController } from "../state/task-controller.js";
import { TaskUiService } from "../ui/service.js";
import { exportRouteDiagnostics } from "./diagnostics.js";
import { type PathPolicy, probeOutputRoot } from "./paths.js";
import type { RouteArtifactArchive } from "./route-store.js";
import { ArchiveError } from "./types.js";
export function createArchiveOperations(options: {
  archive: RouteArtifactArchive;
  local?: TaskController;
  hosted?: BrowserDeliveryService;
  pathPolicy?: PathPolicy;
}) {
  return {
    inspect: (requestId: string, manifestSha256?: string) =>
      options.archive.inspect(requestId, manifestSha256),
    probe: (root: string) => probeOutputRoot(root, options.pathPolicy),
    async collect(requestId: string) {
      const admission = options.archive.admission(requestId);
      if (admission.route.kind === "local_execution") {
        if (!options.local?.artifactArchive) throw new ArchiveError("archive_local_unconfigured");
        return options.local.archiveResult(requestId);
      }
      if (!options.hosted) throw new ArchiveError("archive_hosted_unconfigured");
      return options.hosted.archiveResult(requestId);
    },
    exportDiagnostics(requestId: string) {
      const admission = options.archive.admission(requestId),
        inspection = options.archive.inspect(requestId);
      if (admission.route.kind === "local_execution") {
        const controller = options.local;
        if (!controller) throw new ArchiveError("archive_local_unconfigured");
        const service = new TaskUiService(
          { store: controller.store, controller },
          { profile: controller.executor.synthetic ? "demo" : "production" },
        );
        return service.exportDiagnostics(requestId);
      }
      const service = options.hosted,
        job = service?.get(requestId);
      if (!service || !job) throw new ArchiveError("archive_hosted_unconfigured");
      const stages = service.observations(requestId).map((o) => ({
        stage: "execution",
        state: "unknown",
        sequence: o.revision,
        observedAt: o.result.completedAt,
      }));
      if (job.response)
        stages.push({
          stage: "result",
          state: "observed",
          sequence: job.revision,
          observedAt: job.response.result.completedAt,
        });
      return exportRouteDiagnostics(
        {
          hosted: {
            requestId,
            taskSpecHash: job.issued.taskSpecHash,
            attemptId: job.attemptId,
            revision: job.revision,
            state: job.state,
            source: job.source?.state === "available" ? job.source.provenance : null,
            inventory: job.source?.state === "available" ? job.source.artifactInventory : null,
            payloadAcknowledged: job.payloadAcknowledged,
            fullDeliverySufficient: job.acknowledged,
            stages,
            bridgeVersion: service.config.bridgeVersion,
            nodeVersion: process.version,
            platform: process.platform,
          },
          manifest: inspection.manifest,
          archiveState: inspection.state,
          materialization: job.materialization
            ? {
                state: "complete",
                payloadVerification: job.materialization.payloadVerification,
                synthetic: job.materialization.synthetic,
              }
            : { state: "not_checked" },
        },
        { userAction: "export_sanitized_diagnostics" },
      );
    },
  };
}
export type ArchiveOperations = ReturnType<typeof createArchiveOperations>;

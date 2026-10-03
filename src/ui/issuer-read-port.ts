/** One read-only entry used by the configured CLI and manual composer. No issue/import/start. */
import type { OperationsSetup } from "../contracts/operations.js";
import type { HostedExpectedOutputPolicy } from "../contracts/output-contract.js";

import type { TaskSpec } from "../contracts/task-types.js";
import { UiError } from "../contracts/ui.js";
import {
  destinationFingerprint,
  prepareTaskRecipe,
  type UiComposerPort,
  validatePreparedRecipe,
} from "./composer.js";
import type { UiOperationsService } from "./operations.js";
export interface IssuerTemplate {
  version: "bridge-issuer-template-1";
  templateOnly: true;
  executable: false;
  projectId: string;
  destinationId: string;
  registryRevision: number;
  registrySha256: string;
  modelId: string;
  taskSpecTemplate: Omit<TaskSpec, "request_id" | "task_file_hash">;
  missingInputs: readonly ["request_id", "task_markdown", "task_file_hash"];
  outputPolicy:
    | { state: "available"; value: HostedExpectedOutputPolicy }
    | { state: "unavailable"; reason: string };
}
export interface IssuerReadPort {
  catalogue(): Promise<OperationsSetup>;
  template(projectId: string, destinationId: string, modelId?: string): Promise<IssuerTemplate>;
}
export function issuerReadPort(
  operations: UiOperationsService,
  recipe: UiComposerPort | undefined,
): IssuerReadPort {
  return {
    catalogue: () => operations.setup(),
    async template(projectId, destinationId, modelId) {
      if (!recipe)
        throw new UiError(
          "issuer_template_unavailable",
          "Trusted task recipe is unconfigured",
          409,
        );
      const setup = await operations.setup(),
        registry = operations.sources.registry;
      if (
        !registry ||
        setup.registry.state !== "available" ||
        setup.destinations.state !== "available"
      )
        throw new UiError(
          "issuer_catalogue_unavailable",
          "Registered project/destination catalogue is unavailable",
          409,
        );
      const revision = setup.registry.value.revision;
      const project = registry
        .snapshot(revision)
        .projects.find((value) => value.projectId === projectId);
      const destination = setup.destinations.value.find(
        (value) => value.destinationId === destinationId,
      );
      if (!project || !destination || destination.unavailableReason)
        throw new UiError(
          "issuer_destination_unavailable",
          "Registered project or destination is unavailable",
          409,
        );
      if (!modelId && destination.modelIds.length !== 1)
        throw new UiError("issuer_model_required", "Choose an explicit registered model", 400);
      const selected = modelId ?? destination.modelIds[0];
      if (!selected || !destination.modelIds.includes(selected))
        throw new UiError(
          "issuer_model_denied",
          "Model is not registered for this destination",
          400,
        );
      // Reserved template marker is stripped; it is never registered, persisted, signed or issued.
      const requestId = "00000000-0000-4000-8000-000000000000";
      const prepared = await prepareTaskRecipe(recipe, {
        requestId,
        project: structuredClone(project),
        destination: structuredClone(destination),
        modelId: selected,
        title: "TEMPLATE ONLY",
        instruction: "Replace with the explicit task Markdown before calculating its digest",
      });
      const task = validatePreparedRecipe(prepared, {
        requestId,
        project,
        destination,
        modelId: selected,
        title: "TEMPLATE ONLY",
        instruction: "Replace with the explicit task Markdown before calculating its digest",
      });
      const after = await operations.setup();
      const current =
        after.destinations.state === "available"
          ? after.destinations.value.find((value) => value.destinationId === destinationId)
          : null;
      if (
        !current ||
        current.unavailableReason ||
        destinationFingerprint(current) !== destinationFingerprint(destination)
      )
        throw new UiError(
          "issuer_destination_stale",
          "Destination policy or model changed while reading the template",
          409,
        );
      if (registry.currentRevision() !== revision)
        throw new UiError(
          "issuer_registry_stale",
          "Registry changed while reading the template",
          409,
        );
      const { request_id: _id, task_file_hash: _hash, ...taskSpecTemplate } = task;
      return {
        version: "bridge-issuer-template-1",
        templateOnly: true,
        executable: false,
        projectId,
        destinationId,
        registryRevision: revision,
        registrySha256: setup.registry.value.snapshotSha256,
        modelId: selected,
        taskSpecTemplate,
        missingInputs: ["request_id", "task_markdown", "task_file_hash"],
        outputPolicy: prepared.outputPolicy
          ? { state: "available", value: structuredClone(prepared.outputPolicy) }
          : {
              state: "unavailable",
              reason:
                destination.route === "ordinary_chat_browser"
                  ? "trusted_output_policy_unconfigured"
                  : "not_a_hosted_delivery",
            },
      };
    },
  };
}

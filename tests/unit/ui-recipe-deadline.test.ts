import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegisteredOperationDestination } from "../../src/contracts/operations.js";
import { sha256Bytes } from "../../src/contracts/task.js";
import type { TaskSpec } from "../../src/contracts/task-types.js";
import {
  type ComposerRecipeInput,
  manualTaskTemplate,
  prepareTaskRecipe,
  UiComposer,
  type UiComposerPort,
} from "../../src/ui/composer.js";
import { issuerReadPort } from "../../src/ui/issuer-read-port.js";
import { UiOperationsService } from "../../src/ui/operations.js";
import { adapterTask } from "../helpers/adapter-fixture.js";
import { fixtureProjectRegistry } from "../helpers/output-contract-fixture.js";

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
function deferred<T>() {
  let resolve = (_value: T) => {
    throw new Error("not initialized");
  };
  let reject = (_reason: unknown) => {
    throw new Error("not initialized");
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const template = adapterTask();
  const project = fixtureProjectRegistry.resolve(1, template.repo);
  const destination: RegisteredOperationDestination = {
    destinationId: "fixture-cli",
    route: "cli",
    recipientActorId: "recipient",
    providerId: template.agent,
    modelIds: [template.requested_model],
    capabilities: {},
    unavailableReason: null,
    policyHash: template.policy_snapshot_sha256,
  };
  const operations = new UiOperationsService({
    registry: fixtureProjectRegistry,
    destinations: () => [destination],
  });
  const basePrepare = manualTaskTemplate(template);
  const issue = vi.fn(async () => ({ commit: "a".repeat(40) }));
  const port: UiComposerPort = { prepare: basePrepare, issue, prepareTimeoutMs: 25 };
  const composer = new UiComposer(operations, port);
  const reads = issuerReadPort(operations, port);
  const body = {
    registryRevision: 1,
    projectId: project.projectId,
    destinations: [{ destinationId: destination.destinationId, modelId: template.requested_model }],
    title: "Synthetic recipe",
    instruction: "No model, browser or real transport is invoked",
  };
  const input: ComposerRecipeInput = {
    requestId: "a2345678-1234-4234-8234-123456789abc",
    project,
    destination,
    modelId: template.requested_model,
    title: body.title,
    instruction: body.instruction,
  };
  vi.mocked(randomUUID).mockClear();
  return {
    template,
    project,
    destination,
    operations,
    basePrepare,
    issue,
    port,
    composer,
    reads,
    body,
    input,
  };
}
type Fixture = ReturnType<typeof fixture>;
function invoke(f: Fixture, route: "preview" | "template") {
  return route === "preview"
    ? f.composer.preview(f.body)
    : f.reads.template(f.project.projectId, f.destination.destinationId, f.input.modelId);
}
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("shared pure recipe deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it.each(["preview", "template"] as const)(
    "bounds a never-resolving %s recipe without issuance or a retry",
    async (route) => {
      const f = fixture();
      f.port.prepare = vi.fn(() => new Promise(() => {}));
      const outcome = invoke(f, route).catch((error) => error);
      await flush();
      expect(f.port.prepare).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(24);
      expect(f.issue).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatchObject({ code: "composer_recipe_timeout", status: 504 });
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.port.prepare).toHaveBeenCalledTimes(1);
      expect(f.issue).not.toHaveBeenCalled();
      expect(randomUUID).toHaveBeenCalledTimes(route === "preview" ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("defaults to exactly 1000 ms and clears a settled deadline timer", async () => {
    const f = fixture();
    delete f.port.prepareTimeoutMs;
    f.port.prepare = vi.fn(() => new Promise(() => {}));
    let settled = false;
    const outcome = prepareTaskRecipe(f.port, f.input).catch((error) => {
      settled = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ code: "composer_recipe_timeout" });
    expect(vi.getTimerCount()).toBe(0);
    f.port.prepare = f.basePrepare;
    expect(await prepareTaskRecipe(f.port, f.input)).toEqual(f.basePrepare(f.input));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, 5000])(
    "accepts the finite %i ms boundary without timing out early",
    async (deadline) => {
      const f = fixture();
      f.port.prepareTimeoutMs = deadline;
      f.port.prepare = () => new Promise(() => {});
      let settled = false;
      const outcome = prepareTaskRecipe(f.port, f.input).catch((error) => {
        settled = true;
        return error;
      });
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toMatchObject({ code: "composer_recipe_timeout" });
    },
  );

  it.each([0, -1, 1.5, 5001, Number.NaN, Number.POSITIVE_INFINITY, "1000", false, null])(
    "rejects invalid trusted deadline %s before calling prepare",
    async (deadline) => {
      const f = fixture();
      const prepare = vi.fn(f.basePrepare);
      const port = { prepare, issue: f.issue, prepareTimeoutMs: deadline } as UiComposerPort;
      await expect(prepareTaskRecipe(port, f.input)).rejects.toMatchObject({
        code: "composer_recipe_timeout_invalid",
        status: 500,
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(f.issue).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["preview", "template"] as const)(
    "uses the same deadline validation in %s",
    async (route) => {
      const f = fixture();
      f.port.prepareTimeoutMs = 0;
      f.port.prepare = vi.fn(f.basePrepare);
      await expect(invoke(f, route)).rejects.toMatchObject({
        code: "composer_recipe_timeout_invalid",
      });
      expect(f.port.prepare).not.toHaveBeenCalled();
      expect(f.issue).not.toHaveBeenCalled();
    },
  );

  it("discards a late preview result without issue, cache entry or automatic UUID regeneration", async () => {
    const f = fixture();
    const late = deferred<ReturnType<Fixture["basePrepare"]>>();
    let received: ComposerRecipeInput | null = null;
    f.port.prepare = vi.fn((input) => {
      received = input;
      return late.promise;
    });
    const outcome = f.composer.preview(f.body).catch((error) => error);
    await flush();
    await vi.advanceTimersByTimeAsync(25);
    expect(await outcome).toMatchObject({ code: "composer_recipe_timeout" });
    if (!received) throw new Error("recipe input missing");
    const original = received as ComposerRecipeInput;
    late.resolve(f.basePrepare(original));
    await flush();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.port.prepare).toHaveBeenCalledTimes(1);
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(f.issue).not.toHaveBeenCalled();
    await expect(
      f.composer.issue({ previewId: original.requestId, previewSha256: "a".repeat(64) }),
    ).rejects.toMatchObject({ code: "composer_preview_mismatch" });
    // Exactly 64 explicit successful previews still fit: the rejected late result occupied no slot.
    f.port.prepare = f.basePrepare;
    for (let i = 0; i < 64; i++) {
      const preview = await f.composer.preview(f.body);
      expect(preview.children[0]?.requestId).not.toBe(original.requestId);
    }
    await expect(f.composer.preview(f.body)).rejects.toMatchObject({ code: "composer_capacity" });
    expect(f.issue).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "discards late template %s without issue or generated request UUID",
    async (settlement) => {
      const f = fixture();
      const late = deferred<ReturnType<Fixture["basePrepare"]>>();
      let received: ComposerRecipeInput | null = null;
      f.port.prepare = vi.fn((input) => {
        received = input;
        return late.promise;
      });
      const outcome = f.reads
        .template(f.project.projectId, f.destination.destinationId)
        .catch((error) => error);
      await flush();
      await vi.advanceTimersByTimeAsync(25);
      expect(await outcome).toMatchObject({ code: "composer_recipe_timeout" });
      if (settlement === "reject") late.reject(new Error("late pure failure"));
      else {
        if (!received) throw new Error("template recipe input missing");
        late.resolve(f.basePrepare(received));
      }
      await flush();
      expect(f.issue).not.toHaveBeenCalled();
      expect(randomUUID).not.toHaveBeenCalled();
      expect(f.port.prepare).toHaveBeenCalledTimes(1);
      f.port.prepare = f.basePrepare;
      const template = await f.reads.template(f.project.projectId, f.destination.destinationId);
      expect(template).toMatchObject({
        templateOnly: true,
        executable: false,
        missingInputs: ["request_id", "task_markdown", "task_file_hash"],
      });
      expect(template.taskSpecTemplate).not.toHaveProperty("request_id");
      expect(template.taskSpecTemplate).not.toHaveProperty("task_file_hash");
      expect(randomUUID).not.toHaveBeenCalled();
    },
  );

  it("stops preparing remaining fanout children after the first deadline without automatic regeneration", async () => {
    const f = fixture();
    const late = deferred<ReturnType<Fixture["basePrepare"]>>();
    const destinations = [f.destination, { ...f.destination, destinationId: "second-cli" }];
    const operations = new UiOperationsService({
      registry: fixtureProjectRegistry,
      destinations: () => destinations,
    });
    let received: ComposerRecipeInput | null = null;
    f.port.prepare = vi.fn((input) => {
      received = input;
      return late.promise;
    });
    const composer = new UiComposer(operations, f.port);
    const outcome = composer
      .preview({
        ...f.body,
        destinations: destinations.map((destination) => ({
          destinationId: destination.destinationId,
          modelId: f.input.modelId,
        })),
      })
      .catch((error) => error);
    await flush();
    await vi.advanceTimersByTimeAsync(25);
    expect(await outcome).toMatchObject({ code: "composer_recipe_timeout" });
    if (!received) throw new Error("recipe input missing");
    late.resolve(f.basePrepare(received));
    await flush();
    expect(f.port.prepare).toHaveBeenCalledTimes(1);
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(f.issue).not.toHaveBeenCalled();
  });

  const corruptions: [string, (task: TaskSpec, prepared: { taskMarkdown: string }) => void][] = [
    [
      "request UUID",
      (task) => {
        task.request_id = "b2345678-1234-4234-8234-123456789abc";
      },
    ],
    [
      "registered repo",
      (task) => {
        task.repo = "another-repo";
      },
    ],
    [
      "registered provider",
      (task) => {
        task.agent = "another-agent";
      },
    ],
    [
      "exact model",
      (task) => {
        task.requested_model = "another-model";
      },
    ],
    [
      "policy hash",
      (task) => {
        task.policy_snapshot_sha256 = "f".repeat(64);
      },
    ],
    [
      "raw Markdown hash",
      (_task, prepared) => {
        prepared.taskMarkdown += "\nchanged";
      },
    ],
    [
      "fixture execution mode",
      (task) => {
        task.mode = "design_fixture";
      },
    ],
  ];
  it.each(corruptions)(
    "shares exact %s recipe validation between template and preview",
    async (_name, corrupt) => {
      for (const route of ["preview", "template"] as const) {
        const f = fixture();
        f.port.prepare = (input) => {
          const prepared = f.basePrepare(input),
            task = JSON.parse(prepared.rawSpec) as TaskSpec;
          corrupt(task, prepared);
          return { ...prepared, rawSpec: JSON.stringify(task) };
        };
        await expect(invoke(f, route)).rejects.toMatchObject({
          code: "composer_recipe_invalid",
          status: 409,
        });
        expect(f.issue).not.toHaveBeenCalled();
      }
    },
  );

  it("accepts the same validated recipe without persisting or issuing a template", async () => {
    const f = fixture();
    const preview = await f.composer.preview(f.body);
    const template = await f.reads.template(f.project.projectId, f.destination.destinationId);
    const child = preview.children[0];
    if (!child) throw new Error("preview child missing");
    const {
      request_id: _request,
      task_file_hash: _markdown,
      ...shape
    } = JSON.parse(child.rawSpec) as TaskSpec;
    expect(template.taskSpecTemplate).toEqual(shape);
    expect(sha256Bytes(Buffer.from(child.taskMarkdown))).toBe(child.taskFileHash);
    expect(f.issue).not.toHaveBeenCalled();
  });
});

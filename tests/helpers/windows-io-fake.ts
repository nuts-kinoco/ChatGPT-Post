/** In-memory symbolic adapter: deliberately no filesystem, DB, native or SDK imports. */
import {
  advanceWindowsIoModel,
  type ModelAnchor,
  type ModelBound,
  type ModelCommand,
  type ModelFacts,
  type ModelPlan,
  type ModelReply,
  type ModelState,
  type RecoveryEvidence,
} from "../../src/archive/windows-io-model.js";

export function facts(id: number, path: string, file = false, size = 0): ModelFacts {
  return {
    volume: "1".repeat(16),
    id: id.toString(16).padStart(32, "0"),
    kind: file ? "file" : "directory",
    ownerHash: "2".repeat(64),
    daclHash: "3".repeat(64),
    links: 1,
    reparse: 0,
    deletePending: false,
    attributes: file ? 0x80 : 0x10,
    size: file ? size : null,
    path,
  };
}
export function plan(verb: ModelPlan["verb"] = "publish-directory"): ModelPlan {
  const paths = [
    "C:\\",
    "C:\\archive",
    ...(verb === "read-file" ? ["C:\\archive\\result.txt"] : []),
  ];
  const anchors: ModelAnchor[] = paths.map((path, i) => ({
    component: i === 0 ? path : path.slice(path.lastIndexOf("\\") + 1),
    facts: facts(i + 1, path, i === 2, 3),
    provenance: "independent",
    record: Symbol("expected"),
  }));
  return {
    mode: "fake-contract-model",
    verb,
    anchors,
    acquisitionPath: paths.at(-1) ?? "",
    files: [
      {
        name: "result.txt",
        bytes: [1, 2, 3],
        initialAttributes: 0x80,
        finalAttributes: 0x20,
      },
    ],
    stage: "staging-unique",
    destination: "published",
    createdSecurity: { ownerHash: "2".repeat(64), daclHash: "3".repeat(64) },
    capabilities: {
      relativeSingleComponent: true,
      continuousChildren: true,
      rootRelativeNoReplace: true,
      fileAndDirectoryDurability: true,
      id128: true,
    },
  };
}
export function recovery(overrides: Partial<RecoveryEvidence> = {}): RecoveryEvidence {
  return {
    destination: "verified-content",
    staging: "none",
    dbCommitted: true,
    fullChainIndependent: true,
    fileAndDirectoryDurable: true,
    destinationPath: "C:\\archive",
    requiredFiles: ["result.txt"],
    currentChain: plan("read-file").anchors.map((expected) => ({
      expected,
      observed: {
        ref: Symbol("retained"),
        observation: Symbol("observed"),
        facts: { ...expected.facts },
        created: false,
      },
    })),
    ...overrides,
  };
}
export function observations(
  s: ModelState,
  final: boolean,
  renamed = s.published,
): NonNullable<ModelReply["observations"]> {
  return s.bound.map((b) => {
    const f = b.fileIndex === undefined ? undefined : s.plan.files[b.fileIndex];
    const prefix = `${s.plan.acquisitionPath}\\${s.plan.stage}`;
    return {
      ref: b.ref,
      facts: {
        ...b.facts,
        size: f && final ? f.bytes.length : b.facts.size,
        attributes: f && final ? f.finalAttributes : b.facts.attributes,
        path:
          renamed && b.created
            ? `${s.plan.acquisitionPath}\\${s.plan.destination}${b.facts.path.slice(prefix.length)}`
            : b.facts.path,
      },
    };
  });
}
export class WindowsIoFake {
  readonly commands: ModelCommand[] = [];
  chunk = 2;
  recoveryEvidence: RecoveryEvidence | undefined;
  reply(s: ModelState): ModelReply {
    const c = s.pending;
    if (!c) throw new Error("fake has no pending command");
    this.commands.push(c);
    const policy = (bound: readonly ModelBound[]) => ({
      status: "candidate" as const,
      operation: s.operation,
      references: bound.map((b) => b.ref),
    });
    const base = {
      operation: s.operation,
      done: true,
      ...(c.target ? { ioReference: c.target } : {}),
    };
    switch (c.kind) {
      case "acquire": {
        const bound = s.plan.anchors.map((a) => ({
          ref: Symbol("retained"),
          facts: { ...a.facts },
          observation: Symbol("observed"),
          created: false,
        }));
        return { ...base, bound, policy: policy(bound) };
      }
      case "create-stage":
      case "create-file": {
        const directory = c.kind === "create-stage";
        const file = s.plan.files[s.fileIndex];
        const parent =
          s.plan.acquisitionPath +
          (!directory && s.plan.verb === "publish-directory" ? `\\${s.plan.stage}` : "");
        const bound: ModelBound = {
          ref: Symbol("created"),
          observation: Symbol("create-observed"),
          created: true,
          facts: {
            ...facts(10 + s.bound.length, `${parent}\\${c.component}`, !directory),
            attributes: directory ? 0x10 : (file?.initialAttributes ?? 0x80),
          },
          ...(!directory ? { fileIndex: s.fileIndex } : {}),
        };
        return { ...base, bound: [bound], policy: policy([...s.bound, bound]) };
      }
      case "C1":
      case "C2-read":
      case "C2-create":
      case "C3":
        return {
          ...base,
          policy: policy(s.bound),
          observations: observations(s, c.kind === "C2-create" || c.kind === "C3", c.kind === "C3"),
        };
      case "write":
        return { ...base, written: Math.min(this.chunk, c.length) };
      case "read":
        return {
          ...base,
          bytes: s.plan.files[0]?.bytes.slice(c.offset, c.offset + this.chunk) ?? [],
        };
      case "eof":
        return { ...base, eof: true };
      case "readback":
        return { ...base, bytes: [...(s.plan.files[s.fileIndex]?.bytes ?? [])] };
      case "published-content":
        return {
          ...base,
          contents: s.plan.files.map((f) => [...f.bytes]),
          contentReferences: s.plan.files.map(
            (_, i) => s.bound.find((b) => b.created && b.fileIndex === i)?.ref ?? Symbol("missing"),
          ),
        };
      case "close":
        return { ...base, closedReferences: s.bound.map((b) => b.ref) };
      case "scan": {
        const evidence = this.recoveryEvidence ?? scanRecovery(s);
        return {
          ...base,
          recovery: evidence,
          bound: evidence.currentChain.slice(s.bound.length).map((item) => item.observed),
          policy: policy(evidence.currentChain.map((item) => item.observed)),
        };
      }
      default:
        return base;
    }
  }
  step(s: ModelState, change: (r: ModelReply) => ModelReply = (r) => r): ModelState {
    const request = s.pending?.request;
    if (request === undefined) throw new Error("fake has no pending command");
    return advanceWindowsIoModel(s, { type: "settled", request, reply: change(this.reply(s)) });
  }
  until(s: ModelState, phase?: ModelState["phase"]): ModelState {
    for (let i = 0; i < 1_000 && s.pending && s.phase !== phase; i++) s = this.step(s);
    if (s.pending && s.phase !== phase) throw new Error("fake exceeded bounded steps");
    return s;
  }
}

/** A valid scan fixture preserves acquired ancestor records and references. */
export function scanRecovery(s: ModelState): RecoveryEvidence {
  const destinationPath = `${s.plan.acquisitionPath}\\${s.plan.destination}`;
  const currentChain = s.plan.anchors.map((expected, i) => {
    const observed = s.bound[i];
    if (!observed) throw new Error("scan fixture requires acquired ancestors");
    return { expected, observed };
  });
  const paths = [
    destinationPath,
    ...s.plan.files.map((file) => `${destinationPath}\\${file.name}`),
  ];
  for (const [i, path] of paths.entries()) {
    const f = facts(1000 + i, path, i > 0, i > 0 ? (s.plan.files[i - 1]?.bytes.length ?? 0) : 0);
    currentChain.push({
      expected: {
        component: path.slice(path.lastIndexOf("\\") + 1),
        facts: f,
        provenance: "independent",
        record: Symbol("scan-anchor"),
      },
      observed: {
        ref: Symbol("scan-retained"),
        observation: Symbol("scan-observed"),
        facts: { ...f },
        created: false,
      },
    });
  }
  return recovery({
    destinationPath,
    requiredFiles: s.plan.files.map((file) => file.name),
    currentChain,
  });
}

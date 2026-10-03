import { generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ArtifactDeclarationExpectationV1,
  type ArtifactDeclarationV1,
  type HostedExpectedOutputPolicy,
  MAX_ARTIFACT_DECLARATION_BYTES,
  MAX_OUTPUT_CONTRACT_BYTES,
  MAX_OUTPUT_FILE_BYTES,
  MAX_OUTPUT_TOTAL_BYTES,
  type OutputContractBindingV1,
  type OutputContractV1,
  outputContractDigest,
  parseArtifactDeclarationV1,
  parseOutputContractV1,
  validateOutputContractPolicy,
} from "../../src/contracts/output-contract.js";
import { encodeResponseFrame } from "../../src/contracts/response-frame.js";
import { sha256Bytes } from "../../src/contracts/task.js";

const requestId = "10000000-0000-4000-8000-000000000001";
const attemptId = "20000000-0000-4000-8000-000000000002";
const projectId = "30000000-0000-4000-8000-000000000003";
const otherId = "40000000-0000-4000-8000-000000000004";
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
function binding(): OutputContractBindingV1 {
  return {
    requestId,
    taskSpecHash: "a".repeat(64),
    taskFileHash: "b".repeat(64),
    route: "hosted_delivery",
    requesterActorId: "requester",
    recipientActorId: "recipient",
    policySnapshotSha256: "c".repeat(64),
    registryRevision: 4,
    registrySnapshotSha256: "d".repeat(64),
    projectId,
    repoId: "example",
    storageSlug: "example-project",
    destination: {
      repositoryFullName: "example/bridge",
      branch: "main",
      namespace: "bridge-tasks",
      conversationId: "conversation-1",
    },
  };
}
function contract(artifacts = false): OutputContractV1 {
  return {
    ...binding(),
    schema: "output-contract-1",
    mode: artifacts ? "declared_artifacts" : "text_only",
    requiredOutputs: artifacts
      ? [{ logicalName: "report", mediaType: "text/plain", maxBytes: 100 }]
      : [],
    allowAdditionalArtifacts: false,
    maxArtifacts: artifacts ? 1 : 0,
    maxTotalBytes: artifacts ? 100 : 0,
    declarationFormat: "bridge-artifact-declaration-1",
  };
}
// This fixture is the recipient's independently authorized reusable scope, not remote data.
function policy(artifacts = false): HostedExpectedOutputPolicy {
  return {
    route: "hosted_delivery",
    requesterActorId: "requester",
    recipientActorId: "recipient",
    projectId,
    repoId: "example",
    storageSlug: "example-project",
    destination: {
      repositoryFullName: "example/bridge",
      branch: "main",
      namespace: "bridge-tasks",
      conversationId: "conversation-1",
    },
    mode: artifacts ? "declared_artifacts" : "text_only",
    requiredOutputs: artifacts
      ? [{ logicalName: "report", mediaType: "text/plain", maxBytes: 100 }]
      : [],
    allowAdditionalArtifacts: false,
    maxArtifacts: artifacts ? 1 : 0,
    maxTotalBytes: artifacts ? 100 : 0,
  };
}
function expected(value = contract()): ArtifactDeclarationExpectationV1 {
  return {
    contract: value,
    outputContractSha256: outputContractDigest(bytes(value)),
    frame: { requestId, taskSpecHash: "a".repeat(64), attemptId },
  };
}
function declaration(exp = expected()): ArtifactDeclarationV1 {
  return {
    schema: "artifact-declaration-1",
    requestId: exp.frame.requestId,
    taskSpecHash: exp.frame.taskSpecHash,
    attemptId: exp.frame.attemptId,
    outputContractSha256: exp.outputContractSha256,
    outputs: exp.contract.requiredOutputs.map((item) => ({
      logicalName: item.logicalName,
      mediaType: item.mediaType,
      filename: `${item.logicalName}.txt`,
      contentSha256: sha256Bytes(Buffer.from("hello")),
      sizeBytes: 5,
    })),
  };
}
function declaredOutput(value: ArtifactDeclarationV1, index = 0) {
  const output = value.outputs[index];
  if (!output) throw new Error("Test fixture has no expected declaration output");
  return output;
}
const line = (value: unknown) => `BRIDGE ARTIFACT DECLARATION ${JSON.stringify(value)}`;
function framed(value: unknown, exp = expected(), answer = "The answer") {
  return encodeResponseFrame(`${line(value)}\n${answer}`, exp.frame);
}

describe("output-contract-1 strict raw-byte codec", () => {
  it.each([false, true])("accepts bounded explicit contracts, artifacts=%s", (artifacts) => {
    const value = contract(artifacts);
    expect(parseOutputContractV1(bytes(value))).toEqual(value);
    expect(outputContractDigest(bytes(value))).toBe(sha256Bytes(bytes(value)));
  });
  it("hashes the exact body including whitespace and member order", () => {
    const one = bytes(contract());
    const two = Buffer.from(` \n${JSON.stringify(contract(), null, 2)}\t\n`);
    expect(parseOutputContractV1(one)).toEqual(parseOutputContractV1(two));
    expect(outputContractDigest(one)).not.toBe(outputContractDigest(two));
    expect(outputContractDigest(two)).toBe(sha256Bytes(two));
  });
  it.each([{ schema: "output-contract-2" }, { schema: undefined }])(
    "blocks unknown or missing versions %j",
    (change) => {
      expect(() => parseOutputContractV1(bytes({ ...contract(), ...change }))).toThrow(
        "unknown_contract",
      );
    },
  );
  it.each([
    { route: "cli" },
    { route: "local_execution" },
    { route: "ordinary_chat_browser" },
    { route: undefined },
    { taskFileHash: undefined },
    { attemptId },
    { runId: otherId },
    { issuedDocumentSha256: "e".repeat(64) },
    { outputContractSha256: "e".repeat(64) },
    { mode: "best_effort" },
    { declarationFormat: "artifact-declaration-1" },
    { allowAdditionalArtifacts: true },
    { maxArtifacts: 1 },
    { maxTotalBytes: 1 },
    { requesterActorId: "requester\n" },
    { recipientActorId: "https://example.test" },
    { taskSpecHash: `${"a".repeat(64)}\n` },
    { requestId: `${requestId}\n` },
    { taskFileHash: "A".repeat(64) },
    { registryRevision: 0 },
    { registryRevision: Number.MAX_SAFE_INTEGER + 1 },
    { registryRevision: 1.5 },
    { projectId: "unknown" },
    { storageSlug: "../escape" },
    { storageSlug: "CON" },
    { requiredOutputs: null },
  ])("rejects unsupported schema/binding fields %j", (change) => {
    expect(() => parseOutputContractV1(bytes({ ...contract(), ...change }))).toThrow();
  });
  it.each([
    { repositoryFullName: "https://github.com/example/bridge" },
    { repositoryFullName: "example/../bridge" },
    { repositoryFullName: "example/.." },
    { branch: "main\n" },
    { branch: "main//other" },
    { branch: "/main" },
    { namespace: "../other" },
    { conversationId: "https://chatgpt.com/c/other" },
    { conversationId: "conversation-1\n" },
    { extra: "forbidden" },
  ])("rejects malformed or expanding destinations %j", (change) => {
    expect(() =>
      parseOutputContractV1(
        bytes({ ...contract(), destination: { ...binding().destination, ...change } }),
      ),
    ).toThrow();
  });
  it.each([
    { requiredOutputs: [] },
    { maxArtifacts: 0 },
    { maxArtifacts: 65 },
    { maxArtifacts: 1.1 },
    { maxTotalBytes: MAX_OUTPUT_TOTAL_BYTES + 1 },
    { maxTotalBytes: -1 },
    {
      requiredOutputs: [
        { logicalName: "report", mediaType: "text/plain", maxBytes: MAX_OUTPUT_FILE_BYTES + 1 },
      ],
    },
    { requiredOutputs: [{ logicalName: "../report", mediaType: "text/plain", maxBytes: 10 }] },
    { requiredOutputs: [{ logicalName: "report", mediaType: "text/*", maxBytes: 10 }] },
    {
      requiredOutputs: [
        { logicalName: "report", mediaType: "text/plain; charset=utf-8", maxBytes: 10 },
      ],
    },
    {
      requiredOutputs: [
        { logicalName: "report", mediaType: "text/plain", maxBytes: 10, required: false },
      ],
    },
    {
      requiredOutputs: [
        { logicalName: "report", mediaType: "text/plain", maxBytes: 10 },
        { logicalName: "report", mediaType: "text/plain", maxBytes: 10 },
      ],
      maxArtifacts: 2,
    },
  ])("rejects unbounded or ambiguous artifact contracts %j", (change) => {
    expect(() => parseOutputContractV1(bytes({ ...contract(true), ...change }))).toThrow();
  });
  it("enforces strict UTF-8, BOM, duplicate-key, safe-number and body-size checks", () => {
    const json = JSON.stringify(contract());
    const bad = [
      Buffer.from([0xff, 0xfe]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(contract())]),
      Buffer.from(json.replace('"schema":', '"schema":"output-contract-1","schema":')),
      Buffer.from(
        json.replace(
          '"conversationId":',
          '"conversation\\u0049d":"conversation-1","conversationId":',
        ),
      ),
      Buffer.from(json.replace('"registryRevision":4', '"registryRevision":1e309')),
      Buffer.from(json.replace('"repoId":"example"', '"repoId":"\\ud800"')),
      Buffer.alloc(MAX_OUTPUT_CONTRACT_BYTES + 1, 32),
      Buffer.alloc(0),
    ];
    for (const raw of bad) expect(() => parseOutputContractV1(raw)).toThrow();
  });
});

describe("trusted preexisting expected-output scope", () => {
  it("accepts trusted exact binding and narrower per-item/aggregate bounds", () => {
    const value = {
      ...contract(true),
      maxTotalBytes: 80,
      requiredOutputs: [{ logicalName: "report", mediaType: "text/plain", maxBytes: 80 }],
    };
    expect(validateOutputContractPolicy(value, policy(true), binding())).toBeUndefined();
    expect(validateOutputContractPolicy(contract(), policy(), binding())).toBeUndefined();
  });
  it("keeps storage revisions outside policy authority and validates historical refs independently", () => {
    const value = { ...contract(), registryRevision: 5, registrySnapshotSha256: "e".repeat(64) };
    expect(() => validateOutputContractPolicy(value, policy(), binding())).toThrow(
      "output_contract_binding_mismatch",
    );
    expect(
      validateOutputContractPolicy(value, policy(), {
        ...binding(),
        registryRevision: 5,
        registrySnapshotSha256: "e".repeat(64),
      }),
    ).toBeUndefined();
    expect(policy()).not.toHaveProperty("registryRevision");
    expect(policy()).not.toHaveProperty("outputContractSha256");
    expect(policy()).not.toHaveProperty("taskSpecHash");
    expect(policy()).not.toHaveProperty("policySnapshotSha256");
  });
  it.each([
    ["requestId", otherId],
    ["taskSpecHash", "f".repeat(64)],
    ["taskFileHash", "f".repeat(64)],
    ["policySnapshotSha256", "f".repeat(64)],
    ["registryRevision", 5],
    ["registrySnapshotSha256", "f".repeat(64)],
    ["projectId", otherId],
    ["repoId", "elsewhere"],
    ["storageSlug", "elsewhere"],
    ["requesterActorId", "stranger"],
    ["recipientActorId", "stranger"],
  ])("rejects independently mismatched %s", (field, other) => {
    expect(() =>
      validateOutputContractPolicy({ ...contract(), [field]: other }, policy(), binding()),
    ).toThrow("output_contract_binding_mismatch");
  });
  it.each(["requesterActorId", "recipientActorId", "repoId", "storageSlug"] as const)(
    "rejects signed and internally consistent but unauthorized %s",
    (field) => {
      const value = { ...contract(), [field]: "other" };
      const raw = bytes(value);
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const signature = sign(null, raw, privateKey);
      expect(verify(null, raw, publicKey, signature)).toBe(true);
      expect(() =>
        validateOutputContractPolicy(parseOutputContractV1(raw), policy(), {
          ...binding(),
          [field]: "other",
        }),
      ).toThrow("output_policy_out_of_scope");
    },
  );
  it.each(["repositoryFullName", "branch", "namespace", "conversationId"] as const)(
    "rejects exact destination disagreement for %s",
    (field) => {
      const dest = {
        ...binding().destination,
        [field]: field === "repositoryFullName" ? "other/repo" : "other",
      };
      const value = { ...contract(), destination: dest };
      expect(() => validateOutputContractPolicy(value, policy(), binding())).toThrow(
        "output_contract_binding_mismatch",
      );
      expect(() =>
        validateOutputContractPolicy(value, policy(), { ...binding(), destination: dest }),
      ).toThrow("output_policy_out_of_scope");
    },
  );
  it("rejects changing mode, allowed set, MIME, or bounds instead of trusting the contract", () => {
    expect(() => validateOutputContractPolicy(contract(true), policy(), binding())).toThrow(
      "output_policy_out_of_scope",
    );
    for (const item of [
      { logicalName: "other", mediaType: "text/plain", maxBytes: 100 },
      { logicalName: "report", mediaType: "application/pdf", maxBytes: 100 },
      { logicalName: "report", mediaType: "text/plain", maxBytes: 101 },
    ])
      expect(() =>
        validateOutputContractPolicy(
          { ...contract(true), requiredOutputs: [item] },
          policy(true),
          binding(),
        ),
      ).toThrow("expected_set_mismatch");
    expect(() =>
      validateOutputContractPolicy(
        { ...contract(true), maxTotalBytes: 101 },
        policy(true),
        binding(),
      ),
    ).toThrow("output_policy_out_of_scope");
    const more = {
      ...contract(true),
      maxArtifacts: 2,
      requiredOutputs: [
        ...contract(true).requiredOutputs,
        { logicalName: "other", mediaType: "text/plain", maxBytes: 1 },
      ],
    };
    expect(() =>
      validateOutputContractPolicy(more, { ...policy(true), maxArtifacts: 2 }, binding()),
    ).toThrow("expected_set_mismatch");
  });
  it("fails closed for absent/malformed trusted policy or binding", () => {
    expect(() =>
      validateOutputContractPolicy(
        contract(),
        undefined as unknown as HostedExpectedOutputPolicy,
        binding(),
      ),
    ).toThrow("output_policy_invalid");
    expect(() =>
      validateOutputContractPolicy(
        contract(),
        { ...policy(), outputContractSha256: "e".repeat(64) } as HostedExpectedOutputPolicy,
        binding(),
      ),
    ).toThrow("output_policy_invalid");
    expect(() =>
      validateOutputContractPolicy(contract(), policy(), {
        ...binding(),
        route: "cli",
      } as unknown as OutputContractBindingV1),
    ).toThrow("output_contract_binding_invalid");
  });
});

describe("exact-frame artifact-declaration-1", () => {
  it("accepts explicit empty outputs without claiming observed source completeness", () => {
    const exp = expected();
    const decl = declaration(exp);
    const raw = framed(decl, exp);
    const parsed = parseArtifactDeclarationV1(raw, exp);
    expect(parsed.declaration.outputs).toEqual([]);
    expect(parsed.answerMarkdown).toBe("The answer");
    expect(parsed.frame.rawSha256).toBe(sha256Bytes(Buffer.from(raw)));
    expect(parsed.frame.bodySha256).toBe(sha256Bytes(Buffer.from(`${line(decl)}\nThe answer`)));
    expect(parsed.frame.markdown).toContain("BRIDGE ARTIFACT DECLARATION");
    expect(parsed).not.toHaveProperty("enumerationKnown");
    expect(parsed).not.toHaveProperty("approved");
  });
  it("preserves exact JSON whitespace/member order and keeps the raw frame separate from presentation", () => {
    const exp = expected();
    const exact = `  ${JSON.stringify(declaration(exp)).replaceAll(":", ": ")} \t`;
    const body = `\n\t\nBRIDGE ARTIFACT DECLARATION ${exact}\n\nAnswer 日本語`;
    const raw = encodeResponseFrame(body, exp.frame).replaceAll("\n", "\r\n");
    const parsed = parseArtifactDeclarationV1(Buffer.from(raw), exp);
    expect(Buffer.from(parsed.declarationBytes).toString()).toBe(exact);
    expect(parsed.declarationSha256).toBe(sha256Bytes(Buffer.from(exact)));
    expect(parsed.declarationSha256).not.toBe(sha256Bytes(bytes(parsed.declaration)));
    expect(parsed.answerMarkdown).toBe("\nAnswer 日本語");
    expect(parsed.frame.rawSha256).toBe(sha256Bytes(Buffer.from(raw)));
    expect(parsed.frame.bodySha256).toBe(sha256Bytes(Buffer.from(body)));
  });
  it("accepts required generated artifacts, with exact case-sensitive logical names", () => {
    const value = contract(true);
    value.requiredOutputs.push({
      logicalName: "Report",
      mediaType: "application/pdf",
      maxBytes: 100,
    });
    value.maxArtifacts = 2;
    value.maxTotalBytes = 200;
    const exp = expected(value);
    const decl = declaration(exp);
    declaredOutput(decl, 1).filename = "different.pdf";
    expect(parseArtifactDeclarationV1(framed(decl, exp), exp).declaration).toEqual(decl);
    declaredOutput(decl, 1).logicalName = "REPORT";
    expect(() => parseArtifactDeclarationV1(framed(decl, exp), exp)).toThrow(
      "declared_set_mismatch",
    );
  });
  it.each([
    "Ordinary answer only",
    "> BRIDGE ARTIFACT DECLARATION {}\nAnswer",
    "```json\nBRIDGE ARTIFACT DECLARATION {}\n```\nAnswer",
    "~~~\nBRIDGE ARTIFACT DECLARATION {}\n~~~",
    "    BRIDGE ARTIFACT DECLARATION {}\nAnswer",
    "Answer first\nBRIDGE ARTIFACT DECLARATION {}",
    "BRIDGE ARTIFACT DECLARATION",
  ])("does not interpret missing, quoted, fenced or misplaced declarations: %s", (body) => {
    const exp = expected();
    expect(() => parseArtifactDeclarationV1(encodeResponseFrame(body, exp.frame), exp)).toThrow(
      "missing_declaration",
    );
  });
  it.each([
    "BRIDGE ARTIFACT DECLARATION {}",
    "> BRIDGE ARTIFACT DECLARATION {}",
    "```\nBRIDGE ARTIFACT DECLARATION {}\n```",
    "BRIDGE ARTIFACT DECLARATION",
  ])("rejects duplicate, nested and partial repeats: %s", (extra) => {
    const exp = expected();
    expect(() => parseArtifactDeclarationV1(framed(declaration(exp), exp, extra), exp)).toThrow(
      "artifact_declaration_invalid",
    );
  });
  it("rejects partial/outer quoted frames and never substitutes a later unrelated turn", () => {
    const exp = expected();
    const raw = framed(declaration(exp), exp);
    for (const candidate of [
      raw.slice(0, -20),
      `> ${raw}`,
      `\`\`\`\n${raw}\`\`\``,
      raw + raw,
      `${raw}later answer`,
      line(declaration(exp)),
    ]) {
      expect(() => parseArtifactDeclarationV1(candidate, exp)).toThrow();
    }
  });
  it.each([
    ["requestId", otherId],
    ["taskSpecHash", "f".repeat(64)],
    ["attemptId", otherId],
    ["outputContractSha256", "f".repeat(64)],
  ])("rejects wrong declaration %s inside a valid outer frame", (field, value) => {
    const exp = expected();
    expect(() =>
      parseArtifactDeclarationV1(framed({ ...declaration(exp), [field]: value }, exp), exp),
    ).toThrow("artifact_declaration_binding_mismatch");
  });
  it("rejects a different outer attempt even if declaration is otherwise correct", () => {
    const exp = expected();
    const raw = encodeResponseFrame(line(declaration(exp)), { ...exp.frame, attemptId: otherId });
    expect(() => parseArtifactDeclarationV1(raw, exp)).toThrow("response_frame_mismatch");
  });
  it("does not accept a post-admission replacement contract digest", () => {
    const exp = expected();
    const original = declaration(exp);
    exp.outputContractSha256 = outputContractDigest(
      Buffer.from(`${JSON.stringify(exp.contract)}\n`),
    );
    expect(() => parseArtifactDeclarationV1(framed(original, exp), exp)).toThrow(
      "artifact_declaration_binding_mismatch",
    );
  });
  it.each([
    { outputs: undefined },
    { outputs: null },
    { outputs: {} },
    { schema: "artifact-declaration-2" },
    { requesterActorId: "requester" },
    { sourceArtifactId: "fabricated" },
    { approval: true },
    { schema: undefined },
    { attemptId: `${attemptId}\n` },
  ])("rejects unknown, missing and authority-inventing declaration fields %j", (change) => {
    const exp = expected();
    expect(() =>
      parseArtifactDeclarationV1(framed({ ...declaration(exp), ...change }, exp), exp),
    ).toThrow();
  });
  it("rejects missing/extra/duplicate names and an artifact for text-only", () => {
    const exp = expected(contract(true));
    const decl = declaration(exp);
    const output = declaredOutput(decl);
    for (const list of [[], [output, output], [{ ...output, logicalName: "extra" }]]) {
      expect(() =>
        parseArtifactDeclarationV1(framed({ ...decl, outputs: list }, exp), exp),
      ).toThrow("declared_set_mismatch");
    }
    const zero = expected();
    expect(() =>
      parseArtifactDeclarationV1(framed({ ...declaration(zero), outputs: [output] }, zero), zero),
    ).toThrow("declared_set_mismatch");
    const two = contract(true);
    two.requiredOutputs.push({ logicalName: "other", mediaType: "text/plain", maxBytes: 100 });
    two.maxArtifacts = 2;
    two.maxTotalBytes = 200;
    const twoExp = expected(two);
    expect(() =>
      parseArtifactDeclarationV1(
        framed({ ...declaration(twoExp), outputs: [output, output] }, twoExp),
        twoExp,
      ),
    ).toThrow("declared_set_mismatch");
  });
  it.each([
    { mediaType: "application/pdf" },
    { mediaType: "TEXT/PLAIN" },
    { mediaType: "text/*" },
    { contentSha256: "not-a-hash" },
    { contentSha256: "A".repeat(64) },
    { contentSha256: `${"a".repeat(64)}\n` },
    { sizeBytes: -1 },
    { sizeBytes: 1.5 },
    { sizeBytes: Number.MAX_SAFE_INTEGER + 1 },
    { sizeBytes: MAX_OUTPUT_FILE_BYTES + 1 },
    { sizeBytes: 101 },
    { required: false },
    { sourceArtifactId: "fabricated" },
    { logicalName: "path/file" },
  ])("rejects invalid MIME/hash/size/extra output fields %j", (change) => {
    const exp = expected(contract(true));
    const decl = declaration(exp);
    expect(() =>
      parseArtifactDeclarationV1(
        framed({ ...decl, outputs: [{ ...decl.outputs[0], ...change }] }, exp),
        exp,
      ),
    ).toThrow();
  });
  it.each([
    "../report.txt",
    "/report.txt",
    "C:\\report.txt",
    "folder/report.txt",
    "report.txt ",
    "report.",
    "NUL",
    "con.txt",
    "COM1.txt",
    "lpt9.txt",
    "COM0.txt",
    ".hidden",
    "name:stream",
    "report?.txt",
    "résumé.pdf",
    "report\n.txt",
    "report\0.txt",
    "x".repeat(121),
    "https://example.test/file",
  ])("rejects nonportable or reserved filename %s", (filename) => {
    const exp = expected(contract(true));
    const decl = declaration(exp);
    declaredOutput(decl).filename = filename;
    expect(() => parseArtifactDeclarationV1(framed(decl, exp), exp)).toThrow(
      "artifact_declaration_filename_invalid",
    );
  });
  it("rejects portable case-insensitive filename collisions separately from logical IDs", () => {
    const value = contract(true);
    value.requiredOutputs.push({ logicalName: "second", mediaType: "text/plain", maxBytes: 100 });
    value.maxArtifacts = 2;
    value.maxTotalBytes = 200;
    const exp = expected(value);
    const decl = declaration(exp);
    declaredOutput(decl, 1).filename = "REPORT.TXT";
    expect(() => parseArtifactDeclarationV1(framed(decl, exp), exp)).toThrow(
      "artifact_declaration_filename_collision",
    );
  });
  it("applies aggregate generated-byte bounds separately from mandatory frame proof bytes", () => {
    const value = contract(true);
    value.requiredOutputs.push({ logicalName: "second", mediaType: "text/plain", maxBytes: 100 });
    value.maxArtifacts = 2;
    value.maxTotalBytes = 9;
    const exp = expected(value);
    expect(() => parseArtifactDeclarationV1(framed(declaration(exp), exp), exp)).toThrow(
      "artifact_declaration_size_limit",
    );
    value.maxTotalBytes = 10;
    const exact = expected(value);
    expect(
      parseArtifactDeclarationV1(framed(declaration(exact), exact), exact).declaration.outputs,
    ).toHaveLength(2);
  });
  it("checks strict declaration UTF-8/duplicate keys/JSON size without reserialization", () => {
    const exp = expected();
    const json = JSON.stringify(declaration(exp));
    for (const rawJson of [
      json.replace('"outputs":[]', '"outputs":[],"outputs":[]'),
      json.replace('"outputs":[]', '"outputs":[],"outp\\u0075ts":[]'),
      json.replace('"outputs":[]', '"outputs":[],"secret":"\\ud800"'),
      `{\n${json.slice(1)}`,
      `${json} trailing`,
      `${json}${" ".repeat(MAX_ARTIFACT_DECLARATION_BYTES)}`,
    ]) {
      expect(() =>
        parseArtifactDeclarationV1(
          encodeResponseFrame(`BRIDGE ARTIFACT DECLARATION ${rawJson}`, exp.frame),
          exp,
        ),
      ).toThrow();
    }
    const raw = Buffer.from(framed(declaration(exp), exp));
    raw[100] = 0xff;
    expect(() => parseArtifactDeclarationV1(raw, exp)).toThrow("artifact_declaration_invalid");
    expect(() => parseArtifactDeclarationV1(`${framed(declaration(exp), exp)}\ud800`, exp)).toThrow(
      "artifact_declaration_invalid",
    );
  });
});

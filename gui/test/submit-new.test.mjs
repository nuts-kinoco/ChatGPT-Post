import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { addPickerAttachmentPaths, attachmentsArePickerApproved, buildNewRequest, buildSubmitArgs, createRequestId, validateNewSubmission, writeNewRequest } from "../dist/main/submit-new.js";

const valid = (overrides = {}) => ({
  prompt: "Summarize this request.",
  preset: "current",
  model: "current",
  newChat: true,
  attachments: [],
  ...overrides,
});

test("new submission rejects an empty or over-length prompt", () => {
  assert.deepEqual(validateNewSubmission(valid({ prompt: "   " })), { ok: false, reason: "Prompt is required" });
  assert.match(validateNewSubmission(valid({ prompt: "x".repeat(20_001) })).reason, /20,000/);
});

test("new submission rejects an invalid continuation URL and too many attachments", () => {
  assert.match(validateNewSubmission(valid({ newChat: false, conversationUrl: "https://chatgpt.com/c/not valid" })).reason, /conversation URL/);
  assert.match(validateNewSubmission(valid({ attachments: Array.from({ length: 21 }, (_, index) => path.resolve(`attachment-${index}`)) })).reason, /limited to 20/);
});

test("new submission accepts a valid continuation and builds the exact request schema shape", () => {
  const attachment = path.resolve("notes.md");
  const checked = validateNewSubmission(valid({ preset: "high", model: "latest", newChat: false, conversationUrl: "https://chatgpt.com/c/abc-123", attachments: [attachment] }));
  assert.equal(checked.ok, true);
  if (!checked.ok) return;
  const request = buildNewRequest("20260925T120000Z-deadbeef", checked.value);
  assert.deepEqual(request, {
    schemaVersion: "1.1",
    requestId: "20260925T120000Z-deadbeef",
    promptFile: "prompt.md",
    attachments: [attachment],
    preset: "high",
    model: "latest",
    newChat: false,
    conversationUrl: "https://chatgpt.com/c/abc-123",
    responseFormat: "markdown",
  });
  assert.match(createRequestId(new Date("2026-09-25T12:00:00.000Z"), Buffer.from("deadbeef", "hex")), /^20260925T120000Z-deadbeef$/);
});

test("new submission attachments must have come from the native picker", () => {
  const approved = path.resolve("picked.md");
  assert.equal(attachmentsArePickerApproved([approved], new Set([approved])), true);
  assert.equal(attachmentsArePickerApproved([path.resolve("unpicked.md")], new Set([approved])), false);
});

test("new submission accepts attachments picked in separate picker calls", () => {
  const approved = new Set();
  const first = path.resolve("first-picked.md");
  const second = path.resolve("second-picked.md");
  assert.deepEqual(addPickerAttachmentPaths(approved, [first]), [first]);
  assert.deepEqual(addPickerAttachmentPaths(approved, [second]), [first, second]);
  assert.equal(attachmentsArePickerApproved([first, second], approved), true);
});

test("new submission writes only the expected request files through its injected writer", async () => {
  const checked = validateNewSubmission(valid());
  assert.equal(checked.ok, true);
  if (!checked.ok) return;
  const calls = [];
  const writer = {
    mkdir: async (file, options) => calls.push(["mkdir", file, options]),
    writeFile: async (file, content, encoding) => calls.push(["writeFile", file, content, encoding]),
  };
  const root = path.resolve("fake-runtime", "requests");
  const directory = await writeNewRequest(root, "20260925T120000Z-deadbeef", checked.value, writer);
  assert.equal(directory, path.join(root, "20260925T120000Z-deadbeef"));
  assert.deepEqual(calls.map(([kind, file]) => [kind, path.basename(file)]), [["mkdir", "requests"], ["mkdir", "20260925T120000Z-deadbeef"], ["writeFile", "prompt.md"], ["writeFile", "request.json"]]);
  assert.deepEqual(calls[0][2], { recursive: true });
  assert.deepEqual(calls[1][2], { recursive: false });
  assert.equal(calls[2][2], "Summarize this request.");
  assert.deepEqual(JSON.parse(calls[3][2]), buildNewRequest("20260925T120000Z-deadbeef", checked.value));
});

test("new submission spawns submit with the request.json file path", () => {
  const cliPath = path.resolve("dist", "cli", "main.js");
  const requestDirectory = path.resolve("runtime", "requests", "20260925T120000Z-deadbeef");
  const requestFilePath = path.join(requestDirectory, "request.json");

  assert.deepEqual(buildSubmitArgs(cliPath, requestFilePath), [cliPath, "submit", "--request", requestFilePath, "--json"]);
  assert.notEqual(buildSubmitArgs(cliPath, requestFilePath)[3], requestDirectory);
});

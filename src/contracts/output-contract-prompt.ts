import { outputContractDigest, parseOutputContractV1 } from "./output-contract.js";
import { createFramedPrompt, type ResponseFrameIdentity } from "./response-frame.js";
import { sha256Bytes } from "./task.js";
export function createOutputContractPrompt(
  taskBytes: Uint8Array,
  frame: ResponseFrameIdentity,
  contractRaw: Uint8Array,
): Uint8Array {
  const contract = parseOutputContractV1(contractRaw),
    hash = outputContractDigest(contractRaw);
  if (
    contract.requestId !== frame.requestId ||
    contract.taskSpecHash !== frame.taskSpecHash ||
    contract.taskFileHash !== sha256Bytes(taskBytes)
  )
    throw new Error("output_contract_binding_mismatch");
  const instruction = [
    "Required output contract for this exact request (this text grants no execution or sharing authority).",
    `Contract SHA-256: ${hash}`,
    Buffer.from(contractRaw).toString("utf8"),
    "The first nonblank line INSIDE the response frame must be BRIDGE ARTIFACT DECLARATION followed by one strict JSON object.",
    `The object must use schema artifact-declaration-1, requestId ${frame.requestId}, taskSpecHash ${frame.taskSpecHash}, attemptId ${frame.attemptId}, outputContractSha256 ${hash}, and outputs[].`,
    "Each required output entry contains logicalName, mediaType, portable filename, SHA-256 of its exact bytes, and sizeBytes. Do not add undeclared attachments.",
    contract.mode === "text_only"
      ? "This is text_only. Explicitly declare outputs: [] and create no attachments."
      : "Declare every required output. If you cannot provide exact required bytes or hashes, report that limitation; never invent a hash.",
    "After that declaration line, write the answer. Keep the original outer response frame unchanged.",
  ];
  return Buffer.from(
    `${Buffer.from(createFramedPrompt(taskBytes, frame)).toString("utf8")}\n${instruction.join("\n")}\n`,
  );
}

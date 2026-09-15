import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { BridgeRequest, BridgeResult } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
// dist/contracts -> repo root; src/contracts -> repo root (tests run from src via vitest)
export const REPO_ROOT = join(here, "..", "..");
const SCHEMA_DIR = join(REPO_ROOT, "schemas");

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8")) as object;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats.default(ajv);

let requestValidator: ValidateFunction | undefined;
let resultValidator: ValidateFunction | undefined;

export interface ValidationOutcome {
  valid: boolean;
  errors: string[];
}

function describe(fn: ValidateFunction): string[] {
  return (fn.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
}

export function validateRequest(data: unknown): ValidationOutcome {
  requestValidator ??= ajv.compile(loadSchema("request.schema.json"));
  const valid = requestValidator(data) as boolean;
  return { valid, errors: valid ? [] : describe(requestValidator) };
}

export function validateResult(data: unknown): ValidationOutcome {
  resultValidator ??= ajv.compile(loadSchema("result.schema.json"));
  const valid = resultValidator(data) as boolean;
  return { valid, errors: valid ? [] : describe(resultValidator) };
}

export function isBridgeRequest(data: unknown): data is BridgeRequest {
  return validateRequest(data).valid;
}

export function isBridgeResult(data: unknown): data is BridgeResult {
  return validateResult(data).valid;
}

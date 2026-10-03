import { describe, expect, it } from "vitest";
import { runIssuerCommand } from "../../src/cli/issuer.js";
import { safeIssuerError } from "../../src/cli/issuer-errors.js";
import { parsePreparedComposer, validateRecipientCapability } from "../../src/contracts/issuer.js";
import { issuerFixture } from "../helpers/issuer-fixture.js";

describe("independent issuer boundaries", () => {
  it("rejects array-coerced capability route", () => {
    const f = issuerFixture();
    expect(() => validateRecipientCapability({ ...f.capability, route: ["cli"] })).toThrow();
  });
  it("rejects array-coerced preview version", async () => {
    const f = issuerFixture();
    const p = await f.facade.prepare(f.input());
    const value = structuredClone(p.prepared) as unknown as { preview: { version: unknown } };
    value.preview.version = ["bridge-composer-preview-1"];
    expect(() => parsePreparedComposer(Buffer.from(JSON.stringify(value)))).toThrow();
  });
  it("rejects array-coerced child route", async () => {
    const f = issuerFixture();
    const p = await f.facade.prepare(f.input());
    const value = structuredClone(p.prepared) as unknown as {
      preview: { children: { route: unknown }[] };
    };
    const child = value.preview.children[0];
    if (!child) throw new Error("fixture");
    child.route = ["cli"];
    expect(() => parsePreparedComposer(Buffer.from(JSON.stringify(value)))).toThrow();
  });
  it("never rereads diagnostic getters into an unapproved secret", async () => {
    const f = issuerFixture();
    let reads = 0;
    const error = {
      get message() {
        reads++;
        return reads <= 2 ? "issuer_scope_denied" : "credential_example_value";
      },
    };
    f.facade.catalogue = async () => {
      throw error;
    };
    await expect(runIssuerCommand(f.facade, "issuer-catalogue")).rejects.not.toThrow(
      "credential_example_value",
    );
  });
  it("does not let a throwing diagnostic getter bypass redaction", () => {
    const value = {
      get message() {
        throw new Error("credential_example_value");
      },
    };
    expect(() => safeIssuerError(value)).not.toThrow();
    expect(safeIssuerError(value)).toBe("issuer_operation_failed");
  });
});

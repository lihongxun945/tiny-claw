import { describe, expect, it } from "vitest";
import { maskPluginConfig, resolvePluginConfig, restoreMaskedPluginConfig } from "../../src/kernel/plugin-config.js";
import type { PluginConfigDeclaration } from "../../src/kernel/plugin.js";

const declaration: PluginConfigDeclaration = {
  fields: {
    endpoint: { type: "string", title: "Endpoint", required: true },
    token: { type: "string", title: "Token", secret: true, required: true },
    retries: { type: "number", title: "Retries", default: 3, min: 0, max: 5, integer: true },
    enabled: { type: "boolean", title: "Enabled", default: true },
    mode: { type: "select", title: "Mode", default: "fast", options: [{ value: "fast", label: "Fast" }] },
  },
};

describe("plugin config", () => {
  it("merges defaults, warns for unknown fields and freezes the result", () => {
    const result = resolvePluginConfig(declaration, { endpoint: "https://example.com", token: "secret", extra: 1 });
    expect(result.valid).toBe(true);
    expect(result.value).toEqual({ endpoint: "https://example.com", token: "secret", retries: 3, enabled: true, mode: "fast", extra: 1 });
    expect(result.issues).toEqual([expect.objectContaining({ path: "extra", code: "unknown_field", severity: "warning" })]);
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("reports required, type, range and select errors", () => {
    const missing = resolvePluginConfig(declaration, {});
    expect(missing.valid).toBe(false);
    expect(missing.issues.map((item) => item.path)).toEqual(expect.arrayContaining(["endpoint", "token"]));

    const invalid = resolvePluginConfig(declaration, { endpoint: 1, token: "ok", retries: 9, mode: "slow" });
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.map((item) => item.code)).toEqual(expect.arrayContaining(["invalid_type", "out_of_range", "invalid_value"]));
  });

  it("masks declared secrets and restores masked values", () => {
    const value = { endpoint: "https://example.com", token: "secret-token" };
    expect(maskPluginConfig(declaration, value)).toEqual({ endpoint: "https://example.com", token: "secr***" });
    expect(restoreMaskedPluginConfig(declaration, { ...value, token: "secr***" }, value)).toEqual(value);
  });
});

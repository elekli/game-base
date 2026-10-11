import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const projectRequire = createRequire(import.meta.url);
const eslintConfigRequire = createRequire(projectRequire.resolve("eslint-config-next"));
const nextPluginRequire = createRequire(eslintConfigRequire.resolve("@next/eslint-plugin-next"));
const fastGlobRequire = createRequire(nextPluginRequire.resolve("fast-glob"));
const micromatchRequire = createRequire(fastGlobRequire.resolve("micromatch"));
const braces = micromatchRequire("braces");

describe("patched braces dependency", () => {
  it("continues to expand ordinary brace patterns", () => {
    expect(braces.expand("{a,{b,c}}")).toEqual(["a", "b", "c"]);
  });

  it("rejects brace nesting beyond the configured limit", () => {
    const atLimit = `${"{".repeat(100)}x${"}".repeat(100)}`;
    const beyondLimit = `${"{".repeat(101)}x${"}".repeat(101)}`;

    expect(() => braces(atLimit)).not.toThrow();
    expect(() => braces(beyondLimit)).toThrow(/exceeds max depth \(100\)/);
  });
});

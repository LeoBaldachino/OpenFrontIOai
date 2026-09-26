// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import {
  getLogLevel,
  installQuiet,
  parseLogLevel,
  resetSuppressedCounts,
  restoreConsole,
  setLogLevel,
  suppressedCounts,
  suppressedWarnings,
} from "../env/Quiet";

const lines: string[] = [];
// Importing Quiet installed the filter; point its output at a buffer.
installQuiet({ write: (l) => lines.push(l) });
afterAll(() => restoreConsole());

describe("Quiet", () => {
  it("parses OFRL_LOG_LEVEL", () => {
    expect(parseLogLevel(undefined)).toBe("error");
    expect(parseLogLevel("WARN")).toBe("warn");
    expect(parseLogLevel(" debug ")).toBe("debug");
    expect(parseLogLevel("toString")).toBe("error");
    expect(parseLogLevel("nope", "info")).toBe("info");
  });

  it("filters by level and counts suppressed calls", () => {
    const originalError = console.error;
    setLogLevel("error");
    resetSuppressedCounts();
    lines.length = 0;
    console.log("a");
    console.info("b");
    console.debug("c");
    console.warn("w1");
    console.warn("w2 %d", 5);
    expect(lines).toEqual([]);
    expect(suppressedWarnings()).toBe(2);
    expect(suppressedCounts()).toEqual({ debug: 1, log: 1, info: 1, warn: 2 });
    expect(console.error).toBe(originalError);

    setLogLevel("warn");
    console.warn("w3 %d", 7);
    console.log("hidden");
    expect(lines).toEqual(["w3 7\n"]);
    expect(suppressedWarnings()).toBe(2);

    setLogLevel("info");
    lines.length = 0;
    console.log("x", { a: 1 });
    console.info("y");
    console.debug("z");
    expect(lines).toEqual(["x { a: 1 }\n", "y\n"]);

    setLogLevel("debug");
    lines.length = 0;
    console.debug("z");
    expect(lines).toEqual(["z\n"]);

    setLogLevel("silent");
    lines.length = 0;
    console.warn("gone");
    expect(lines).toEqual([]);
    expect(getLogLevel()).toBe("silent");
  });
});

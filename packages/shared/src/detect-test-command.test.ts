import { describe, expect, test } from "bun:test";
import { detectTestCommand } from "./detect-test-command";

describe("detectTestCommand", () => {
  test("prefers an explicit test script", () => {
    expect(detectTestCommand({ scripts: { test: "vitest run" } })).toEqual({
      command: "npm test",
      source: "script",
    });
  });

  test("ignores the npm placeholder script and falls back to a framework", () => {
    const pkg = {
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
      devDependencies: { jest: "^29.0.0" },
    };
    expect(detectTestCommand(pkg)).toEqual({ command: "jest", source: "framework" });
  });

  test("detects a framework from devDependencies when no script exists", () => {
    expect(detectTestCommand({ devDependencies: { vitest: "^1.0.0" } })).toEqual({
      command: "vitest run",
      source: "framework",
    });
  });

  test("detects playwright from dependencies", () => {
    expect(detectTestCommand({ dependencies: { "@playwright/test": "^1.40.0" } })).toEqual({
      command: "playwright test",
      source: "framework",
    });
  });

  test("respects framework preference order", () => {
    expect(detectTestCommand({ devDependencies: { jest: "^29", vitest: "^1" } })).toEqual({
      command: "vitest run",
      source: "framework",
    });
  });

  test("returns null when nothing is detectable", () => {
    const inputs: unknown[] = [null, undefined, [], "nope", 42, {}, { scripts: {} }];
    for (const input of inputs) {
      expect(detectTestCommand(input)).toBeNull();
    }
  });
});

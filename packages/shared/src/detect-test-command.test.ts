import { describe, expect, test } from "bun:test";
import { detectTestCommand, detectPackageManager } from "./detect-test-command";

describe("detectTestCommand", () => {
  test("prefers the project's own test script, run via the package manager", () => {
    expect(detectTestCommand({ scripts: { test: "vitest run" } })).toEqual({
      command: "npm run test",
      source: "script",
    });
  });

  test("tailors the script command to the detected package manager", () => {
    expect(detectTestCommand({ scripts: { test: "vitest run" } }, "bun")).toEqual({
      command: "bun run test",
      source: "script",
    });
  });

  test("ignores the npm placeholder script and falls back to a framework", () => {
    const pkg = {
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
      devDependencies: { jest: "^29.0.0" },
    };
    expect(detectTestCommand(pkg)).toEqual({ command: "npx jest", source: "framework" });
  });

  test("detects a framework from devDependencies when no script exists", () => {
    expect(detectTestCommand({ devDependencies: { vitest: "^1.0.0" } })).toEqual({
      command: "npx vitest run",
      source: "framework",
    });
  });

  test("runs the detected framework via the package manager's exec", () => {
    expect(detectTestCommand({ devDependencies: { vitest: "^1.0.0" } }, "pnpm")).toEqual({
      command: "pnpm exec vitest run",
      source: "framework",
    });
  });

  test("detects playwright from dependencies", () => {
    expect(detectTestCommand({ dependencies: { "@playwright/test": "^1.40.0" } })).toEqual({
      command: "npx playwright test",
      source: "framework",
    });
  });

  test("respects framework preference order", () => {
    expect(detectTestCommand({ devDependencies: { jest: "^29", vitest: "^1" } })).toEqual({
      command: "npx vitest run",
      source: "framework",
    });
  });

  test("ignores a framework listed only as a peerDependency", () => {
    expect(detectTestCommand({ peerDependencies: { jest: "^29" } })).toBeNull();
  });

  test("returns null when nothing is detectable", () => {
    const inputs: unknown[] = [null, undefined, [], "nope", 42, {}, { scripts: {} }];
    for (const input of inputs) {
      expect(detectTestCommand(input)).toBeNull();
    }
  });
});

describe("detectPackageManager", () => {
  test.each([
    [["bun.lock"], "bun"],
    [["bun.lockb"], "bun"],
    [["pnpm-lock.yaml"], "pnpm"],
    [["yarn.lock"], "yarn"],
    [["package-lock.json"], "npm"],
  ] as const)("maps %p → %s", (lockfiles, expected) => {
    expect(detectPackageManager([...lockfiles])).toBe(expected);
  });

  test("prefers bun when multiple lock files are present", () => {
    expect(detectPackageManager(["package-lock.json", "bun.lock"])).toBe("bun");
  });

  test("defaults to npm when no lock file is recognized", () => {
    expect(detectPackageManager(["README.md"])).toBe("npm");
    expect(detectPackageManager([])).toBe("npm");
  });
});

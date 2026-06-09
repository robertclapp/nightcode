/**
 * Live end-to-end harness for the Test Fixer loop.
 *
 * This exercises the REAL machinery — executeLocalTool with the FIX-mode
 * tamper guard, detectProjectTestCommand, FixRunController, and actual
 * `bun run test` subprocesses as the green/red oracle — against a real broken
 * project in a temp directory. Only the model is replaced by a scripted agent
 * performing the same tool calls a model would make.
 *
 * It proves, live: red suite observed → tamper attempts blocked → minimal
 * implementation fix applied → suite green → controller reports green; and
 * separately that the iteration budget halts a run that isn't converging.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Mode, FixRunController } from "@nightcode/shared";
import { executeLocalTool } from "./local-tools";
import { detectProjectTestCommand } from "./detect-project-test-command";

const BROKEN_MATH = `function add(a, b) {
  return a - b;
}

module.exports = { add };
`;

const MATH_SUITE = `const assert = require("assert");
const { add } = require("./math");

assert.strictEqual(add(2, 2), 4);
assert.strictEqual(add(0, 5), 5);
console.log("all tests passed");
`;

let projectDir: string;
let originalCwd: string;

type BashResult = { stdout: string; stderr: string; exitCode: number };

function bash(command: string) {
  return executeLocalTool("bash", { command }, Mode.FIX) as Promise<BashResult>;
}

beforeAll(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), "nightcode-fix-live-"));

  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify(
      { name: "sample-broken", private: true, scripts: { test: "node math.test.js" } },
      null,
      2,
    ),
  );
  writeFileSync(join(projectDir, "math.js"), BROKEN_MATH);
  writeFileSync(join(projectDir, "math.test.js"), MATH_SUITE);
  // Lock file so package-manager detection resolves to bun.
  writeFileSync(join(projectDir, "bun.lock"), "");

  process.chdir(projectDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

describe("live fix run against a real broken project", () => {
  test("detects the project test command from disk", () => {
    expect(detectProjectTestCommand()).toEqual({ command: "bun run test", source: "script" });
  });

  test("drives the suite from red to green with tampering blocked throughout", async () => {
    const detected = detectProjectTestCommand();
    expect(detected).not.toBeNull();
    const fixRun = new FixRunController({ testCommand: detected!.command });

    // 1. Run the suite — real subprocess, real failure.
    const redRun = await bash("bun run test");
    expect(redRun.exitCode).not.toBe(0);
    expect(redRun.stderr).toContain("AssertionError");

    const redEvent = fixRun.observeBashResult("bun run test", redRun.exitCode);
    expect(redEvent).toEqual({
      type: "test-run-failed",
      failedRuns: 1,
      remaining: fixRun.maxIterations - 1,
    });
    expect(fixRun.state).toBe("running");

    // 2. Read the implementation, as a model would before patching.
    const read = (await executeLocalTool("readFile", { path: "math.js" }, Mode.FIX)) as {
      content: string;
    };
    expect(read.content).toContain("a - b");

    // 3. Tamper attempts — every cheat path must be blocked by the guard.
    await expect(
      executeLocalTool(
        "editFile",
        { path: "math.test.js", oldString: "4", newString: "0" },
        Mode.FIX,
      ),
    ).rejects.toThrow(/Fix mode will not modify the test file/);

    await expect(
      executeLocalTool(
        "writeFile",
        { path: "math.test.js", content: "console.log('all tests passed');" },
        Mode.FIX,
      ),
    ).rejects.toThrow(/Fix mode will not modify the test file/);

    await expect(bash("rm math.test.js")).rejects.toThrow(/Fix mode blocked a shell command/);
    await expect(bash("sed -i 's/4/0/' math.test.js")).rejects.toThrow(
      /Fix mode blocked a shell command/,
    );

    // The suite must be untouched after all of that.
    const suite = (await executeLocalTool("readFile", { path: "math.test.js" }, Mode.FIX)) as {
      content: string;
    };
    expect(suite.content).toBe(MATH_SUITE);

    // 4. The legitimate path: minimal fix to the implementation.
    const edit = (await executeLocalTool(
      "editFile",
      { path: "math.js", oldString: "return a - b;", newString: "return a + b;" },
      Mode.FIX,
    )) as { success: true };
    expect(edit.success).toBe(true);

    // 5. Re-run — the oracle flips to green.
    const greenRun = await bash("bun run test");
    expect(greenRun.exitCode).toBe(0);
    expect(greenRun.stdout).toContain("all tests passed");

    const greenEvent = fixRun.observeBashResult("bun run test", greenRun.exitCode);
    expect(greenEvent).toEqual({ type: "test-run-passed", totalRuns: 2 });
    expect(fixRun.state).toBe("green");

    // Nothing is gated on a green run; the model is free to summarize.
    expect(fixRun.gateToolCall("editFile")).toBeNull();
  });

  test("a run that never converges is halted by the budget", async () => {
    // Re-break the implementation (test setup, not an agent action).
    writeFileSync(join(projectDir, "math.js"), BROKEN_MATH);

    const fixRun = new FixRunController({ testCommand: "bun run test", maxIterations: 2 });

    for (let i = 1; i <= 2; i++) {
      const run = await bash("bun run test");
      expect(run.exitCode).not.toBe(0);
      fixRun.observeBashResult("bun run test", run.exitCode);
    }

    expect(fixRun.state).toBe("exhausted");

    // Mutations and further test runs are refused; context-gathering is not.
    expect(fixRun.gateToolCall("bash")).toContain("budget");
    expect(fixRun.gateToolCall("editFile")).toContain("budget");
    expect(fixRun.gateToolCall("readFile")).toBeNull();

    // The grace window lets the model read refusals and summarize, then the
    // auto-send loop is cut so a stubborn run cannot spin forever.
    expect(fixRun.shouldAutoContinue()).toBe(true);
    fixRun.gateToolCall("writeFile");
    fixRun.gateToolCall("bash");
    expect(fixRun.shouldAutoContinue()).toBe(false);
  });
});

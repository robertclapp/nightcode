import { describe, expect, test } from "bun:test";
import { FixRunController, DEFAULT_FIX_MAX_ITERATIONS } from "./fix-loop";

function makeController(maxIterations?: number) {
  return new FixRunController({ testCommand: "bun run test", maxIterations });
}

describe("FixRunController.isTestRunCommand", () => {
  test.each([
    "bun run test",
    "  bun run test  ",
    "bun  run   test", // extra whitespace normalized
    "bun run test -- --filter math",
  ])("recognizes clean test run: %s", (command) => {
    expect(makeController().isTestRunCommand(command)).toBe(true);
  });

  test.each([
    "bun run test:unit", // different script, not a prefix-with-separator match
    "bun run build",
    "npm test",
    "ls -la",
    "",
    // Shell chaining/redirection must not be trusted as a test run, or the
    // agent could fake green / dodge the budget.
    "bun run test || true",
    "bun run test && echo done",
    "bun run test; exit 0",
    "bun run test | tee log",
    "bun run test > out.txt",
    "bun run test `rm -rf x`",
  ])("rejects non-clean test command: %s", (command) => {
    expect(makeController().isTestRunCommand(command)).toBe(false);
  });
});

describe("FixRunController state machine", () => {
  test("starts running, goes green on a passing test run", () => {
    const controller = makeController();
    expect(controller.state).toBe("running");

    const event = controller.observeBashResult("bun run test", 0);
    expect(event).toEqual({ type: "test-run-passed", totalRuns: 1 });
    expect(controller.state).toBe("green");
  });

  test("counts failing runs and reports remaining budget", () => {
    const controller = makeController(3);

    expect(controller.observeBashResult("bun run test", 1)).toEqual({
      type: "test-run-failed",
      failedRuns: 1,
      remaining: 2,
    });
    expect(controller.state).toBe("running");

    controller.observeBashResult("bun run test", 1);
    expect(controller.observeBashResult("bun run test", 2)).toEqual({
      type: "test-run-failed",
      failedRuns: 3,
      remaining: 0,
    });
    expect(controller.state).toBe("exhausted");
  });

  test("ignores bash commands that are not test runs", () => {
    const controller = makeController(1);
    expect(controller.observeBashResult("ls -la", 1)).toEqual({ type: "not-a-test-run" });
    expect(controller.observeBashResult("cat foo.ts", 127)).toEqual({ type: "not-a-test-run" });
    expect(controller.state).toBe("running");
  });

  test("a later failure flips green back to running (flaky suite stays honest)", () => {
    const controller = makeController();
    controller.observeBashResult("bun run test", 0);
    expect(controller.state).toBe("green");

    controller.observeBashResult("bun run test", 1);
    expect(controller.state).toBe("running");
  });

  test("defaults to the shared iteration budget", () => {
    expect(makeController().maxIterations).toBe(DEFAULT_FIX_MAX_ITERATIONS);
  });
});

describe("FixRunController gating after exhaustion", () => {
  function exhaust(controller: FixRunController) {
    while (controller.state !== "exhausted") {
      controller.observeBashResult("bun run test", 1);
    }
  }

  test("never gates anything while running or green", () => {
    const controller = makeController();
    for (const tool of ["bash", "writeFile", "editFile", "readFile", "grep"]) {
      expect(controller.gateToolCall(tool)).toBeNull();
    }
    controller.observeBashResult("bun run test", 0);
    expect(controller.gateToolCall("editFile")).toBeNull();
  });

  test("refuses mutating tools but allows read-only tools when exhausted", () => {
    const controller = makeController(1);
    exhaust(controller);

    expect(controller.gateToolCall("editFile")).toContain("budget");
    expect(controller.gateToolCall("writeFile")).toContain("budget");
    expect(controller.gateToolCall("bash")).toContain("budget");
    expect(controller.gateToolCall("readFile")).toBeNull();
    expect(controller.gateToolCall("glob")).toBeNull();
  });

  test("read-only calls also advance the exhaustion grace window", () => {
    const controller = makeController(1);
    exhaust(controller);

    // Read-only calls are allowed (no refusal) but still count, so a model that
    // only ever reads cannot keep the loop alive forever.
    for (let i = 0; i < 4; i++) {
      expect(controller.gateToolCall("readFile")).toBeNull();
    }
    expect(controller.shouldAutoContinue()).toBe(false);
  });

  test("auto-continue survives a grace window of refusals, then stops", () => {
    const controller = makeController(1);
    exhaust(controller);
    expect(controller.shouldAutoContinue()).toBe(true);

    // A stubborn model keeps trying; each refusal is counted.
    controller.gateToolCall("editFile");
    controller.gateToolCall("bash");
    controller.gateToolCall("writeFile");
    expect(controller.shouldAutoContinue()).toBe(true);

    controller.gateToolCall("editFile");
    expect(controller.shouldAutoContinue()).toBe(false);
  });
});

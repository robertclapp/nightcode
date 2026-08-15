/**
 * Fix-run loop controller.
 *
 * The Test Fixer agent works a loop: run the tests, read the failures, patch
 * the implementation, re-run. The model drives the patching; this controller
 * is the deterministic harness around it — the part that must not be left to
 * the model's judgement:
 *
 * - It knows the project's test command and recognizes when a bash call is a
 *   test run (the oracle).
 * - It counts failing runs against an iteration budget so a stuck run cannot
 *   loop (and bill credits) forever.
 * - Once the budget is spent it refuses further mutating tool calls and, after
 *   a short grace window for the model to summarize, stops the auto-send loop.
 *
 * Pure and dependency-free so it can be unit tested and reused on both the
 * client and the server.
 */

/** Default number of failing test runs allowed before a fix run is stopped. */
export const DEFAULT_FIX_MAX_ITERATIONS = 6;

/**
 * After exhaustion, tool calls are refused with an instruction to summarize.
 * If the model keeps calling tools anyway, stop auto-continuing after this
 * many refusals so a stubborn loop cannot spin (and bill) indefinitely.
 */
const POST_EXHAUSTION_REFUSAL_LIMIT = 3;

const READ_ONLY_TOOLS = new Set(["readFile", "listDirectory", "glob", "grep"]);

/**
 * Shell chain / redirection metacharacters. A test command containing any of
 * these is not a clean test run — e.g. `bun run test || true` would always exit
 * 0, letting the agent fake a green run or dodge the budget.
 */
const SHELL_CHAIN = /[;&|<>()`\n]/;

export type FixRunState = "running" | "green" | "exhausted";

/** A read-only view of a fix run's progress, for display in the UI. */
export type FixRunSnapshot = {
  state: FixRunState;
  failedRuns: number;
  maxIterations: number;
  testCommand: string;
};

export type FixRunEvent =
  | { type: "not-a-test-run" }
  | { type: "test-run-passed"; totalRuns: number }
  | { type: "test-run-failed"; failedRuns: number; remaining: number };

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

export class FixRunController {
  readonly testCommand: string;
  readonly maxIterations: number;

  private totalRuns = 0;
  private failedRuns = 0;
  private lastRunPassed = false;
  private postExhaustionToolCalls = 0;

  constructor(options: { testCommand: string; maxIterations?: number }) {
    this.testCommand = normalizeCommand(options.testCommand);
    this.maxIterations = options.maxIterations ?? DEFAULT_FIX_MAX_ITERATIONS;
  }

  get state(): FixRunState {
    if (this.lastRunPassed) return "green";
    if (this.failedRuns >= this.maxIterations) return "exhausted";
    return "running";
  }

  /** A snapshot of the current run for rendering in the UI. */
  getSnapshot(): FixRunSnapshot {
    return {
      state: this.state,
      failedRuns: this.failedRuns,
      maxIterations: this.maxIterations,
      testCommand: this.testCommand,
    };
  }

  /**
   * True when a bash command is a CLEAN run of the configured test command —
   * exact, or with extra arguments appended (e.g. `bun run test -- --filter
   * math`). Commands that chain or redirect (`bun run test || true`,
   * `... ; rm -rf x`, `... > out`) are rejected so the agent cannot fake a
   * green run or avoid spending budget; only a clean invocation is trusted.
   */
  isTestRunCommand(command: string): boolean {
    if (SHELL_CHAIN.test(command)) return false;
    const normalized = normalizeCommand(command);
    return normalized === this.testCommand || normalized.startsWith(`${this.testCommand} `);
  }

  /**
   * Feed every completed bash execution here. Test runs move the run state:
   * exit 0 turns the run green; a non-zero exit consumes one unit of budget.
   */
  observeBashResult(command: string, exitCode: number): FixRunEvent {
    if (!this.isTestRunCommand(command)) return { type: "not-a-test-run" };

    this.totalRuns++;
    this.lastRunPassed = exitCode === 0;

    if (this.lastRunPassed) {
      return { type: "test-run-passed", totalRuns: this.totalRuns };
    }

    this.failedRuns++;
    return {
      type: "test-run-failed",
      failedRuns: this.failedRuns,
      remaining: Math.max(0, this.maxIterations - this.failedRuns),
    };
  }

  /**
   * Call before executing a tool. Returns a refusal message when the call must
   * not run (budget exhausted and the tool could change state), or null when
   * the call may proceed. Read-only tools are never refused so the model can
   * still gather context for its summary.
   */
  gateToolCall(toolName: string): string | null {
    if (this.state !== "exhausted") return null;

    // Count every call once exhausted — read-only ones included — so a model
    // that keeps calling readFile/grep still drives the grace window closed.
    this.postExhaustionToolCalls++;
    if (READ_ONLY_TOOLS.has(toolName)) return null;

    return (
      `Fix run stopped: the budget of ${this.maxIterations} failing test runs has been used. ` +
      "Do not attempt further changes or test runs. Summarize the diagnosis, what you tried, " +
      "and where you are stuck, then stop."
    );
  }

  /**
   * Whether the client should keep auto-sending tool results back to the
   * model. Stays true through the grace window after exhaustion (so the model
   * can read the refusals and summarize), then turns false to hard-stop the
   * loop.
   */
  shouldAutoContinue(): boolean {
    if (this.state !== "exhausted") return true;
    return this.postExhaustionToolCalls <= POST_EXHAUSTION_REFUSAL_LIMIT;
  }
}

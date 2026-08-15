# Test Fixer (FIX mode)

The Test Fixer is a third NightCode agent alongside **Plan** and **Build**. Its
one job is to drive a project's failing tests to green by fixing the
**implementation** — and never the tests. The promise *"fixes the code, never
the test"* is enforced at the execution layer, not just requested in the prompt.

## Why it's different

Most coding agents will happily make a suite "pass" by deleting an assertion or
adding `.skip`. The Test Fixer can't: every file write, edit, and shell command
is checked before it runs, and anything that would weaken, disable, or delete a
test is blocked. Because the test suite's exit code is an objective oracle, the
loop is self-verifying, safe to run unattended, and fair to meter.

## How it works

```
 user picks "Fix" agent ──► detect test command (package.json + lockfiles)
        │
        ▼
 ┌──────────────────────────── loop ────────────────────────────┐
 │  run tests (bash) ──► exit code is the oracle                 │
 │      │ green ───────────────────────────────► done, summarize │
 │      │ red                                                    │
 │      ▼                                                        │
 │  read failures ► patch IMPLEMENTATION (guard blocks test edits)│
 │      │                                                        │
 │      └────────► re-run ──► budget − 1 ──► (stop if exhausted)  │
 └───────────────────────────────────────────────────────────────┘
```

### The pieces

| Concern | Where | What it does |
|---|---|---|
| Tamper guard | `@nightcode/shared` · `test-guard.ts` | `isTestFile`, `assessFixModeMutation`, `detectTestFileWriteInBash` — blocks edits/writes/`rm`/`sed` that touch tests or test dirs; flags assertion-weakening edits. |
| Enforcement | `@nightcode/cli` · `local-tools.ts` | `enforceFixModeGuard` runs before every FIX tool call — the choke point all tools pass through. |
| Test command | `@nightcode/cli` · `detect-project-test-command.ts` | Infers the package manager from lockfiles and the command from `package.json` (`detectPackageManager` + `detectTestCommand`). |
| Loop control | `@nightcode/shared` · `fix-loop.ts` | `FixRunController` — recognizes test runs, treats exit code as green/red, enforces the iteration budget, gates tools and stops the loop when spent. |
| Bash sandbox | `@nightcode/cli` · `sandbox.ts` | Scrubs secrets from the environment and runs FIX bash inside an OS sandbox when available (writes confined to the project dir). |
| Prompt | `@nightcode/server` · `system-prompt.ts` | The FIX system prompt: the loop, the iron no-tamper rule, the injected test command + budget, and stop-and-ask escalation. |
| UI | `@nightcode/cli` · `fix-run-status.tsx` | Status-row indicator: `● Fix bun run test · 2/6 failed`, colored by run state. |

## Using it

1. Start the server and CLI as in the main README (`bun run dev:server`, then
   `bun run dev:cli`).
2. In the CLI, open the agent picker (**Tab** → `/agents`) and choose **Fix**.
   The status row turns to the Fix accent color.
3. Point it at the problem, e.g. *"the auth tests are failing, make them pass"*.
   It will detect your test command, run the suite, read the failures, patch the
   implementation, and re-run until green — refusing any attempt to change the
   tests.
4. Watch the status row for live progress (`running tests` → `2/6 failed` →
   `tests green`, or `stopped` if the budget is spent).

If the agent decides a test itself is wrong, it stops and explains rather than
editing it — that's by design.

## Configuration & behavior

- **Iteration budget** — `DEFAULT_FIX_MAX_ITERATIONS` (6) failing runs. Once
  spent, mutating tools are refused with an instruction to summarize, and the
  auto-send loop is cut so a stuck run can't spin (or bill credits) forever.
- **Test command detection** — explicit `package.json` `test` script preferred
  (run via the detected manager: `bun run test`, `pnpm run test`, …); otherwise
  a known runner from dependencies (`vitest`, `jest`, `playwright`, …). If
  nothing is detectable, FIX still runs but without the loop oracle/budget.
- **Secret scrubbing** — FIX bash never receives environment variables whose
  names look like credentials (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `JWT_*`, …),
  so a stray `env` or a hostile test can't read them.

## Guarantees & limits

**Enforced (tested):** test files and conventional test directories cannot be
written, edited, or deleted in FIX mode — via the file tools *or* via bash
(`rm -rf __tests__`, `sed -i … foo.test.ts`, `find tests -delete`, …). The bash
detector is conservative: it never blocks read-only commands or legitimate
edits like `sed -i 's/testing/foo/' src/app.ts`.

**Best-effort:** arbitrary shell is impossible to fully police with string
analysis. The complete guarantee is the OS sandbox: with **bubblewrap** (Linux)
or **sandbox-exec** (macOS) installed, FIX bash writes are confined to the
project directory at the kernel level. Without them, the secret scrub plus the
structured guard remain in force. Install bubblewrap (`apt install bubblewrap`)
on a Linux runner to get full filesystem confinement.

## Verification

- Unit tests: the guard, command/package-manager detection, the loop controller,
  and the sandbox builders (`bun test packages/`).
- Live end-to-end: `packages/cli/src/lib/fix-loop-live.test.ts` drives a real
  broken project through the real executor + guard + controller with actual
  `bun run test` subprocesses — red → tamper blocked → minimal fix → green, plus
  budget exhaustion. The sandbox tests confirm secret scrubbing and network
  isolation against the real OS.

/**
 * Test-tamper guard.
 *
 * The Test Fixer agent's core promise is: it fixes the *implementation* until
 * the test suite passes, and it NEVER makes the suite pass by weakening,
 * skipping, or deleting tests. This module encodes that promise as pure,
 * testable policy so it can be enforced at the execution choke point
 * (and mirrored server-side) rather than merely requested in a prompt.
 *
 * Everything here is dependency-free on purpose so it can be unit tested in
 * isolation and reused on both the client and the server.
 */

/** Directory segments that, on their own, mark everything inside as test code. */
const TEST_DIR_SEGMENTS = new Set([
  "__tests__",
  "__mocks__",
  "test",
  "tests",
  "spec",
  "specs",
  "e2e",
  "cypress",
  "testing",
]);

/**
 * Filename patterns for test files across common ecosystems. These are all
 * delimiter-anchored (dots, underscores, or a capitalized `Test` word) so we
 * do NOT flag innocent files whose names merely *contain* the substring
 * "test" — e.g. `latest.ts`, `contest.ts`, `attestation.ts`, `greatest.java`.
 */
const TEST_FILE_PATTERNS: RegExp[] = [
  // JS/TS: foo.test.ts, foo.spec.tsx, foo.test.mjs, foo.cy.ts, foo.e2e.js
  /\.(test|spec|cy|e2e)\.[cm]?[jt]sx?$/i,
  // Other languages using a .test./.spec. infix
  /\.(test|spec)\.(py|rb|go|php|java|kt|kts|cs|rs|swift|dart|ex|exs)$/i,
  // Go / Python / Ruby suffix convention: foo_test.go, foo_test.py, foo_test.rb
  /_test\.(go|py|rb)$/i,
  // Python prefix convention: test_foo.py
  /^test_.+\.py$/i,
  // Ruby/RSpec: foo_spec.rb
  /_spec\.rb$/i,
  // pytest config that defines fixtures/behavior for the suite
  /^conftest\.py$/i,
  // JVM / .NET capitalized convention: FooTest.java, FooTests.cs, FooSpec.kt
  // (case-sensitive `Test`/`Spec` word so "greatest.java" does not match)
  /(Test|Tests|Spec|Specs|IT)\.(java|kt|kts|scala|cs|groovy)$/,
];

/** Normalize a path to forward slashes and strip a leading "./". */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Returns true when `path` points at test code (a test file or a file living
 * inside a conventional test directory). Conservative-but-broad: in Fix mode a
 * false positive just means "ask the human", which is the safe default.
 */
export function isTestFile(path: string): boolean {
  const normalized = normalizePath(path).trim();
  if (!normalized) return false;

  const segments = normalized.split("/").filter(Boolean);
  const base = segments[segments.length - 1] ?? "";
  const dirSegments = segments.slice(0, -1);

  if (dirSegments.some((segment) => TEST_DIR_SEGMENTS.has(segment.toLowerCase()))) {
    return true;
  }

  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(base));
}

/**
 * Heuristics for edits that make a test pass without fixing the code — i.e.
 * disabling or hollowing out a test. We scan the *added* text so that removing
 * such a marker is never flagged, only introducing one.
 */
const WEAKENING_SIGNALS: { pattern: RegExp; label: string }[] = [
  { pattern: /\b(?:it|test|describe|context)\.skip\b/, label: "adds .skip() to a test" },
  { pattern: /\b(?:it|test|describe)\.only\b/, label: "adds .only() (narrows the suite)" },
  { pattern: /\b(?:it|test|describe)\.todo\b/, label: "converts a test to .todo()" },
  { pattern: /\b(?:xit|xdescribe|xtest)\b/, label: "disables a test (xit/xdescribe)" },
  { pattern: /(?<!\.)\bpending\s*\(/, label: "adds pending() to disable a Jasmine test" },
  { pattern: /@(?:pytest\.mark\.skip|unittest\.skip)/, label: "adds a Python skip decorator" },
  { pattern: /\bt\.Skip\(/, label: "adds t.Skip() to a Go test" },
  { pattern: /@(?:Disabled|Ignore)\b/, label: "adds @Disabled/@Ignore (JVM)" },
  { pattern: /\[(?:Ignore|Skip)\b/, label: "adds [Ignore]/[Skip] (.NET)" },
  { pattern: /\bassert\s*\(\s*true\s*\)/, label: "replaces an assertion with assert(true)" },
  {
    pattern: /\bexpect\(\s*true\s*\)\.(?:toBe|toEqual)\(\s*true\s*\)/,
    label: "replaces an assertion with expect(true).toBe(true)",
  },
];

/**
 * Returns human-readable labels for any test-weakening markers found in the
 * supplied text (intended to be the *newly added* content of an edit).
 */
export function findTestWeakeningSignals(addedText: string): string[] {
  if (!addedText) return [];
  return WEAKENING_SIGNALS.filter(({ pattern }) => pattern.test(addedText)).map(
    ({ label }) => label,
  );
}

export type FixModeMutationInput = {
  toolName: string;
  /** Target path for writeFile/editFile. */
  path?: string;
  /** New content (writeFile) or replacement text (editFile). */
  addedText?: string;
};

export type FixModeAssessment =
  | { allowed: true; warnings: string[] }
  | { allowed: false; reason: string };

const MUTATING_FILE_TOOLS = new Set(["writeFile", "editFile"]);

/**
 * Policy for a single file mutation while the Test Fixer agent is running.
 *
 * - Mutating a test file is BLOCKED outright — the agent must fix the code
 *   under test, not the test.
 * - Mutating a non-test file is allowed, but any test-weakening markers in the
 *   added text are surfaced as warnings for the approval UI / audit log.
 */
export function assessFixModeMutation(input: FixModeMutationInput): FixModeAssessment {
  if (!MUTATING_FILE_TOOLS.has(input.toolName)) {
    return { allowed: true, warnings: [] };
  }

  if (input.path && isTestFile(input.path)) {
    return {
      allowed: false,
      reason:
        `Fix mode will not modify the test file "${input.path}". ` +
        "Fix the implementation so the existing tests pass; if a test itself " +
        "looks wrong, stop and ask a human instead of changing it.",
    };
  }

  return { allowed: true, warnings: findTestWeakeningSignals(input.addedText ?? "") };
}

/** Shell verbs that can overwrite, truncate, or delete a file in place. */
const MUTATING_SHELL_OPS = [
  /\bsed\s+-[a-z]*i/i, // sed -i / sed -ri ...
  /\b(?:rm|mv|cp|truncate|shred|dd)\b/i,
  /\b(?:tee)\b/i,
  /\s-delete\b/i, // find ... -delete
  />>?/, // output redirection into a file
];

/** True if any segment of `path` is a conventional test directory. */
function hasTestDirSegment(path: string): boolean {
  return normalizePath(path)
    .split("/")
    .filter(Boolean)
    .some((segment) => TEST_DIR_SEGMENTS.has(segment.toLowerCase()));
}

/**
 * A sed/`y` substitution script such as `s/testing/foo/` or `3s/a/b/g`. Its `/`
 * delimiters make it look like a path with directory segments, so it must be
 * excluded before path classification to avoid false positives (e.g. a
 * substitution containing the word `testing` is not a write to a test dir).
 */
const SED_SUBSTITUTION = /^\d*[sy]\/[^/]*\/[^/]*\//;

/**
 * Best-effort detection of test tampering hidden inside a bash command, e.g.
 * `> foo.test.ts`, `sed -i ... foo.spec.ts`, `rm __tests__/x.ts`, or wiping a
 * whole test directory with `rm -rf __tests__`.
 *
 * Conservative by design: it only fires when a *mutating* shell op co-occurs
 * with a token that points at test code, so read-only commands such as
 * `cat foo.test.ts` or `bun test` are never blocked. It may still over-block in
 * rare cases (e.g. a test-dir word in a compound command); over-blocking is the
 * safe direction here. A full guarantee for arbitrary shell needs OS sandboxing.
 */
export function detectTestFileWriteInBash(command: string): string | null {
  if (!command) return null;
  const mutates = MUTATING_SHELL_OPS.some((pattern) => pattern.test(command));
  if (!mutates) return null;

  const tokens = command.split(/[\s'"`=()<>|;&]+/).filter(Boolean);
  for (const token of tokens) {
    // Skip sed substitution scripts (e.g. `s/testing/foo/`); their delimiters
    // make them look like test-directory paths to both checks below.
    if (SED_SUBSTITUTION.test(token)) continue;

    // A conventional test directory is a valid mutating target whether bare
    // (`rm -rf __tests__`) or nested (`rm -rf src/__tests__`). isTestFile only
    // inspects directory segments *before* the basename, so it would miss a
    // trailing test dir — hence this explicit check.
    if (hasTestDirSegment(token)) return normalizePath(token);

    // Otherwise only treat path-shaped tokens as candidates (slash or dot-ext).
    if (!token.includes("/") && !token.includes(".")) continue;
    if (isTestFile(token)) return normalizePath(token);
  }
  return null;
}

/**
 * Test-command detection.
 *
 * Before the Test Fixer agent can loop "run tests → read failures → patch →
 * re-run", it needs to know how to run the suite. We infer that from the
 * project's package.json: prefer an explicit `test` script, otherwise fall
 * back to a known test runner found in the dependencies.
 *
 * Pure and dependency-free so it can be unit tested and reused anywhere.
 */

export type TestCommandSource = "script" | "framework";

export type DetectedTestCommand = {
  command: string;
  source: TestCommandSource;
};

/** The placeholder `npm init` leaves behind — not a real test command. */
const NPM_PLACEHOLDER = /no test specified/i;

/**
 * Dependency name → command to run that runner directly. Ordered by
 * preference so a project with several test-related deps picks the runner most
 * likely to be the actual suite.
 */
const FRAMEWORK_COMMANDS: { dependency: string; command: string }[] = [
  { dependency: "vitest", command: "vitest run" },
  { dependency: "jest", command: "jest" },
  { dependency: "mocha", command: "mocha" },
  { dependency: "ava", command: "ava" },
  { dependency: "@playwright/test", command: "playwright test" },
  { dependency: "node-tap", command: "tap" },
  { dependency: "uvu", command: "uvu" },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Inspect a parsed package.json object and return how to run its tests, or
 * null when nothing usable is found.
 */
export function detectTestCommand(packageJson: unknown): DetectedTestCommand | null {
  const pkg = asRecord(packageJson);
  if (!pkg) return null;

  const scripts = asRecord(pkg.scripts);
  const testScript = scripts?.test;
  if (typeof testScript === "string" && testScript.trim() && !NPM_PLACEHOLDER.test(testScript)) {
    return { command: "npm test", source: "script" };
  }

  const dependencyNames = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    const deps = asRecord(pkg[key]);
    if (deps) {
      for (const name of Object.keys(deps)) dependencyNames.add(name);
    }
  }

  for (const { dependency, command } of FRAMEWORK_COMMANDS) {
    if (dependencyNames.has(dependency)) {
      return { command, source: "framework" };
    }
  }

  return null;
}

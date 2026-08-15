/**
 * Test-command detection.
 *
 * Before the Test Fixer agent can loop "run tests → read failures → patch →
 * re-run", it needs to know how to run the suite. We infer that from the
 * project's package.json: prefer the project's own `test` script (run through
 * the detected package manager), otherwise fall back to a known test runner
 * found in the dependencies.
 *
 * Pure and dependency-free so it can be unit tested and reused anywhere.
 */

export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

export type TestCommandSource = "script" | "framework";

export type DetectedTestCommand = {
  command: string;
  source: TestCommandSource;
};

/** The placeholder `npm init` leaves behind — not a real test command. */
const NPM_PLACEHOLDER = /no test specified/i;

/** How each package manager runs a locally-installed binary (the framework case). */
const EXEC_PREFIX: Record<PackageManager, string> = {
  npm: "npx",
  yarn: "yarn",
  pnpm: "pnpm exec",
  bun: "bunx",
};

/**
 * Dependency name → bare command to run that runner. Ordered by preference so a
 * project with several test-related deps picks the runner most likely to be the
 * actual suite. The package manager's exec prefix is applied by the caller.
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

/** Lock file → the package manager that produced it. */
const LOCKFILE_MANAGERS: { lockfile: string; manager: PackageManager }[] = [
  { lockfile: "bun.lock", manager: "bun" },
  { lockfile: "bun.lockb", manager: "bun" },
  { lockfile: "pnpm-lock.yaml", manager: "pnpm" },
  { lockfile: "yarn.lock", manager: "yarn" },
  { lockfile: "package-lock.json", manager: "npm" },
  { lockfile: "npm-shrinkwrap.json", manager: "npm" },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Infer the package manager from the lock files present in a project directory.
 * Pass the directory's file names (e.g. from readdir). Defaults to npm.
 */
export function detectPackageManager(lockfiles: string[]): PackageManager {
  const present = new Set(lockfiles);
  for (const { lockfile, manager } of LOCKFILE_MANAGERS) {
    if (present.has(lockfile)) return manager;
  }
  return "npm";
}

/**
 * Inspect a parsed package.json object and return how to run its tests, or null
 * when nothing usable is found. Commands are tailored to `packageManager` so a
 * Bun project is told to run `bun run test`, not `npm test`.
 */
export function detectTestCommand(
  packageJson: unknown,
  packageManager: PackageManager = "npm",
): DetectedTestCommand | null {
  const pkg = asRecord(packageJson);
  if (!pkg) return null;

  const scripts = asRecord(pkg.scripts);
  const testScript = scripts?.test;
  if (typeof testScript === "string" && testScript.trim() && !NPM_PLACEHOLDER.test(testScript)) {
    return { command: `${packageManager} run test`, source: "script" };
  }

  const dependencyNames = new Set<string>();
  for (const key of ["dependencies", "devDependencies"] as const) {
    const deps = asRecord(pkg[key]);
    if (deps) {
      for (const name of Object.keys(deps)) dependencyNames.add(name);
    }
  }

  for (const { dependency, command } of FRAMEWORK_COMMANDS) {
    if (dependencyNames.has(dependency)) {
      return { command: `${EXEC_PREFIX[packageManager]} ${command}`, source: "framework" };
    }
  }

  return null;
}

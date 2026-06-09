/**
 * Bash sandboxing for the Test Fixer.
 *
 * In FIX mode the agent runs unattended, so its bash calls get two extra layers
 * of containment beyond the structured test-tamper guard:
 *
 * 1. Secret scrubbing — the executor previously forwarded the user's entire
 *    environment (API keys, tokens, DB URLs) into every shell command. We strip
 *    variables whose names look like credentials so a stray `env` or a hostile
 *    test cannot read them. This works on every platform.
 *
 * 2. OS sandbox — when a kernel sandbox is available we run the command inside
 *    it, confining filesystem writes to the project directory (and optionally
 *    cutting network). Bubblewrap (Linux) gives full fs confinement;
 *    `sandbox-exec` (macOS) likewise; `unshare` (Linux fallback) can only
 *    isolate the network. When none is available we fall back to a plain shell
 *    plus the scrub and the structured guard, and report that honestly.
 *
 * The argv builders are pure so they can be unit tested; detection is a thin
 * runtime probe.
 */
import { platform } from "os";

export type SandboxMechanism = "bubblewrap" | "sandbox-exec" | "unshare" | "none";

export type SandboxPolicy = {
  /** Directory the command may write to; everything else is read-only. */
  writableDir: string;
  /** Cut all network access. Off by default — test suites often need network. */
  blockNetwork?: boolean;
};

/**
 * Variable names that indicate a secret. Matched case-insensitively against the
 * whole name, so `ANTHROPIC_API_KEY`, `npm_token`, `AWS_SECRET_ACCESS_KEY`,
 * `CLERK_SECRET_KEY`, `JWT_SECRET`, etc. are all dropped, while ordinary vars
 * like `PATH`, `HOME`, `CI`, or `NODE_ENV` are kept so tests still run.
 */
const SECRET_NAME =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|APIKEY|ACCESS[_-]?KEY|SESSION|COOKIE|JWT|DSN)/i;

/**
 * Return a copy of `env` with credential-looking variables removed and a
 * non-interactive TERM. Pure: does not read or mutate the real environment.
 */
export function scrubEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (SECRET_NAME.test(name)) continue;
    out[name] = value;
  }
  out.TERM = "dumb";
  return out;
}

/** The handful of device nodes ordinary programs need; far narrower than all of /dev. */
const ALLOWED_DEVICE_NODES = [
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/tty",
  "/dev/dtracehelper",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
];

/** A `sandbox-exec` (macOS) profile: read anywhere, write only under the project. */
export function macSandboxProfile(policy: SandboxPolicy): string {
  const dir = policy.writableDir;
  // Writes are confined to the project dir. The system temp dirs stay writable
  // because build/test tooling routinely needs them (their contents are
  // transient and not the user's source); /dev is narrowed from the whole tree
  // to the specific nodes programs actually use.
  const deviceRules = ALLOWED_DEVICE_NODES.map((node) => `(literal ${JSON.stringify(node)})`).join(
    " ",
  );
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${JSON.stringify(dir)}) (subpath "/tmp") (subpath "/private/tmp") (subpath "/dev/fd") ${deviceRules})`,
    policy.blockNetwork ? "(deny network*)" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Build the full argv that runs `command` under the given sandbox mechanism.
 * Pure — the mechanism is passed in so this can be unit tested for every OS.
 */
export function buildSandboxArgv(
  mechanism: SandboxMechanism,
  command: string,
  policy: SandboxPolicy,
): string[] {
  switch (mechanism) {
    case "bubblewrap":
      return [
        "bwrap",
        "--ro-bind", "/", "/",
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", "/tmp",
        "--bind", policy.writableDir, policy.writableDir,
        "--chdir", policy.writableDir,
        "--die-with-parent",
        "--new-session",
        ...(policy.blockNetwork ? ["--unshare-net"] : []),
        "--", "bash", "-c", command,
      ];
    case "sandbox-exec":
      return ["sandbox-exec", "-p", macSandboxProfile(policy), "bash", "-c", command];
    case "unshare":
      // No filesystem confinement without bubblewrap; this only isolates the
      // network, so it is only meaningfully a sandbox when blockNetwork is set.
      return [
        "unshare",
        "--map-root-user",
        ...(policy.blockNetwork ? ["--net"] : []),
        "--",
        "bash", "-c", command,
      ];
    case "none":
      return ["bash", "-c", command];
  }
}

let cachedMechanism: SandboxMechanism | undefined;

/** Detect the best sandbox available on this machine (cached after first call). */
export function detectSandboxMechanism(): SandboxMechanism {
  if (cachedMechanism !== undefined) return cachedMechanism;

  const os = platform();
  if (os === "darwin" && Bun.which("sandbox-exec")) {
    cachedMechanism = "sandbox-exec";
  } else if (os === "linux" && Bun.which("bwrap")) {
    cachedMechanism = "bubblewrap";
  } else if (os === "linux" && Bun.which("unshare")) {
    cachedMechanism = "unshare";
  } else {
    cachedMechanism = "none";
  }
  return cachedMechanism;
}

/**
 * Whether the detected mechanism actually confines the filesystem. `unshare`
 * and `none` do not, so the structured tamper guard remains the primary
 * protection there. Callers can surface this to set expectations.
 */
export function sandboxConfinesFilesystem(mechanism: SandboxMechanism): boolean {
  return mechanism === "bubblewrap" || mechanism === "sandbox-exec";
}

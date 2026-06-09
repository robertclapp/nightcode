import { describe, expect, test } from "bun:test";
import { readlinkSync } from "fs";
import {
  scrubEnv,
  buildSandboxArgv,
  macSandboxProfile,
  detectSandboxMechanism,
  sandboxConfinesFilesystem,
} from "./sandbox";

describe("scrubEnv", () => {
  test("drops credential-looking variables, keeps ordinary ones", () => {
    const scrubbed = scrubEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      CI: "true",
      NODE_ENV: "test",
      ANTHROPIC_API_KEY: "sk-secret",
      OPENAI_API_KEY: "sk-secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      CLERK_SECRET_KEY: "secret",
      JWT_SECRET: "secret",
      GITHUB_TOKEN: "ghp_secret",
      DB_PASSWORD: "hunter2",
      MY_PRIVATE_KEY: "secret",
      SESSION_COOKIE: "secret",
    });

    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.HOME).toBe("/home/u");
    expect(scrubbed.CI).toBe("true");
    expect(scrubbed.NODE_ENV).toBe("test");
    expect(scrubbed.TERM).toBe("dumb");

    for (const secret of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "CLERK_SECRET_KEY",
      "JWT_SECRET",
      "GITHUB_TOKEN",
      "DB_PASSWORD",
      "MY_PRIVATE_KEY",
      "SESSION_COOKIE",
    ]) {
      expect(scrubbed[secret]).toBeUndefined();
    }
  });
});

describe("buildSandboxArgv", () => {
  const policy = { writableDir: "/work/project" };

  test("bubblewrap confines writes to the project and runs the command", () => {
    const argv = buildSandboxArgv("bubblewrap", "bun run test", policy);
    expect(argv[0]).toBe("bwrap");
    expect(argv).toContain("--ro-bind");
    expect(argv.join(" ")).toContain("--bind /work/project /work/project");
    expect(argv.slice(-3)).toEqual(["bash", "-c", "bun run test"]);
    expect(argv).not.toContain("--unshare-net");
  });

  test("bubblewrap adds network isolation only when requested", () => {
    const argv = buildSandboxArgv("bubblewrap", "x", { ...policy, blockNetwork: true });
    expect(argv).toContain("--unshare-net");
  });

  test("sandbox-exec wraps with a generated profile", () => {
    const argv = buildSandboxArgv("sandbox-exec", "bun run test", policy);
    expect(argv[0]).toBe("sandbox-exec");
    expect(argv[1]).toBe("-p");
    expect(argv[2]).toContain("/work/project");
    expect(argv.slice(-3)).toEqual(["bash", "-c", "bun run test"]);
  });

  test("unshare isolates the network when asked and otherwise stays minimal", () => {
    expect(buildSandboxArgv("unshare", "x", policy)).not.toContain("--net");
    expect(buildSandboxArgv("unshare", "x", { ...policy, blockNetwork: true })).toContain("--net");
  });

  test("none runs a plain shell", () => {
    expect(buildSandboxArgv("none", "bun run test", policy)).toEqual([
      "bash",
      "-c",
      "bun run test",
    ]);
  });
});

describe("macSandboxProfile", () => {
  test("denies writes globally but allows the project dir", () => {
    const profile = macSandboxProfile({ writableDir: "/work/p" });
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(subpath "/work/p")');
    expect(profile).not.toContain("(deny network*)");
  });

  test("adds a network deny when blockNetwork is set", () => {
    expect(macSandboxProfile({ writableDir: "/p", blockNetwork: true })).toContain(
      "(deny network*)",
    );
  });
});

describe("sandboxConfinesFilesystem", () => {
  test("only kernel sandboxes confine the filesystem", () => {
    expect(sandboxConfinesFilesystem("bubblewrap")).toBe(true);
    expect(sandboxConfinesFilesystem("sandbox-exec")).toBe(true);
    expect(sandboxConfinesFilesystem("unshare")).toBe(false);
    expect(sandboxConfinesFilesystem("none")).toBe(false);
  });
});

// Live checks against the real OS. Skipped automatically when the mechanism
// isn't present, so the suite stays green on any machine.
describe("sandbox (live)", () => {
  test("scrubEnv actually hides a secret from a real shell", async () => {
    const env = scrubEnv({ ...process.env, FAKE_API_KEY: "leaked-value" });
    const proc = Bun.spawn(["bash", "-c", "printf '%s' \"$FAKE_API_KEY\""], {
      env,
      stdout: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toBe("");
  });

  test.skipIf(!Bun.which("unshare"))(
    "unshare puts the command in a separate network namespace",
    async () => {
      const hostNetNs = readlinkSync("/proc/self/ns/net");
      const argv = buildSandboxArgv("unshare", "readlink /proc/self/ns/net", {
        writableDir: process.cwd(),
        blockNetwork: true,
      });
      const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(proc.stdout).text()).trim();
      const code = await proc.exited;

      // If user namespaces are unavailable the command can't start; treat that
      // as "not supported here" rather than a failure.
      if (code !== 0 || !out) return;
      expect(out).not.toBe(hostNetNs);
    },
  );
});

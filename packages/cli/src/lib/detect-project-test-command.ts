import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  detectPackageManager,
  detectTestCommand,
  type DetectedTestCommand,
} from "@nightcode/shared";

/**
 * Work out how to run the current project's test suite: infer the package
 * manager from the lock files in cwd, then derive the command from
 * package.json. Returns null when the project has no detectable suite (no
 * package.json, no test script, no known runner) — in that case a FIX run
 * proceeds without the loop oracle and budget.
 */
export function detectProjectTestCommand(cwd = process.cwd()): DetectedTestCommand | null {
  try {
    const entries = readdirSync(cwd);
    const packageManager = detectPackageManager(entries);
    const packageJson = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8"));
    return detectTestCommand(packageJson, packageManager);
  } catch {
    return null;
  }
}

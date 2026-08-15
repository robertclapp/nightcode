import { describe, expect, test } from "bun:test";
import {
  isTestFile,
  findTestWeakeningSignals,
  assessFixModeMutation,
  detectTestFileWriteInBash,
} from "./test-guard";

describe("isTestFile", () => {
  test.each([
    "src/math.test.ts",
    "src/math.spec.tsx",
    "lib/util.test.mjs",
    "e2e/login.cy.ts",
    "ui/button.e2e.js",
    "pkg/server_test.go",
    "app/test_views.py",
    "models/user_test.py",
    "lib/user_spec.rb",
    "conftest.py",
    "src/conftest.py",
    "src/main/java/com/x/UserServiceTest.java",
    "Project/Foo.Tests.cs",
    "app/PaymentSpec.kt",
    "it/CheckoutIT.java",
    "__tests__/helpers.ts",
    "tests/test_helpers.py",
    "test/support.rb",
    "spec/models/order.rb",
    "cypress/e2e/flow.ts",
    "src/testing/fixtures.ts",
    "__mocks__/fs.ts",
    "src\\windows\\path.test.ts",
  ])("flags test path: %s", (path) => {
    expect(isTestFile(path)).toBe(true);
  });

  // The important part: do NOT flag files that merely contain "test" as a
  // substring, or non-test source files.
  test.each([
    "src/latest.ts",
    "src/contest.ts",
    "lib/attestation.ts",
    "src/Greatest.java",
    "components/Testimonial.tsx",
    "scripts/protest.py",
    "src/testUtils.ts",
    "src/index.ts",
    "packages/server/src/routes/chat.ts",
    "latest/config.ts",
    "docs/testing-guide.md",
  ])("does not flag non-test path: %s", (path) => {
    expect(isTestFile(path)).toBe(false);
  });
});

describe("findTestWeakeningSignals", () => {
  test.each([
    "it.skip('does a thing', () => {})",
    "describe.only('suite', () => {})",
    "test.todo('later')",
    "xit('disabled', () => {})",
    "pending('not implemented yet')",
    "@pytest.mark.skip(reason='flaky')",
    't.Skip("flaky on CI")',
    "@Disabled",
    "expect(true).toBe(true)",
    "assert(true)",
  ])("detects weakening in: %s", (snippet) => {
    expect(findTestWeakeningSignals(snippet).length).toBeGreaterThan(0);
  });

  test.each([
    "expect(sum(1, 2)).toBe(3)",
    "const skip = computeSkip(items)", // "skip" as an identifier, not .skip()
    "return user.isActive",
    "queue.pending()", // a method named pending(), not the Jasmine global
    "const pendingCount = getPending()",
    "",
  ])("ignores legitimate code: %s", (snippet) => {
    expect(findTestWeakeningSignals(snippet)).toEqual([]);
  });
});

describe("assessFixModeMutation", () => {
  test("blocks writing a test file", () => {
    const result = assessFixModeMutation({
      toolName: "writeFile",
      path: "src/math.test.ts",
      addedText: "anything",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain("src/math.test.ts");
  });

  test("blocks editing a test file", () => {
    const result = assessFixModeMutation({
      toolName: "editFile",
      path: "__tests__/user.ts",
      addedText: "x",
    });
    expect(result.allowed).toBe(false);
  });

  test("allows editing a non-test file", () => {
    const result = assessFixModeMutation({
      toolName: "editFile",
      path: "src/math.ts",
      addedText: "export const add = (a, b) => a + b;",
    });
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.warnings).toEqual([]);
  });

  test("allows but warns when a non-test edit weakens assertions", () => {
    const result = assessFixModeMutation({
      toolName: "editFile",
      path: "src/math.ts",
      addedText: "// expect(true).toBe(true)",
    });
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("never blocks a read-only tool, even on a test path", () => {
    const result = assessFixModeMutation({ toolName: "readFile", path: "src/x.test.ts" });
    expect(result.allowed).toBe(true);
  });
});

describe("detectTestFileWriteInBash", () => {
  test.each([
    ["sed -i 's/a/b/' src/math.test.ts", "src/math.test.ts"],
    ["echo '' > src/math.spec.ts", "src/math.spec.ts"],
    ["rm __tests__/user.ts", "__tests__/user.ts"],
    ["printf '' > ./src/api.test.ts", "src/api.test.ts"],
    // Whole test-directory wipes — the P1 vector: bare and nested.
    ["rm -rf __tests__", "__tests__"],
    ["rm -rf tests", "tests"],
    ["mv spec spec_old", "spec"],
    ["rm -rf src/__tests__", "src/__tests__"],
    ["find tests -delete", "tests"],
    // A sed script is skipped, but a sed write to a real test file is blocked.
    ["sed -i 's/test/x/' src/__tests__/a.ts", "src/__tests__/a.ts"],
  ])("blocks mutating command %s", (command, expected) => {
    expect(detectTestFileWriteInBash(command)).toBe(expected);
  });

  test.each([
    "cat src/math.test.ts", // read-only
    "bun test",
    "npm test",
    "rm -rf dist",
    "rm -rf node_modules",
    "rm -rf test-results", // build output, not a conventional test dir
    "mkdir tests", // creating (not mutating) a test dir is fine
    "echo hi > notes.txt",
    "grep -r skip src/math.test.ts",
    // sed substitution scripts whose pattern merely contains a test-dir word
    // must not be treated as writes to a test directory.
    "sed -i 's/testing/foo/' src/app.ts",
    "sed -i 's/spec/replaced/g' src/config.ts",
  ])("allows non-tampering command: %s", (command) => {
    expect(detectTestFileWriteInBash(command)).toBeNull();
  });
});

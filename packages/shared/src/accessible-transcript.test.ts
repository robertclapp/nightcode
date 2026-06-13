import { describe, expect, test } from "bun:test";
import {
  humanizeToolName,
  describeToolPart,
  renderTranscriptMessage,
  renderTranscript,
  announceError,
  announceFixRun,
  type TranscriptMessage,
} from "./accessible-transcript";

describe("humanizeToolName", () => {
  test.each([
    ["readFile", "Read file"],
    ["writeFile", "Write file"],
    ["listDirectory", "List directory"],
    ["bash", "Bash"],
    ["detectTestFileWriteInBash", "Detect test file write in bash"],
  ])("%s -> %s", (input, expected) => {
    expect(humanizeToolName(input)).toBe(expected);
  });
});

describe("describeToolPart", () => {
  test("done with a target", () => {
    expect(describeToolPart({ kind: "tool", name: "readFile", status: "done", summary: "src/x.ts" })).toBe(
      "ran Read file src/x.ts",
    );
  });
  test("running", () => {
    expect(describeToolPart({ kind: "tool", name: "bash", status: "running", summary: "bun test" })).toBe(
      "ran Bash bun test (in progress)",
    );
  });
  test("error with detail", () => {
    expect(
      describeToolPart({ kind: "tool", name: "editFile", status: "error", detail: "oldString not found" }),
    ).toBe("ran Edit file — failed: oldString not found");
  });
});

describe("renderTranscriptMessage", () => {
  test("labels the speaker and drops empty text", () => {
    const message: TranscriptMessage = {
      role: "user",
      parts: [
        { kind: "text", text: "fix the failing tests" },
        { kind: "text", text: "   " },
      ],
    };
    expect(renderTranscriptMessage(message)).toEqual(["You: fix the failing tests"]);
  });

  test("announces reasoning and tool calls for the assistant", () => {
    const message: TranscriptMessage = {
      role: "assistant",
      parts: [
        { kind: "reasoning", text: "The add function subtracts." },
        { kind: "tool", name: "readFile", status: "done", summary: "math.ts" },
        { kind: "text", text: "Found the bug." },
      ],
    };
    expect(renderTranscriptMessage(message)).toEqual([
      "Assistant (thinking): The add function subtracts.",
      "Assistant ran Read file math.ts",
      "Assistant: Found the bug.",
    ]);
  });
});

describe("renderTranscript", () => {
  test("joins messages into linear plain text with no visual-only glyphs", () => {
    const out = renderTranscript([
      { role: "user", parts: [{ kind: "text", text: "hello" }] },
      { role: "assistant", parts: [{ kind: "text", text: "hi there" }] },
    ]);
    expect(out).toBe("You: hello\nAssistant: hi there");
    // No box-drawing, bullets, or spinner glyphs that a screen reader would choke on.
    expect(out).not.toMatch(/[│┃╹◉●…]/);
  });
});

describe("announcements", () => {
  test("error", () => {
    expect(announceError("Session not found")).toBe("Error: Session not found");
  });

  test.each([
    [{ state: "green" as const, failedRuns: 1, maxIterations: 6 }, /now passing/],
    [{ state: "exhausted" as const, failedRuns: 6, maxIterations: 6 }, /stopped after using the budget/],
    [{ state: "running" as const, failedRuns: 0, maxIterations: 6 }, /running the tests/],
    [{ state: "running" as const, failedRuns: 2, maxIterations: 6 }, /2 of 6 attempts used/],
  ])("fix run %p", (snapshot, pattern) => {
    expect(announceFixRun(snapshot)).toMatch(pattern);
  });
});

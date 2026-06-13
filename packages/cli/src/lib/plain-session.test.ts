import { describe, expect, test } from "bun:test";
import type { TranscriptMessage } from "@nightcode/shared";
import type { Message } from "../hooks/use-chat";
import { toTranscriptMessage, runPlainSession } from "./plain-session";
import { isPlainMode } from "./plain-mode";

/** Build a Message-shaped fixture (the real type is too strict to construct by hand). */
function message(role: "user" | "assistant", parts: unknown[]): Message {
  return { id: "m", role, parts } as unknown as Message;
}

async function* lines(items: string[]): AsyncGenerator<string> {
  for (const item of items) yield item;
}

describe("toTranscriptMessage", () => {
  test("maps text, reasoning, and tool parts", () => {
    const result = toTranscriptMessage(
      message("assistant", [
        { type: "text", text: "Looking into it." },
        { type: "reasoning", text: "subtracts instead of adds" },
        { type: "tool-readFile", toolCallId: "1", state: "output-available", input: { path: "math.ts" } },
        {
          type: "tool-editFile",
          toolCallId: "2",
          state: "output-error",
          input: { path: "math.ts", oldString: "x" },
          errorText: "not found",
        },
      ]),
    );

    expect(result).toEqual({
      role: "assistant",
      parts: [
        { kind: "text", text: "Looking into it." },
        { kind: "reasoning", text: "subtracts instead of adds" },
        { kind: "tool", name: "readFile", status: "done", summary: "math.ts", detail: undefined },
        { kind: "tool", name: "editFile", status: "error", summary: "math.ts x", detail: "not found" },
      ],
    });
  });

  test("handles dynamic-tool and maps user role", () => {
    const result = toTranscriptMessage(
      message("user", [{ type: "dynamic-tool", toolName: "bash", toolCallId: "1", state: "input-available", input: { command: "ls" } }]),
    );
    expect(result.role).toBe("user");
    expect(result.parts[0]).toEqual({
      kind: "tool",
      name: "bash",
      status: "running",
      summary: "ls",
      detail: undefined,
    });
  });
});

describe("runPlainSession", () => {
  test("announces prior conversation, echoes input, and renders replies", async () => {
    const out: string[] = [];
    const initialMessages: TranscriptMessage[] = [
      { role: "user", parts: [{ kind: "text", text: "earlier question" }] },
    ];
    const sendTurn = async (text: string): Promise<TranscriptMessage[]> => [
      { role: "assistant", parts: [{ kind: "text", text: `reply to ${text}` }] },
    ];

    await runPlainSession({
      input: lines(["", "hello", "/exit", "ignored after exit"]),
      print: (line) => out.push(line),
      sendTurn,
      initialMessages,
    });

    expect(out).toEqual([
      "You: earlier question",
      "You: hello",
      "Assistant: reply to hello",
    ]);
  });

  test("announces an error when a turn fails", async () => {
    const out: string[] = [];
    await runPlainSession({
      input: lines(["boom", "/quit"]),
      print: (line) => out.push(line),
      sendTurn: async () => {
        throw new Error("network down");
      },
    });
    expect(out).toEqual(["You: boom", "Error: network down"]);
  });
});

describe("isPlainMode", () => {
  test("detects --plain and NIGHTCODE_PLAIN, ignores off values", () => {
    expect(isPlainMode(["node", "cli", "--plain"], {})).toBe(true);
    expect(isPlainMode([], { NIGHTCODE_PLAIN: "1" })).toBe(true);
    expect(isPlainMode([], { NIGHTCODE_PLAIN: "0" })).toBe(false);
    expect(isPlainMode([], {})).toBe(false);
  });
});

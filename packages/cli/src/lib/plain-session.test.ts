import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CHAT_MODEL_ID,
  SUPPORTED_CHAT_MODELS,
  type TranscriptMessage,
} from "@nightcode/shared";
import type { Message } from "../hooks/use-chat";
import { toTranscriptMessage, runPlainSession } from "./plain-session";
import {
  interpretCommand,
  isPlainMode,
  parseModeCommand,
  parseModelCommand,
  renderModelList,
  resolveModelCommand,
} from "./plain-mode";

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
        // editFile summarizes to its path only — the old/new strings are not read aloud.
        { kind: "tool", name: "editFile", status: "error", summary: "math.ts", detail: "not found" },
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

  test("summarizes to an identifier — never a file body or an option blob", () => {
    const result = toTranscriptMessage(
      message("assistant", [
        { type: "tool-writeFile", toolCallId: "1", state: "output-available", input: { path: "a.ts", content: "x".repeat(5000) } },
        { type: "tool-bash", toolCallId: "2", state: "output-available", input: { command: "bun test", timeout: 30000 } },
      ]),
    );
    const summaries = result.parts.map((p) => (p.kind === "tool" ? p.summary : undefined));
    // The 5000-char body and the numeric timeout must NOT leak into the spoken line.
    expect(summaries).toEqual(["a.ts", "bun test"]);
  });

  test("truncates an over-long identifier", () => {
    const result = toTranscriptMessage(
      message("assistant", [
        { type: "tool-readFile", toolCallId: "1", state: "output-available", input: { path: "a/".repeat(100) + "x.ts" } },
      ]),
    );
    const summary = result.parts[0]?.kind === "tool" ? result.parts[0].summary : undefined;
    expect(summary?.endsWith("…")).toBe(true);
    expect(summary!.length).toBeLessThanOrEqual(81);
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

  test("only slash commands exit; bare 'exit'/'quit' are sent as messages", async () => {
    const out: string[] = [];
    const seen: string[] = [];
    await runPlainSession({
      input: lines(["exit", "QUIT", "/exit", "after"]),
      print: (line) => out.push(line),
      sendTurn: async (text) => {
        seen.push(text);
        return [{ role: "assistant", parts: [{ kind: "text", text: `ok ${text}` }] }];
      },
    });
    // "exit"/"QUIT" go to the model; only "/exit" terminates, so "after" is never seen.
    expect(seen).toEqual(["exit", "QUIT"]);
    expect(out).toEqual([
      "You: exit",
      "Assistant: ok exit",
      "You: QUIT",
      "Assistant: ok QUIT",
    ]);
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

describe("parseModeCommand", () => {
  test("maps mode commands case-insensitively and ignores the rest", () => {
    expect(parseModeCommand("/build")).toBe("BUILD");
    expect(parseModeCommand("  /PLAN ")).toBe("PLAN");
    expect(parseModeCommand("/fix")).toBe("FIX");
    expect(parseModeCommand("/exit")).toBeNull();
    expect(parseModeCommand("hello")).toBeNull();
  });
});

describe("model command", () => {
  test("parseModelCommand extracts the argument, or null when it isn't one", () => {
    expect(parseModelCommand("/model")).toEqual({ arg: "" });
    expect(parseModelCommand("/model opus")).toEqual({ arg: "opus" });
    expect(parseModelCommand("  /MODEL  2 ")).toEqual({ arg: "2" });
    expect(parseModelCommand("/models")).toBeNull();
    expect(parseModelCommand("hello")).toBeNull();
  });

  test("resolveModelCommand: list, index, exact id, and unique substring", () => {
    const models = SUPPORTED_CHAT_MODELS;
    expect(resolveModelCommand("", models, DEFAULT_CHAT_MODEL_ID)).toEqual({ kind: "list" });
    expect(resolveModelCommand("1", models, DEFAULT_CHAT_MODEL_ID)).toEqual({ kind: "set", model: models[0] });
    expect(resolveModelCommand("claude-haiku-4-5", models, DEFAULT_CHAT_MODEL_ID)).toMatchObject({
      kind: "set",
      model: { id: "claude-haiku-4-5" },
    });
    expect(resolveModelCommand("opus", models, DEFAULT_CHAT_MODEL_ID)).toMatchObject({
      kind: "set",
      model: { id: "claude-opus-4-6" },
    });
  });

  test("resolveModelCommand reports out-of-range, ambiguous, and unknown", () => {
    const models = SUPPORTED_CHAT_MODELS;
    expect(resolveModelCommand("99", models, DEFAULT_CHAT_MODEL_ID).kind).toBe("error");
    const ambiguous = resolveModelCommand("gpt", models, DEFAULT_CHAT_MODEL_ID);
    expect(ambiguous.kind === "error" && ambiguous.message).toMatch(/matches 3 models/);
    expect(resolveModelCommand("zzz", models, DEFAULT_CHAT_MODEL_ID).kind).toBe("error");
  });

  test("renderModelList marks the current model and gives a switch hint", () => {
    const list = renderModelList(SUPPORTED_CHAT_MODELS, "claude-opus-4-6");
    expect(list).toMatch(/current: claude-opus-4-6/);
    expect(list).toMatch(/claude-opus-4-6 \(anthropic\) — current/);
    expect(list).toMatch(/Switch with \/model/);
  });

  test("interpretCommand routes help, model, mode, and plain turns", () => {
    const state = { mode: "BUILD", model: "claude-opus-4-6" } as const;

    const help = interpretCommand("/help", state);
    expect(help.kind === "reply" && help.text).toMatch(/Commands:/);

    expect(interpretCommand("/model sonnet", state)).toEqual({
      kind: "reply",
      text: "Model set to claude-sonnet-4-6.",
      model: "claude-sonnet-4-6",
    });

    const list = interpretCommand("/model", state);
    expect(list.kind).toBe("reply");
    expect(list.kind === "reply" && list.model).toBeUndefined();

    expect(interpretCommand("/fix", state)).toEqual({
      kind: "reply",
      text: "Mode set to fix.",
      mode: "FIX",
    });

    expect(interpretCommand("just a question", state)).toEqual({ kind: "turn" });
  });
});

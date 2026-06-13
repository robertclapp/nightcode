import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatTransport, UIMessageChunk } from "ai";
import { DEFAULT_CHAT_MODEL_ID, FixRunController, Mode } from "@nightcode/shared";
import {
  createAgentSession,
  handleAgentToolCall,
  type AgentChatPort,
} from "./agent-session";
import type { Message } from "../hooks/use-chat";

/** A capturing chat port whose last message carries the given mode. */
function fakeChat(mode: string) {
  const outputs: Array<Record<string, unknown>> = [];
  const chat: AgentChatPort = {
    messages: [{ role: "assistant", metadata: { mode }, parts: [] }] as unknown as Message[],
    addToolOutput: (args) => {
      outputs.push(args as Record<string, unknown>);
    },
  };
  return { chat, outputs };
}

describe("handleAgentToolCall", () => {
  test("runs the tool and reports its output (BUILD)", async () => {
    const { chat, outputs } = fakeChat(Mode.BUILD);
    await handleAgentToolCall({
      chat,
      toolCall: { toolName: "readFile", toolCallId: "1", input: { path: "x" } },
      getFixRunController: () => null,
      onFixRunChange: () => {},
      execute: async () => ({ content: "hi" }),
    });
    expect(outputs).toEqual([{ tool: "readFile", toolCallId: "1", output: { content: "hi" } }]);
  });

  test("reports an error output when the tool throws", async () => {
    const { chat, outputs } = fakeChat(Mode.BUILD);
    await handleAgentToolCall({
      chat,
      toolCall: { toolName: "bash", toolCallId: "1", input: { command: "false" } },
      getFixRunController: () => null,
      onFixRunChange: () => {},
      execute: async () => {
        throw new Error("boom");
      },
    });
    expect(outputs).toEqual([
      { tool: "bash", toolCallId: "1", state: "output-error", errorText: "boom" },
    ]);
  });

  test("refuses a mutating tool once the FIX budget is spent, without running it", async () => {
    const fix = new FixRunController({ testCommand: "bun test", maxIterations: 1 });
    fix.observeBashResult("bun test", 1); // one failing run exhausts the budget
    const { chat, outputs } = fakeChat(Mode.FIX);
    let snapshotSeen = false;

    await handleAgentToolCall({
      chat,
      toolCall: { toolName: "writeFile", toolCallId: "1", input: { path: "a.ts", content: "x" } },
      getFixRunController: () => fix,
      onFixRunChange: () => {
        snapshotSeen = true;
      },
      execute: async () => {
        throw new Error("executor must not run after a refusal");
      },
    });

    expect(outputs[0]?.state).toBe("output-error");
    expect(String(outputs[0]?.errorText)).toContain("Fix run stopped");
    expect(snapshotSeen).toBe(true);
  });

  test("folds a failing test run into the bash output (FIX)", async () => {
    const fix = new FixRunController({ testCommand: "bun test", maxIterations: 6 });
    const { chat, outputs } = fakeChat(Mode.FIX);

    await handleAgentToolCall({
      chat,
      toolCall: { toolName: "bash", toolCallId: "1", input: { command: "bun test" } },
      getFixRunController: () => fix,
      onFixRunChange: () => {},
      execute: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
    });

    expect((outputs[0]?.output as { fixRun?: unknown }).fixRun).toEqual({
      failedRuns: 1,
      remainingBudget: 5,
    });
  });
});

/** A ReadableStream emitting the given UI-message chunks in order. */
function chunkStream(chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("createAgentSession", () => {
  let dir: string;
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "nc-agent-"));
    writeFileSync(join(dir, "note.txt"), "hello from disk", "utf-8");
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  test("drives the full tool loop and resolves with the assistant turn", async () => {
    // Round 1: the model talks, then calls readFile. Round 2 (after we feed the
    // real tool result back): it wraps up. A fake transport stands in for the
    // server so the test exercises the loop, not the network.
    let call = 0;
    const transport: ChatTransport<Message> = {
      sendMessages: async () => {
        call += 1;
        if (call === 1) {
          return chunkStream([
            { type: "start" },
            { type: "start-step" },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Reading the note." },
            { type: "text-end", id: "t1" },
            { type: "tool-input-available", toolCallId: "c1", toolName: "readFile", input: { path: "note.txt" } },
            { type: "finish-step" },
            { type: "finish" },
          ]);
        }
        return chunkStream([
          { type: "start" },
          { type: "start-step" },
          { type: "text-start", id: "t2" },
          { type: "text-delta", id: "t2", delta: "The note says hello from disk." },
          { type: "text-end", id: "t2" },
          { type: "finish-step" },
          { type: "finish" },
        ]);
      },
      reconnectToStream: async () => null,
    };

    const session = createAgentSession({ sessionId: "s1", transport });
    const replies = await session.sendTurn("read the note", {
      mode: Mode.BUILD,
      model: DEFAULT_CHAT_MODEL_ID,
    });

    // One assistant message holding the whole turn (the SDK accumulates the
    // multi-step tool loop into a single message with step boundaries).
    expect(replies).toHaveLength(1);
    expect(replies[0]!.role).toBe("assistant");

    // The local readFile tool actually ran and its real output is on the part.
    const toolPart = replies[0]!.parts.find(
      (p): p is Extract<typeof p, { type: "tool-readFile" }> => p.type === "tool-readFile",
    );
    expect(toolPart?.state).toBe("output-available");
    expect((toolPart?.output as { content?: string }).content).toBe("hello from disk");

    // The loop continued past the tool call: the final answer (second step) is
    // present, which only happens if the tool output was fed back and re-sent.
    const texts = replies[0]!.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text);
    expect(texts).toEqual(["Reading the note.", "The note says hello from disk."]);

    // The transport was invoked twice (initial turn + post-tool continuation).
    expect(call).toBe(2);
  });
});

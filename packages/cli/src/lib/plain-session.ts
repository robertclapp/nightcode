import { createInterface } from "node:readline";
import {
  announceError,
  renderTranscript,
  renderTranscriptMessage,
  type ToolStatus,
  type TranscriptMessage,
  type TranscriptPart,
} from "@nightcode/shared";
import type { Message } from "../hooks/use-chat";
import { toErrorMessage } from "./errors";

type ClientPart = Message["parts"][number];

function toolStatus(state: unknown): ToolStatus {
  if (state === "output-error") return "error";
  if (state === "output-available") return "done";
  return "running";
}

/** Keys that identify what a tool acted on, in priority order. */
const SUMMARY_KEYS = ["path", "command", "pattern", "file", "query", "url"];
const MAX_SUMMARY_LEN = 80;

function compact(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_SUMMARY_LEN ? `${oneLine.slice(0, MAX_SUMMARY_LEN)}…` : oneLine;
}

/**
 * A short, spoken-friendly summary of a tool's input. Prefers an identifying
 * field (path / command / pattern) and truncates, so a screen reader announces
 * "ran Write file math.ts" rather than reading an entire file body, a full
 * edit's old+new text, or a numeric timeout aloud.
 */
function summarizeInput(input: unknown): string | undefined {
  if (input == null) return undefined;
  if (typeof input !== "object") return compact(String(input));

  const record = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return compact(value);
  }
  // No known identifier: fall back to the first short scalar, skipping long
  // strings (file bodies) and nested objects (which stringify to junk).
  for (const value of Object.values(record)) {
    if (
      (typeof value === "string" || typeof value === "number" || typeof value === "boolean") &&
      String(value).trim()
    ) {
      return compact(String(value));
    }
  }
  return undefined;
}

function partToTranscript(part: ClientPart): TranscriptPart | null {
  if (part.type === "text") return { kind: "text", text: part.text };
  if (part.type === "reasoning") return { kind: "reasoning", text: part.text };
  if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
    const name =
      "toolName" in part && typeof part.toolName === "string"
        ? part.toolName
        : part.type.slice("tool-".length);
    const errorText = (part as { errorText?: unknown }).errorText;
    return {
      kind: "tool",
      name,
      status: toolStatus((part as { state?: unknown }).state),
      summary: summarizeInput((part as { input?: unknown }).input),
      detail: typeof errorText === "string" ? errorText : undefined,
    };
  }
  return null;
}

/** Map a chat message into the screen-reader transcript shape. */
export function toTranscriptMessage(message: Message): TranscriptMessage {
  const parts = message.parts
    .map(partToTranscript)
    .filter((part): part is TranscriptPart => part != null);
  return { role: message.role === "user" ? "user" : "assistant", parts };
}

/** Yield input lines from a readable stream (e.g. process.stdin). */
export async function* readLines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    // Close the interface when the consumer stops (e.g. on /exit). Otherwise the
    // readline listeners stay attached to an interactive stdin (TTY), keeping the
    // process alive so it hangs instead of exiting.
    rl.close();
  }
}

// Slash-prefixed only, to match the on-screen `/exit` hint and the `/build`,
// `/plan`, `/fix` commands — and so the bare words "exit"/"quit" remain sendable.
const EXIT_COMMANDS = new Set(["/exit", "/quit"]);

export type PlainSessionDeps = {
  /** Source of user input lines. */
  input: AsyncIterable<string>;
  /** Sink for announced lines. */
  print: (line: string) => void;
  /** Run a user turn; resolves with the assistant messages to announce. */
  sendTurn: (text: string) => Promise<TranscriptMessage[]>;
  /** Stored conversation to announce on start. */
  initialMessages?: TranscriptMessage[];
};

/**
 * The screen-reader session loop: announce any prior conversation, then read a
 * line at a time, echo it, run the turn, and announce the reply. I/O and the
 * network turn are injected so the loop is testable without a terminal or LLM.
 */
export async function runPlainSession(deps: PlainSessionDeps): Promise<void> {
  const { input, print, sendTurn, initialMessages = [] } = deps;

  for (const line of renderTranscript(initialMessages).split("\n")) {
    if (line) print(line);
  }

  for await (const raw of input) {
    const text = raw.trim();
    if (!text) continue;
    if (EXIT_COMMANDS.has(text.toLowerCase())) break;

    print(`You: ${text}`);
    try {
      const replies = await sendTurn(text);
      for (const message of replies) {
        for (const line of renderTranscriptMessage(message)) print(line);
      }
    } catch (error) {
      print(announceError(toErrorMessage(error)));
    }
  }
}

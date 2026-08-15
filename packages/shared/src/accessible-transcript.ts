/**
 * Screen-reader transcript rendering.
 *
 * A full-screen TUI is unreadable to screen readers, so the accessible mode
 * renders the conversation as a linear, announced, plain-text transcript
 * instead. This module is the heart of that: it turns the structured
 * conversation (text, reasoning, and tool calls with their state) into spoken
 * lines, with a clear speaker label on each and no visual-only cues
 * (no color, no box-drawing, no spinners).
 *
 * Pure and dependency-free so it can be unit tested and reused by any front end.
 */

export type ToolStatus = "running" | "done" | "error";

export type TranscriptPart =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; name: string; status: ToolStatus; summary?: string; detail?: string };

export type TranscriptMessage = {
  role: "user" | "assistant";
  parts: TranscriptPart[];
};

const SPEAKER: Record<TranscriptMessage["role"], string> = {
  user: "You",
  assistant: "Assistant",
};

/** Turn a tool identifier into spoken words: `readFile` → "Read file". */
export function humanizeToolName(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase() : name;
}

/** A single spoken line describing a tool call and its outcome. */
export function describeToolPart(part: Extract<TranscriptPart, { kind: "tool" }>): string {
  const name = humanizeToolName(part.name);
  const target = part.summary?.trim() ? ` ${part.summary.trim()}` : "";
  switch (part.status) {
    case "running":
      return `ran ${name}${target} (in progress)`;
    case "error":
      return `ran ${name}${target} — failed${part.detail?.trim() ? `: ${part.detail.trim()}` : ""}`;
    case "done":
      return `ran ${name}${target}`;
  }
}

function renderPart(role: TranscriptMessage["role"], part: TranscriptPart): string | null {
  switch (part.kind) {
    case "text": {
      const text = part.text.trim();
      return text ? `${SPEAKER[role]}: ${text}` : null;
    }
    case "reasoning": {
      const text = part.text.trim();
      return text ? `${SPEAKER[role]} (thinking): ${text}` : null;
    }
    case "tool":
      return `${SPEAKER[role]} ${describeToolPart(part)}`;
  }
}

/** Spoken lines for one message (empty parts are dropped). */
export function renderTranscriptMessage(message: TranscriptMessage): string[] {
  return message.parts
    .map((part) => renderPart(message.role, part))
    .filter((line): line is string => line != null);
}

/** The whole conversation as a single newline-separated transcript. */
export function renderTranscript(messages: TranscriptMessage[]): string {
  return messages.flatMap(renderTranscriptMessage).join("\n");
}

/** A spoken line for an out-of-band error. */
export function announceError(message: string): string {
  return `Error: ${message}`;
}

/**
 * A spoken line for Test Fixer run state. `state` mirrors `FixRunState`
 * ("running" | "green" | "exhausted"); it is inlined rather than imported to
 * keep this module dependency-free.
 */
export function announceFixRun(snapshot: {
  state: "running" | "green" | "exhausted";
  failedRuns: number;
  maxIterations: number;
}): string {
  switch (snapshot.state) {
    case "green":
      return "Test run: the suite is now passing.";
    case "exhausted":
      return `Test run: stopped after using the budget of ${snapshot.maxIterations} attempts.`;
    default:
      return snapshot.failedRuns === 0
        ? "Test run: running the tests."
        : `Test run: ${snapshot.failedRuns} of ${snapshot.maxIterations} attempts used.`;
  }
}

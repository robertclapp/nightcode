import {
  announceError,
  announceFixRun,
  DEFAULT_CHAT_MODEL_ID,
  isEnvFlagEnabled,
  Mode,
  SUPPORTED_CHAT_MODELS,
  type ModeType,
  type SupportedChatModel,
  type SupportedChatModelId,
  type TranscriptMessage,
} from "@nightcode/shared";
import { createAgentSession } from "./agent-session";
import { readLines, runPlainSession, toTranscriptMessage } from "./plain-session";
import { getAuth } from "./auth";
import { performLogin } from "./oauth";
import { apiClient } from "./api-client";
import { getErrorMessage } from "./http-errors";
import { toErrorMessage } from "./errors";

/**
 * Whether the user requested the plain, screen-reader-friendly output mode,
 * via `--plain` or `NIGHTCODE_PLAIN`. Pure so it can be unit tested. Shares the
 * "off"-value parsing with the other accessibility flags so they stay in step.
 */
export function isPlainMode(
  argv: string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (argv.includes("--plain")) return true;
  return isEnvFlagEnabled(env.NIGHTCODE_PLAIN);
}

/** Map a `/build`, `/plan`, or `/fix` line to its mode, or null if it isn't one. */
export function parseModeCommand(text: string): ModeType | null {
  switch (text.trim().toLowerCase()) {
    case "/build":
      return Mode.BUILD;
    case "/plan":
      return Mode.PLAN;
    case "/fix":
      return Mode.FIX;
    default:
      return null;
  }
}

const HELP_TEXT = [
  "Commands:",
  "/help — list these commands.",
  "/build, /plan, /fix — switch agent mode.",
  "/model — list models; /model <number> or /model <name> — switch model.",
  "/exit — quit.",
].join("\n");

const MODEL_COMMAND = "/model";

/** If `text` is a `/model` command, return its (possibly empty) argument. */
export function parseModelCommand(text: string): { arg: string } | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (lower === MODEL_COMMAND) return { arg: "" };
  if (lower.startsWith(`${MODEL_COMMAND} `)) {
    return { arg: trimmed.slice(MODEL_COMMAND.length).trim() };
  }
  return null;
}

export type ModelResolution =
  | { kind: "list" }
  | { kind: "set"; model: SupportedChatModel }
  | { kind: "error"; message: string };

/**
 * Resolve a `/model` argument to a model: by 1-based index, exact id, or a
 * unique case-insensitive substring of the id (so "opus" finds
 * "claude-opus-4-6"). An empty argument lists; anything ambiguous or unknown
 * returns a spoken error rather than silently picking one.
 */
export function resolveModelCommand(
  arg: string,
  models: readonly SupportedChatModel[],
  current: string,
): ModelResolution {
  const query = arg.trim().toLowerCase();
  if (!query) return { kind: "list" };

  if (/^\d+$/.test(query)) {
    const model = models[Number(query) - 1];
    return model
      ? { kind: "set", model }
      : {
          kind: "error",
          message: `There is no model number ${query}. There are ${models.length}; say /model to list them.`,
        };
  }

  const exact = models.find((m) => m.id.toLowerCase() === query);
  if (exact) return { kind: "set", model: exact };

  const matches = models.filter((m) => m.id.toLowerCase().includes(query));
  if (matches.length === 1) return { kind: "set", model: matches[0]! };
  if (matches.length > 1) {
    return {
      kind: "error",
      message: `"${arg}" matches ${matches.length} models: ${matches.map((m) => m.id).join(", ")}. Be more specific.`,
    };
  }
  return { kind: "error", message: `No model matches "${arg}". Say /model to list the choices.` };
}

/** A spoken-friendly, numbered model list with the current one marked. */
export function renderModelList(models: readonly SupportedChatModel[], current: string): string {
  const lines = models.map(
    (m, i) => `${i + 1}. ${m.id} (${m.provider})${m.id === current ? " — current" : ""}`,
  );
  return [
    `Models (current: ${current}):`,
    ...lines,
    "Switch with /model <number> or /model <name>.",
  ].join("\n");
}

export type CommandResult =
  | { kind: "turn" }
  | { kind: "reply"; text: string; mode?: ModeType; model?: SupportedChatModelId };

/**
 * Interpret a line of input as a slash command (help / model / mode) against the
 * current session state, returning either the spoken reply plus any state change
 * or `{ kind: "turn" }` to send it to the agent. Pure, so it is unit-testable
 * without the network.
 */
export function interpretCommand(
  text: string,
  state: { mode: ModeType; model: SupportedChatModelId },
): CommandResult {
  if (text.trim().toLowerCase() === "/help") {
    return { kind: "reply", text: HELP_TEXT };
  }

  const modelCmd = parseModelCommand(text);
  if (modelCmd) {
    const result = resolveModelCommand(modelCmd.arg, SUPPORTED_CHAT_MODELS, state.model);
    if (result.kind === "set") {
      return { kind: "reply", text: `Model set to ${result.model.id}.`, model: result.model.id };
    }
    if (result.kind === "list") {
      return { kind: "reply", text: renderModelList(SUPPORTED_CHAT_MODELS, state.model) };
    }
    return { kind: "reply", text: result.message };
  }

  const requested = parseModeCommand(text);
  if (requested) {
    return { kind: "reply", text: `Mode set to ${requested.toLowerCase()}.`, mode: requested };
  }

  return { kind: "turn" };
}

/** Ensure we have a token, walking the user through sign-in if not. */
async function ensureAuthenticated(print: (line: string) => void): Promise<boolean> {
  if (getAuth()) return true;
  print("You are not signed in. Opening your browser to sign in...");
  try {
    await performLogin();
    print("Signed in.");
    return true;
  } catch (error) {
    print(announceError(`sign-in failed: ${toErrorMessage(error)}`));
    return false;
  }
}

/**
 * Run NightCode's plain (screen-reader) mode instead of the full-screen TUI:
 * sign in if needed, open a session, then run the linear announce/echo/render
 * loop backed by a real headless agent turn. The agent loop is shared with the
 * TUI (`createAgentSession`), so a screen-reader user gets the same agent — just
 * rendered as plain announced text rather than a redrawn canvas.
 */
export async function runPlainMode(): Promise<void> {
  const print = (line: string) => process.stdout.write(`${line}\n`);

  print("NightCode - plain (screen-reader) mode.");
  print("Type a message and press enter. Type /help for commands, or /exit to quit.");
  print("");

  if (!(await ensureAuthenticated(print))) return;

  let sessionId: string;
  try {
    const res = await apiClient.sessions.$post({ json: { title: "Screen-reader session" } });
    if (!res.ok) throw new Error(await getErrorMessage(res));
    sessionId = (await res.json()).id;
  } catch (error) {
    print(announceError(`could not start a session: ${toErrorMessage(error)}`));
    return;
  }

  let model: SupportedChatModelId = DEFAULT_CHAT_MODEL_ID;
  let mode: ModeType = Mode.BUILD;

  const agent = createAgentSession({
    sessionId,
    onFixRun: (snapshot) => print(announceFixRun(snapshot)),
  });

  const sendTurn = async (text: string): Promise<TranscriptMessage[]> => {
    const command = interpretCommand(text, { mode, model });
    if (command.kind === "reply") {
      if (command.mode !== undefined) mode = command.mode;
      if (command.model !== undefined) model = command.model;
      return [{ role: "assistant", parts: [{ kind: "text", text: command.text }] }];
    }
    const replies = await agent.sendTurn(text, { mode, model });
    return replies.map(toTranscriptMessage);
  };

  try {
    await runPlainSession({ input: readLines(process.stdin), print, sendTurn });
  } catch (error) {
    print(announceError(toErrorMessage(error)));
  }
}

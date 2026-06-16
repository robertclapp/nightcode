import {
  announceError,
  announceFixRun,
  DEFAULT_CHAT_MODEL_ID,
  isEnvFlagEnabled,
  Mode,
  type ModeType,
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
  print("Type a message and press enter. Type /exit to quit.");
  print("Commands: /build, /plan, /fix to switch agent mode.");
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

  const model: SupportedChatModelId = DEFAULT_CHAT_MODEL_ID;
  let mode: ModeType = Mode.BUILD;

  const agent = createAgentSession({
    sessionId,
    onFixRun: (snapshot) => print(announceFixRun(snapshot)),
  });

  const sendTurn = async (text: string): Promise<TranscriptMessage[]> => {
    const requested = parseModeCommand(text);
    if (requested) {
      mode = requested;
      return [{ role: "assistant", parts: [{ kind: "text", text: `Mode set to ${mode.toLowerCase()}.` }] }];
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

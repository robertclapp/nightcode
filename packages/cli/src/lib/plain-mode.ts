import { announceError, type TranscriptMessage } from "@nightcode/shared";
import { readLines, runPlainSession } from "./plain-session";

const OFF_VALUES = new Set(["", "0", "false", "no", "off"]);

/**
 * Whether the user requested the plain, screen-reader-friendly output mode,
 * via `--plain` or `NIGHTCODE_PLAIN`. Pure so it can be unit tested.
 */
export function isPlainMode(
  argv: string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (argv.includes("--plain")) return true;
  const flag = env.NIGHTCODE_PLAIN;
  return flag != null && !OFF_VALUES.has(flag.trim().toLowerCase());
}

/**
 * Run NightCode's plain (screen-reader) mode instead of the full-screen TUI.
 *
 * The accessible I/O loop — reading input, echoing it, and announcing replies
 * via the linear transcript renderer — is fully wired here. Connecting it to a
 * live agent turn (auth, session, and the streaming tool loop, which today
 * lives in the React `useChat` hook) is the remaining integration and needs the
 * running server, so `sendTurn` is an honest placeholder until that lands.
 */
export async function runPlainMode(): Promise<void> {
  const print = (line: string) => process.stdout.write(`${line}\n`);

  print("NightCode — plain (screen-reader) mode.");
  print("Type a message and press enter. Type /exit to quit.");
  print("");

  const sendTurn = async (): Promise<TranscriptMessage[]> => [
    {
      role: "assistant",
      parts: [
        {
          kind: "text",
          text:
            "Plain mode renders the conversation accessibly. Connecting it to the live " +
            "agent loop is in progress; use the standard interface for agent runs until then.",
        },
      ],
    },
  ];

  try {
    await runPlainSession({ input: readLines(process.stdin), print, sendTurn });
  } catch (error) {
    print(announceError(error instanceof Error ? error.message : String(error)));
  }
}

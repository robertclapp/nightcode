/**
 * The agent turn loop, framework-agnostic.
 *
 * NightCode's agent loop — stream an assistant turn, run the tool calls it asks
 * for *locally*, feed the results back, and repeat until the model stops asking
 * for tools — lived only inside the React `useChat` hook, so the only front end
 * that could run an agent was the full-screen TUI. A screen reader can't read
 * that TUI, so the plain mode needs the same loop without React.
 *
 * This module owns the loop. The transport and the per-tool-call handler are
 * extracted here as pure functions that `useChat` (React) and
 * `createAgentSession` (headless) both use, so there is exactly one
 * implementation of "what NightCode does when the model calls a tool". The only
 * difference is who drives the multi-step loop: React leaves the SDK's own
 * re-send loop running and re-renders, while `createAgentSession` drives it
 * itself so a caller can `await session.sendTurn(...)` and get the finished
 * reply.
 *
 * Note on the loop mechanics: the SDK invokes `onToolCall` *inside* its serial
 * job executor, so a handler that awaited `addToolOutput` (another job) would
 * deadlock. Both front ends therefore run the tool fire-and-forget. React lets
 * the SDK's `sendAutomaticallyWhen` re-send when the outputs land; the headless
 * session instead disables auto-send, tracks the in-flight tool executions, and
 * re-sends manually once they settle — which lets it await the whole turn.
 */
import {
  AbstractChat,
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  type ChatInit,
  type ChatState,
  type ChatStatus,
  type ChatTransport,
} from "ai";
import {
  Mode,
  FixRunController,
  toolInputSchemas,
  type FixRunSnapshot,
  type ModeType,
  type SupportedChatModelId,
} from "@nightcode/shared";
import { apiClient } from "./api-client";
import { getAuth } from "./auth";
import { executeLocalTool } from "./local-tools";
import { detectProjectTestCommand } from "./detect-project-test-command";
import { toErrorMessage } from "./errors";
import type { Message } from "../hooks/use-chat";

/**
 * Build the HTTP transport that ships messages to the server's chat endpoint.
 * Extracted verbatim from `useChat` so the headless session and the TUI send
 * byte-for-byte identical requests. `getTestCommand` is read lazily on each
 * request so a FIX run's detected command is attached without rebuilding the
 * transport.
 */
export function buildChatTransport(opts: {
  sessionId: string;
  getTestCommand: () => string | undefined;
}): DefaultChatTransport<Message> {
  const { sessionId, getTestCommand } = opts;
  return new DefaultChatTransport<Message>({
    api: apiClient.chat.$url().toString(),
    headers() {
      const auth = getAuth();
      return auth ? { Authorization: `Bearer ${auth.token}` } : new Headers();
    },
    prepareSendMessagesRequest({ messages }) {
      const message = messages[messages.length - 1];
      if (!message) throw new Error("No message to send");

      const metadata = messages.findLast(
        (m) => m.metadata?.mode && m.metadata?.model,
      )?.metadata;
      const previousMessage = messages[messages.length - 2];
      const requestMessages =
        message.role === "assistant" && previousMessage?.role === "user"
          ? [previousMessage, message]
          : [message];

      return {
        body: {
          id: sessionId,
          messages: requestMessages,
          mode: message.metadata?.mode ?? metadata?.mode,
          model: message.metadata?.model ?? metadata?.model,
          testCommand: getTestCommand(),
        },
      };
    },
  });
}

/** The tool call shape the SDK hands us (a subset of its toolCall type). */
export interface AgentToolCall {
  toolName: string;
  toolCallId: string;
  input: unknown;
}

type AddToolOutputArgs =
  | { tool: string; toolCallId: string; output: unknown }
  | { tool: string; toolCallId: string; state: "output-error"; errorText: string };

/**
 * The slice of a chat instance the tool handler needs. Both `@ai-sdk/react`'s
 * `useChat` return value and our headless `AbstractChat` satisfy this (they're
 * cast to it at the call site, since their `addToolOutput` is more strictly
 * typed over the tool set).
 */
export interface AgentChatPort {
  messages: Message[];
  addToolOutput: (args: AddToolOutputArgs) => void | PromiseLike<void>;
}

export interface HandleToolCallDeps {
  chat: AgentChatPort;
  toolCall: AgentToolCall;
  /** The active FIX run controller, if any. Read lazily — it changes per turn. */
  getFixRunController: () => FixRunController | null;
  /** Notified whenever the FIX run snapshot changes, for UI / announcements. */
  onFixRunChange: (snapshot: FixRunSnapshot) => void;
  /** The tool executor. Injectable for tests; defaults to the real local tools. */
  execute?: (toolName: string, input: unknown, mode: ModeType) => Promise<unknown>;
}

/**
 * Handle one tool call: enforce the FIX-mode budget gate, run the tool locally,
 * fold any FIX run state into the output, and report the result back to the
 * chat. Returns a promise that resolves once the result has been recorded — the
 * headless loop awaits it (so the whole turn awaits the tool); React calls it
 * fire-and-forget and lets the SDK's own re-send loop continue.
 */
export async function handleAgentToolCall(deps: HandleToolCallDeps): Promise<void> {
  const { chat, toolCall, getFixRunController, onFixRunChange, execute = executeLocalTool } = deps;
  const mode = chat.messages.at(-1)?.metadata?.mode ?? Mode.BUILD;
  const fixRunController = mode === Mode.FIX ? getFixRunController() : null;

  if (fixRunController) {
    const refusal = fixRunController.gateToolCall(toolCall.toolName);
    if (refusal) {
      onFixRunChange(fixRunController.getSnapshot());
      await chat.addToolOutput({
        tool: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        state: "output-error",
        errorText: refusal,
      });
      return;
    }
  }

  try {
    const output = await execute(toolCall.toolName, toolCall.input, mode);
    let finalOutput: unknown = output;

    // Feed bash results to the fix-run controller so it can track the suite
    // state, and reflect the run status back to the model and UI.
    if (fixRunController && toolCall.toolName === "bash") {
      const { command } = toolInputSchemas.bash.parse(toolCall.input);
      const exitCode = (output as { exitCode?: unknown }).exitCode;
      const event = fixRunController.observeBashResult(
        command,
        typeof exitCode === "number" ? exitCode : 1,
      );

      if (event.type === "test-run-failed") {
        finalOutput = {
          ...(output as object),
          fixRun: { failedRuns: event.failedRuns, remainingBudget: event.remaining },
        };
      } else if (event.type === "test-run-passed") {
        finalOutput = { ...(output as object), fixRun: { suitePassed: true } };
      }

      if (event.type !== "not-a-test-run") {
        onFixRunChange(fixRunController.getSnapshot());
      }
    }

    await chat.addToolOutput({
      tool: toolCall.toolName,
      toolCallId: toolCall.toolCallId,
      output: finalOutput,
    });
  } catch (error) {
    await chat.addToolOutput({
      tool: toolCall.toolName,
      toolCallId: toolCall.toolCallId,
      state: "output-error",
      errorText: toErrorMessage(error),
    });
  }
}

/**
 * Whether the agent should automatically send the tool results back for another
 * turn. Shared by both front ends: continue while the last assistant message
 * has complete tool calls, unless a FIX run has spent its budget.
 */
export function shouldAutoContinue(
  fixRunController: FixRunController | null,
  options: { messages: Message[] },
): boolean {
  if (fixRunController && !fixRunController.shouldAutoContinue()) return false;
  return lastAssistantMessageIsCompleteWithToolCalls(options);
}

/**
 * Start the FIX run controller for a submit, mirroring `useChat`: each FIX-mode
 * prompt gets a fresh budget tied to the detected test command; outside FIX
 * mode there is no controller.
 */
export function startFixRun(
  mode: ModeType,
  detect: () => { command: string } | null = detectProjectTestCommand,
): FixRunController | null {
  if (mode !== Mode.FIX) return null;
  const detected = detect();
  return detected ? new FixRunController({ testCommand: detected.command }) : null;
}

/**
 * A minimal, array-backed `ChatState` for running a chat outside React. Mirrors
 * `@ai-sdk/react`'s internal state (immutable array swaps + `structuredClone`
 * snapshots) without the React change-notification machinery, which a headless
 * caller doesn't need.
 */
class HeadlessChatState implements ChatState<Message> {
  status: ChatStatus = "ready";
  error: Error | undefined = undefined;
  messages: Message[];

  constructor(initial: Message[] = []) {
    this.messages = [...initial];
  }

  pushMessage = (message: Message) => {
    this.messages = this.messages.concat(message);
  };

  popMessage = () => {
    this.messages = this.messages.slice(0, -1);
  };

  replaceMessage = (index: number, message: Message) => {
    this.messages = [
      ...this.messages.slice(0, index),
      this.snapshot(message),
      ...this.messages.slice(index + 1),
    ];
  };

  // Mirrors ReactChatState's defensive copy. Tool outputs are typed `unknown`,
  // so fall back to sharing the reference if a value isn't structured-cloneable
  // rather than throwing DataCloneError mid-stream and killing the turn (the
  // headless caller only reads messages after the turn settles).
  snapshot = <T>(value: T): T => {
    try {
      return structuredClone(value);
    } catch {
      return value;
    }
  };
}

/**
 * A hard ceiling on tool-loop re-sends within a single `sendTurn`. Generous —
 * real turns stop far sooner — but bounds a runaway model in an unattended run.
 */
const MAX_TURN_STEPS = 100;

/** A concrete `AbstractChat` for headless use (the base class only lacks state). */
class HeadlessChat extends AbstractChat<Message> {
  constructor(init: Omit<ChatInit<Message>, "messages"> & { messages?: Message[] }) {
    const { messages, ...rest } = init;
    super({ ...rest, state: new HeadlessChatState(messages) });
  }
}

export interface AgentSession {
  /** The full conversation so far (read-only view). */
  readonly messages: Message[];
  /**
   * Run one user turn to completion — including the entire local tool loop —
   * and resolve with the assistant message(s) produced this turn.
   */
  sendTurn(
    text: string,
    opts: { mode: ModeType; model: SupportedChatModelId },
  ): Promise<Message[]>;
}

export interface CreateAgentSessionOptions {
  sessionId: string;
  initialMessages?: Message[];
  /** Notified when the FIX run state changes (e.g. to announce it). */
  onFixRun?: (snapshot: FixRunSnapshot) => void;
  /** Injectable for tests; defaults to the real HTTP transport. */
  transport?: ChatTransport<Message>;
  /** Injectable for tests; defaults to detecting the project's test command. */
  detectTestCommand?: () => { command: string } | null;
}

/**
 * Create a headless agent session: a non-React object whose `sendTurn` drives
 * the same loop the TUI does, but to completion. The SDK's own auto-send is
 * turned off; instead each tool call is run fire-and-forget (its promise parked
 * in `pending`), and after a turn's stream ends we drain those executions and
 * re-send while the model is still asking for tools. `sendTurn` resolves once
 * the model stops, with the assistant message(s) it produced.
 */
export function createAgentSession(opts: CreateAgentSessionOptions): AgentSession {
  const { sessionId, initialMessages = [], onFixRun, transport, detectTestCommand } = opts;

  let fixRun: FixRunController | null = null;
  // In-flight tool executions for the current turn. Each `onToolCall` parks its
  // handler promise here; `sendTurn` drains them between re-sends.
  const pending = new Set<Promise<void>>();

  // Explicitly typed so the `onToolCall` closure can reference `chat` (the
  // instance it's attached to) without a circular type-inference error.
  const chat: HeadlessChat = new HeadlessChat({
    id: sessionId,
    messages: initialMessages,
    transport: transport ?? buildChatTransport({ sessionId, getTestCommand: () => fixRun?.testCommand }),
    onToolCall: ({ toolCall }) => {
      // Fire-and-forget — returning the promise would deadlock the SDK's serial
      // job executor, which runs `onToolCall` inside a job that `addToolOutput`
      // would have to queue behind. We park it and drain it in `sendTurn`.
      const settled = handleAgentToolCall({
        chat: chat as unknown as AgentChatPort,
        toolCall,
        getFixRunController: () => fixRun,
        onFixRunChange: (snapshot) => onFixRun?.(snapshot),
      }).finally(() => pending.delete(settled));
      pending.add(settled);
    },
    // The headless session drives continuation itself (see `sendTurn`).
    sendAutomaticallyWhen: () => false,
  });

  return {
    get messages() {
      return chat.messages;
    },
    async sendTurn(text, { mode, model }) {
      fixRun = startFixRun(mode, detectTestCommand);
      if (fixRun && onFixRun) onFixRun(fixRun.getSnapshot());

      const before = chat.messages.length;
      await chat.sendMessage({ text, metadata: { mode, model } });

      // Run the multi-step loop: wait for this turn's tool executions to record
      // their outputs, then re-send while the model is still calling tools (and
      // a FIX budget, if any, hasn't been spent).
      //
      // `AbstractChat.makeRequest` swallows transport/stream errors (it sets
      // status to "error" and does NOT throw), so we MUST check `chat.status`
      // every iteration: otherwise a failed re-send leaves the last message
      // unchanged and still tool-complete, `shouldAutoContinue` stays true, and
      // the loop re-sends forever with no backoff. The step cap is a final
      // backstop against a model that never stops calling tools (the React TUI
      // has a human to interrupt; a headless run does not).
      let steps = 0;
      while (true) {
        while (pending.size) await Promise.allSettled([...pending]);
        if (chat.status === "error") break;
        if (!shouldAutoContinue(fixRun, { messages: chat.messages })) break;
        if (++steps > MAX_TURN_STEPS) break;
        await chat.sendMessage();
      }

      // Surface a swallowed request failure (including a failed first send, which
      // otherwise yields no assistant message and dead silence for the caller).
      if (chat.status === "error") {
        throw chat.error ?? new Error("The request to the model failed.");
      }

      // The new messages are the user echo plus the assistant turn(s); the
      // caller only wants the assistant's reply.
      return chat.messages.slice(before).filter((m) => m.role === "assistant");
    },
  };
}

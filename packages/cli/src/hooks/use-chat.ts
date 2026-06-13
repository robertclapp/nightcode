import { useMemo, useRef, useState } from "react";
import { useChat as useAiChat } from "@ai-sdk/react";
import {
  type InferUITools,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import {
  FixRunController,
  type FixRunSnapshot,
  type ModeType,
  type SupportedChatModelId,
  type ToolContracts,
} from "@nightcode/shared";
import {
  buildChatTransport,
  handleAgentToolCall,
  shouldAutoContinue,
  startFixRun,
  type AgentChatPort,
} from "../lib/agent-session";

export type ChatMessageMetadata = {
  mode?: ModeType;
  model?: SupportedChatModelId | string;
  durationMs?: number;
  usage?: LanguageModelUsage;
};

type ChatTools = {
  [Name in keyof InferUITools<ToolContracts>]: {
    input: InferUITools<ToolContracts>[Name]["input"];
    output: unknown;
  };
};

export type Message = UIMessage<ChatMessageMetadata, never, ChatTools>;

export function useChat(sessionId: string, initialMessages: Message[]) {
  // One controller per FIX run, created on each user submit in FIX mode. It
  // recognizes test runs by their command, enforces the failing-run budget,
  // and stops the tool loop when that budget is spent.
  const fixRunRef = useRef<FixRunController | null>(null);
  // A render-friendly mirror of the controller for the status indicator.
  const [fixRun, setFixRun] = useState<FixRunSnapshot | null>(null);

  const transport = useMemo(
    () => buildChatTransport({ sessionId, getTestCommand: () => fixRunRef.current?.testCommand }),
    [sessionId],
  );

  const chat = useAiChat<Message>({
    id: sessionId,
    messages: initialMessages,
    transport,
    onToolCall({ toolCall }) {
      // Fire-and-forget: the SDK's own re-send loop drives the continuation and
      // React re-renders as `addToolOutput` lands. The shared handler holds the
      // single implementation of what a tool call does (also used headlessly).
      void handleAgentToolCall({
        chat: chat as unknown as AgentChatPort,
        toolCall,
        getFixRunController: () => fixRunRef.current,
        onFixRunChange: setFixRun,
      });
    },
    sendAutomaticallyWhen(options) {
      return shouldAutoContinue(fixRunRef.current, options);
    },
  });

  return {
    messages: chat.messages,
    status: chat.status,
    error: chat.error,
    fixRun,
    submit: (params: { userText: string; mode: ModeType; model: SupportedChatModelId }) => {
      // Each user prompt in FIX mode starts a fresh fix run with a fresh
      // budget; outside FIX mode no controller is active.
      fixRunRef.current = startFixRun(params.mode);
      setFixRun(fixRunRef.current?.getSnapshot() ?? null);

      return chat.sendMessage({
        text: params.userText,
        metadata: {
          mode: params.mode,
          model: params.model,
        },
      })
    },
    abort: chat.stop,
    interrupt: chat.stop,
  };
};

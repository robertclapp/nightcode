import { useMemo, useRef, useState } from "react";
import { useChat as useAiChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  type InferUITools,
  lastAssistantMessageIsCompleteWithToolCalls,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import {
  Mode,
  FixRunController,
  toolInputSchemas,
  type FixRunSnapshot,
  type ModeType,
  type SupportedChatModelId,
  type ToolContracts,
} from "@nightcode/shared";
import { apiClient } from "../lib/api-client";
import { getAuth } from "../lib/auth";
import { executeLocalTool } from "../lib/local-tools";
import { detectProjectTestCommand } from "../lib/detect-project-test-command";

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

  const transport = useMemo(() => {
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
            testCommand: fixRunRef.current?.testCommand,
          },
        }
      }
    });
  }, [sessionId]);

  const chat = useAiChat<Message>({
    id: sessionId,
    messages: initialMessages,
    transport,
    onToolCall({ toolCall }) {
      const mode = chat.messages.at(-1)?.metadata?.mode ?? "BUILD";
      const fixRunController = mode === Mode.FIX ? fixRunRef.current : null;

      if (fixRunController) {
        const refusal = fixRunController.gateToolCall(toolCall.toolName);
        if (refusal) {
          setFixRun(fixRunController.getSnapshot());
          chat.addToolOutput({
            tool: toolCall.toolName as keyof ChatTools,
            toolCallId: toolCall.toolCallId,
            state: "output-error",
            errorText: refusal,
          });
          return;
        }
      }

      void executeLocalTool(toolCall.toolName, toolCall.input, mode)
        .then((output) => {
          let finalOutput: unknown = output;

          // Feed bash results to the fix-run controller so it can track the
          // suite state, and reflect the run status back to the model and UI.
          if (fixRunController && toolCall.toolName === "bash") {
            const { command } = toolInputSchemas.bash.parse(toolCall.input);
            const exitCode = (output as { exitCode?: unknown }).exitCode;
            const event = fixRunController.observeBashResult(
              command,
              typeof exitCode === "number" ? exitCode : 1,
            );

            if (event.type === "test-run-failed") {
              finalOutput = {
                ...output,
                fixRun: { failedRuns: event.failedRuns, remainingBudget: event.remaining },
              };
            } else if (event.type === "test-run-passed") {
              finalOutput = { ...output, fixRun: { suitePassed: true } };
            }

            if (event.type !== "not-a-test-run") {
              setFixRun(fixRunController.getSnapshot());
            }
          }

          chat.addToolOutput({
            tool: toolCall.toolName as keyof ChatTools,
            toolCallId: toolCall.toolCallId,
            output: finalOutput,
          });
        })
        .catch((error) =>
          chat.addToolOutput({
            tool: toolCall.toolName as keyof ChatTools,
            toolCallId: toolCall.toolCallId,
            state: "output-error",
            errorText: error instanceof Error ? error.message : String(error),
          }),
        );
    },
    sendAutomaticallyWhen(options) {
      const fixRun = fixRunRef.current;
      if (fixRun && !fixRun.shouldAutoContinue()) return false;
      return lastAssistantMessageIsCompleteWithToolCalls(options);
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
      if (params.mode === Mode.FIX) {
        const detected = detectProjectTestCommand();
        fixRunRef.current = detected
          ? new FixRunController({ testCommand: detected.command })
          : null;
      } else {
        fixRunRef.current = null;
      }
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

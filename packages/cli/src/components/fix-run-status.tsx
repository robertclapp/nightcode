import { TextAttributes } from "@opentui/core";
import type { FixRunSnapshot } from "@nightcode/shared";
import { useTheme } from "../providers/theme";

type Props = {
  fixRun: FixRunSnapshot;
};

/**
 * Compact Test Fixer run indicator for the session status row:
 * `● Fix bun run test · 2/6 failed`. Color tracks the run state — the suite's
 * accent green when passing, error red when the budget is spent, otherwise the
 * Fix accent while iterating.
 */
export function FixRunStatus({ fixRun }: Props) {
  const { colors } = useTheme();

  const color =
    fixRun.state === "green"
      ? colors.success
      : fixRun.state === "exhausted"
        ? colors.error
        : colors.planMode;

  const label =
    fixRun.state === "green"
      ? "tests green"
      : fixRun.state === "exhausted"
        ? `stopped · ${fixRun.failedRuns}/${fixRun.maxIterations} runs`
        : fixRun.failedRuns === 0
          ? "running tests"
          : `${fixRun.failedRuns}/${fixRun.maxIterations} failed`;

  return (
    <box flexDirection="row" alignItems="center" gap={1}>
      <text fg={color}>●</text>
      <text>Fix</text>
      <text attributes={TextAttributes.DIM}>{fixRun.testCommand}</text>
      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
        ·
      </text>
      <text fg={color}>{label}</text>
    </box>
  );
};

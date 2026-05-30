import { TextAttributes } from "@opentui/core";
import { useTheme } from "../providers/theme";
import { getModeColor } from "../theme";
import { usePromptConfig } from "../providers/prompt-config";
import { getModeLabel } from "@nightcode/shared";

export function StatusBar() {
  const { mode, model } = usePromptConfig();
  const { colors } = useTheme();

  return (
    <box flexDirection="row" gap={1}>

      <text fg={getModeColor(mode, colors)}>
        {getModeLabel(mode)}
      </text>

      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
        ›
      </text>
      <text>{model}</text>
    </box>
  );
};

import { type ModeType } from "@nightcode/shared";
import { EmptyBorder } from "../border";
import { useTheme } from "../../providers/theme";
import { getModeColor } from "../../theme";

type Props = {
  message: string;
  mode: ModeType;
};

export function UserMessage({ message, mode }: Props) {
  const { colors } = useTheme();

  return (
    <box width="100%" alignItems="center">
      <box
        border={["left"]}
        borderColor={getModeColor(mode, colors)}        width="100%"
        customBorderChars={{
          ...EmptyBorder,
          vertical: "┃",
          bottomLeft: "╹",
        }}
      >
        <box
          justifyContent="center"
          paddingX={2}
          paddingY={1}
          backgroundColor={colors.surface}
          width="100%"
        >
          <text>{message}</text>
        </box>
      </box>
    </box>
  );
};

import "opentui-spinner/react";
import { Mode, type ModeType } from "@nightcode/shared";
import { useTheme } from "../providers/theme";
import { getModeColor } from "../theme";

type Props = {
  mode?: ModeType;
};

export function Spinner({ mode = Mode.BUILD }: Props) {
  const { colors } = useTheme();
  const activeColor = getModeColor(mode, colors);

  return <spinner name="aesthetic" color={activeColor} />;
};

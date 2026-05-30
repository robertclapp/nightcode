import "opentui-spinner/react";
import { Mode, type ModeType } from "@nightcode/shared";
import { useTheme } from "../providers/theme";

type Props = {
  mode?: ModeType;
};

export function Spinner({ mode = Mode.BUILD }: Props) {
  const { colors } = useTheme();
  const activeColor = mode === Mode.BUILD ? colors.primary : colors.planMode;

  return <spinner name="aesthetic" color={activeColor} />;
};

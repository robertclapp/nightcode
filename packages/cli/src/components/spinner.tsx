import "opentui-spinner/react";
import { Mode, type ModeType } from "@nightcode/shared";
import { useTheme } from "../providers/theme";
import { getModeColor } from "../theme";
import { accessibility } from "../lib/accessibility";

type Props = {
  mode?: ModeType;
};

export function Spinner({ mode = Mode.BUILD }: Props) {
  const { colors } = useTheme();
  const activeColor = getModeColor(mode, colors);
  const { reducedMotion, asciiOnly } = accessibility();

  // Reduced motion: a static "busy" glyph instead of the animation. The
  // surrounding "esc to interrupt" hint still conveys that work is in progress.
  if (reducedMotion) {
    return <text fg={activeColor}>{asciiOnly ? "*" : "●"}</text>;
  }

  return <spinner name="aesthetic" color={activeColor} />;
};

export const EmptyBorder = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
};

export const SplitBorderChars = {
  ...EmptyBorder,
  vertical: "┃",
};

/** ASCII fallback for braille displays / terminals that mishandle box-drawing. */
export const AsciiSplitBorderChars = {
  ...EmptyBorder,
  vertical: "|",
  bottomLeft: "",
};

/** Pick the split-border glyphs appropriate for the user's ASCII preference. */
export function splitBorderChars(asciiOnly: boolean) {
  return asciiOnly ? AsciiSplitBorderChars : SplitBorderChars;
}

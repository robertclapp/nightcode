import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createContext, useContext, useState, useCallback } from "react";
import type { ReactNode } from "react";
import { resolveAccessibilityPreferences } from "@nightcode/shared";
import type { ThemeColors, Theme } from "../../theme";
import {
  DEFAULT_THEME,
  HIGH_CONTRAST_THEME,
  MONOCHROME_THEME,
  THEMES,
  themeMeetsContrast,
} from "../../theme";

const CONFIG_DIR = join(homedir(), ".nightcode");
const THEME_PREFERENCES_PATH = join(CONFIG_DIR, "preferences.json");

type ThemePreferences = {
  themeName: string;
};

function getInitialTheme(): Theme {
  const { noColor, highContrast } = resolveAccessibilityPreferences(process.env);

  let savedTheme: Theme | undefined;
  try {
    const preferences = JSON.parse(
      readFileSync(THEME_PREFERENCES_PATH, "utf8"),
    ) as Partial<ThemePreferences>;
    savedTheme = THEMES.find((theme) => theme.name === preferences.themeName);
  } catch {
    // No saved preference; fall through to the accessibility-aware defaults.
  }

  // NO_COLOR is the strongest signal: drop hue entirely.
  if (noColor) return MONOCHROME_THEME;

  // High-contrast mode honors a saved theme only when it's already readable,
  // otherwise it upgrades to the guaranteed-AAA theme.
  if (highContrast) {
    return savedTheme && themeMeetsContrast(savedTheme, "AA") ? savedTheme : HIGH_CONTRAST_THEME;
  }

  return savedTheme ?? DEFAULT_THEME;
};

function persistTheme(theme: Theme) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(
      THEME_PREFERENCES_PATH,
      JSON.stringify({ themeName: theme.name } satisfies ThemePreferences, null, 2),
      "utf8",
    );
  } catch {
    // Ignore preference write failures so theme switching still works for this session.
  }
};

type ThemeContextValue = {
  colors: ThemeColors;
  currentTheme: Theme;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return value;
}

type ThemeProviderProps = {
  children: ReactNode;
};

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [currentTheme, setCurrentTheme] = useState<Theme>(getInitialTheme);

  const setTheme = useCallback((theme: Theme) => {
    setCurrentTheme(theme);
    persistTheme(theme);
  }, []);

  return (
    <ThemeContext.Provider 
      value={{ colors: currentTheme.colors, currentTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

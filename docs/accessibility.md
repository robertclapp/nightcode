# Accessibility

NightCode's CLI is a full-screen terminal UI, which shapes what "accessible"
can mean. This page documents what's supported today, how to turn it on, and the
honest limits.

## Quick start

Set one environment variable for the most accessible profile:

```bash
NIGHTCODE_ACCESSIBLE=1 nightcode
```

That enables the high-contrast theme, reduced motion, and ASCII-only glyphs at
once. The individual switches:

| Variable | Effect |
|---|---|
| `NO_COLOR` | Disables hue entirely — selects the **Monochrome** theme (brightness only). Follows the [no-color.org](https://no-color.org) standard. |
| `FORCE_COLOR` | Forces color on, overriding `NO_COLOR`. |
| `NIGHTCODE_ACCESSIBLE` | Master switch for the full accessible profile (implies the three below). |
| `NIGHTCODE_HIGH_CONTRAST` | Selects the **High Contrast** theme. |
| `NIGHTCODE_REDUCED_MOTION` | Replaces the animated spinner with a static indicator. |
| `NIGHTCODE_ASCII` | Uses ASCII borders/glyphs instead of Unicode box-drawing. |
| `NIGHTCODE_PLAIN` / `--plain` | Runs the **plain (screen-reader) mode** — a linear, announced, plain-text loop instead of the full-screen TUI. |

Any value except `0`, `false`, `no`, `off`, or empty counts as "on".

## What's supported

- **Guaranteed-contrast themes.** Two themes are verified by an automated test to
  clear **WCAG AAA (≥7:1)** for every text color: **High Contrast** (color) and
  **Monochrome** (achromatic, for `NO_COLOR` / total color-blindness). They're
  selectable from `/themes` like any other theme.
- **Color is never the only signal.** Agent mode shows a text label (`Build` /
  `Plan` / `Fix`) alongside its color; the Fix run indicator spells out
  `tests green` / `2/6 failed`; toasts carry a text message. Color reinforces,
  it doesn't carry meaning alone.
- **`NO_COLOR` support** via the Monochrome theme.
- **Reduced motion** for the loading spinner.
- **ASCII fallback** for box-drawing glyphs (braille displays / limited
  terminals).
- **Keyboard-first** — every action is reachable from the keyboard (it's a TUI),
  with on-screen key hints (`tab → agents`, `esc to interrupt`).

## Honest limits & roadmap

A full-screen TUI (alternate screen buffer, absolute layout, constant redraw)
is **fundamentally difficult for screen readers** — NVDA/JAWS/VoiceOver/Orca
read the terminal text buffer and cannot follow a redrawn canvas. No amount of
color or glyph tuning changes that.

For blind and low-vision users there is a separate **plain (screen-reader)
mode**, entered with `nightcode --plain` (or `NIGHTCODE_PLAIN=1`): a linear,
plain-text loop printed to stdout — no alternate screen — that a screen reader
reads top-to-bottom. It announces each turn with a speaker label (`You:` /
`Assistant:`) and describes tool calls in words ("Assistant ran Read file
math.ts"), with no color, box-drawing, or spinners.

What's shipped and tested: the announcement engine (`@nightcode/shared`:
`renderTranscript`, `describeToolPart`, `announceFixRun`), the input/echo/render
loop, the message adapter, and mode detection — the plain loop runs end-to-end.
The remaining integration is connecting it to a **live agent turn** (auth,
session, and the streaming tool loop, which today lives in the React `useChat`
hook); until that lands, plain mode renders the conversation but defers agent
runs to the standard interface. Validating it against a real screen reader
(NVDA/JAWS/VoiceOver/Orca) is the final step.

## Contrast audit

The repo ships WCAG contrast utilities (`@nightcode/shared`:
`contrastRatio`, `meetsContrast`) and a `themeMeetsContrast(theme, level)`
helper. A snapshot of the existing themes found **44 of 224** text-on-background
color pairs below WCAG AA — which is exactly why the guaranteed High Contrast and
Monochrome themes exist. The audit helpers make it straightforward to gate or
improve the rest over time.

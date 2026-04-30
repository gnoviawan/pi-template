# Pi Template Monorepo

Curated Pi extension stack with a simple installer.

## Install

Default install target is **global Pi settings**:

```bash
npx @gnoviawan/pi-template
```

If you want the selected extensions only for the current project:

```bash
npx @gnoviawan/pi-template --local
```

## What this gives you

The installer shows a curated list of Pi extensions and lets you pick the ones you want.

It combines:
- custom extensions maintained in this repo
- external Pi packages that work well with this stack

## Included custom extensions

### `@gnoviawan/pi-auto-session-name`
Automatically gives sessions better titles so `/resume` is easier to browse.

### `@gnoviawan/pi-biome-lsp`
Adds Biome lint, format, and check tools directly into Pi.

### `@gnoviawan/pi-compact-tool-preview`
Makes tool output more compact and easier to scan in the Pi UI.

### `@gnoviawan/pi-setup-providers`
Interactive provider setup wizard for configuring custom model providers.

### `@gnoviawan/pi-session-delete`
Adds an interactive session deletion flow.

### `@gnoviawan/pi-session-usage`
Tracks session time, prompt count, turns, and tool calls.

### `@gnoviawan/pi-token-usage`
Shows token usage across the current session and project history.

### `@gnoviawan/pi-tokens-per-second`
Shows token streaming speed in the status bar.

## Included external Pi packages

These are also available in the installer manifest:

- `pi-mcp-adapter`
- `pi-subagents`
- `pi-markdown-preview`
- `pi-web-access`
- `pi-gitnexus`
- `@m64/pi-remembra-theme`
- `@sting8k/pi-vcc`

## Notes

If you already have older local copies of the same extensions in:

```txt
~/.pi/agent/extensions/
```

and also install the npm package versions, Pi can report tool conflicts.

If that happens, keep only one source active.

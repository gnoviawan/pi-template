# Pi Template Monorepo

Opinionated Pi extension stack in a single monorepo.

This repo exists to solve two problems:
- **distribution** — users should be able to install a curated Pi setup with one installer
- **maintenance** — custom Pi extensions should live in one codebase, but still publish as independent npm packages

The result is:
- one **installer CLI**: `@gnoviawan/pi-template`
- one **central manifest** describing what users can install
- multiple **custom Pi packages** published independently
- optional **external Pi packages** included in the same selection flow

---

## Why this repo exists

Pi already supports installing packages from npm, git, or local paths. That part is easy.

The harder part is building a good user experience for a curated stack like:
- some extensions are **custom** and maintained by you
- some extensions are **external** and already exist on npm
- users should be able to **pick only what they want** instead of manually editing `.pi/settings.json`

This repo provides that missing layer.

The installer reads a manifest, shows a list of available extensions, and writes the selected package sources into Pi config.

---

## What users get

Published installer:

```bash
npx @gnoviawan/pi-template
```

The installer can:
- show the curated extension list
- preselect your recommended stack
- mix **custom packages** and **external npm Pi packages**
- write selected packages into `.pi/settings.json`
- support both **local dev mode** and **published npm mode**

---

## Repository structure

- `apps/installer` — publishable installer CLI package (`@gnoviawan/pi-template`)
- `packages/*` — custom Pi extension packages, each publishable on its own
- `manifest.json` — root source of truth for the curated extension list
- `apps/installer/manifest.json` — synced manifest bundled into the published installer
- `docs/extension-installer-spec.md` — architecture and design spec
- `scripts/*` — manifest sync and publish helpers

---

## Custom extensions in this repo

These are maintained in this monorepo and published as their own Pi packages.

### Core UX

#### `@gnoviawan/pi-auto-session-name`
Why use it:
- automatically gives sessions a clean descriptive title
- makes `/resume` and session browsing much easier
- removes the need to manually rename every new session

### Code quality

#### `@gnoviawan/pi-biome-lsp`
Why use it:
- adds Biome lint / format / check tools directly into Pi
- runs post-edit checks so the model sees issues immediately
- useful when most of your codebase is JS/TS/JSON/CSS

### UI

#### `@gnoviawan/pi-compact-tool-preview`
Why use it:
- replaces verbose built-in tool rendering with compact one-line previews
- makes heavy tool usage easier to scan in the TUI
- especially useful when Pi does lots of reads, greps, and edits in one session

### Providers

#### `@gnoviawan/pi-setup-providers`
Why use it:
- interactive overlay wizard for adding and editing custom providers
- easier than hand-editing `models.json`
- useful when switching between local, proxy, and cloud endpoints

### Session tools

#### `@gnoviawan/pi-session-delete`
Why use it:
- interactive session deletion command
- easier cleanup for projects with many Pi session files

### Observability

#### `@gnoviawan/pi-session-usage`
Why use it:
- tracks time usage, prompt count, turns, and tool calls
- good for understanding how much work happened in a session

#### `@gnoviawan/pi-token-usage`
Why use it:
- shows token usage for current session and project history
- useful for cost awareness and usage tracking

#### `@gnoviawan/pi-tokens-per-second`
Why use it:
- shows real-time token streaming speed in the status bar
- handy when comparing providers or diagnosing slow responses

---

## External Pi packages included in the manifest

These are not maintained in this repo, but are part of the curated stack:

- `pi-mcp-adapter` — MCP integration support
- `pi-subagents` — delegated agent chains and parallel workflows
- `pi-markdown-preview` — markdown preview rendering helpers
- `pi-web-access` — web search, fetch, and research tools
- `pi-gitnexus` — code graph exploration and impact analysis
- `@m64/pi-remembra-theme` — Remembra theme package
- `@sting8k/pi-vcc` — VCC recall / session history tooling

---

## How the manifest works

Root manifest:

- `manifest.json`

This file is the installer source of truth.
It contains:
- custom workspace packages from `packages/*`
- external npm packages
- labels, descriptions, categories, and defaults

Before publishing the installer, the root manifest is synced into:
- `apps/installer/manifest.json`

That matters because the published npm package runs outside the monorepo and needs a bundled manifest file.

---

## Local development

Install dependencies:

```bash
npm install
```

Run the installer against a target project in **dev mode**:

```bash
node apps/installer/src/cli.js --dev --cwd /path/to/project
```

Dev mode resolves custom packages to local workspace paths instead of npm package sources.

### Sync installer manifest

```bash
npm run manifest:sync
```

Use this after changing the root `manifest.json` if you want to verify what will be bundled into the published installer.

---

## Published usage

Once published, users install your curated stack with:

```bash
npx @gnoviawan/pi-template
```

The installer writes package sources into `.pi/settings.json`.

---

## Important note about legacy local extensions

If a user already has the same extension loaded from:

- `~/.pi/agent/extensions/...`

and also installs the npm package version, Pi can report **tool conflicts**.

Typical example:
- local `auto-session-name` registers `name_session`
- npm `@gnoviawan/pi-auto-session-name` also registers `name_session`

### Recommended migration

Use **one source only**:
- either keep the legacy local extension
- or move fully to the npm package version

For normal usage, prefer the **npm package version** and disable the old local copy.

---

## Release workflow

### 1. Create the GitHub repo

```bash
bash scripts/create-github-repo.sh pi-template public
```

### 2. Login to npm

```bash
npm login
npm whoami
```

### 3. Sync installer manifest

```bash
npm run manifest:sync
```

### 4. Dry-run publish all packages

```bash
npm run publish:npm:dry
```

### 5. Publish all custom packages + installer

```bash
npm run publish:npm
```

This publishes, in order:
- all `packages/*` custom Pi packages
- `apps/installer` as `@gnoviawan/pi-template`

---

## Updating one package

If only one custom package changes, publish that package alone instead of re-publishing everything.

Example:

```bash
cd packages/setup-providers
npm publish --access public
```

If you use the bulk publish script, every package it touches must have a new version.

---

## Recommended next improvements

Good next steps for this repo:
- add **Changesets** for version management
- add **GitHub Actions** for release automation
- add installer flags such as `--only`, `--exclude`, or presets
- add migration checks for legacy `~/.pi/agent/extensions` conflicts

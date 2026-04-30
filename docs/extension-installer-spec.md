# One-Repo Pi Extension Installer Spec

## Goal

Build a single repository that contains:

1. an installer CLI
2. a central manifest
3. multiple custom Pi extensions
4. optional support for third-party npm-based Pi packages

The user experience should be:

```bash
npx @gnoviawan/pi-template
```

Then:
- the CLI shows a list of available extensions
- the user can select one, many, or all
- the CLI writes the selected items into project-local Pi config
- Pi can then install/load the selected packages normally

---

## Primary Decision

Use **one monorepo** with:

- **apps/installer** for the CLI
- **packages/** for custom extensions
- **manifest.json** at the repo root as the source of truth

This gives:
- one repo to maintain
- one manifest to curate
- per-extension installability
- future npm publishing per extension
- clean support for mixing custom and third-party packages

---

## Non-Goals

This spec does **not** try to:
- build a package marketplace backend
- auto-publish packages in this first phase
- support remote copying raw extension source into `.pi/extensions/`
- manage extension updates beyond normal Pi package update behavior

---

## Repository Layout

```txt
pi-template/
├─ apps/
│  └─ installer/
│     ├─ package.json
│     ├─ src/
│     │  ├─ cli.ts
│     │  ├─ manifest.ts
│     │  ├─ prompts.ts
│     │  ├─ settings.ts
│     │  └─ install-plan.ts
│     └─ tsconfig.json
├─ packages/
│  ├─ ext-a/
│  │  ├─ package.json
│  │  ├─ extensions/
│  │  │  └─ index.ts
│  │  └─ README.md
│  ├─ ext-b/
│  │  ├─ package.json
│  │  ├─ extensions/
│  │  │  └─ index.ts
│  │  └─ README.md
│  └─ ext-c/
│     ├─ package.json
│     ├─ extensions/
│     │  └─ index.ts
│     └─ README.md
├─ manifest.json
├─ package.json
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
└─ README.md
```

---

## Architecture Overview

### 1. Installer CLI

The installer is a normal Node CLI package.

Responsibilities:
- load and validate `manifest.json`
- render category/grouped extension list
- support multi-select and select-all
- resolve selected items into Pi package sources
- update `.pi/settings.json`
- optionally run `pi install ... -l`

### 2. Custom Extensions

Each custom extension lives in `packages/<name>` as its own Pi package.

Each package should be independently installable later.

Minimal extension package shape:

```json
{
  "name": "@gnoviawan/pi-ext-a",
  "version": "0.1.0",
  "keywords": ["pi-package"],
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@sinclair/typebox": "*"
  },
  "pi": {
    "extensions": ["./extensions"]
  }
}
```

### 3. Central Manifest

`manifest.json` is the source of truth for what the installer shows.

It can reference:
- local monorepo custom packages
- published npm Pi packages
- future external packages if needed

---

## Installation Strategy

### Preferred behavior

The installer writes selected sources to project-local:

```txt
<project>/.pi/settings.json
```

using Pi's native `packages` setting.

Example result:

```json
{
  "packages": [
    "npm:@gnoviawan/pi-ext-a@0.1.0",
    "npm:@gnoviawan/pi-ext-b@0.1.0",
    "npm:@someone/pi-review-tools"
  ]
}
```

### Development mode behavior

Before custom packages are published, the installer may write **local file paths** instead of npm sources.

Example:

```json
{
  "packages": [
    "../pi-template/packages/ext-a",
    "../pi-template/packages/ext-b"
  ]
}
```

Important:
- relative paths are resolved against `.pi/settings.json`
- this mode is intended for local development or same-machine usage
- this is not the main distribution mode for end users

### Optional direct install mode

The CLI may also support:

```bash
pi install <source> -l
```

but this is optional.

For first implementation, writing `.pi/settings.json` is enough and simpler.

---

## Manifest Specification

## File

Root file:

```txt
manifest.json
```

## Purpose

Defines all installable items shown by the installer.

## Top-Level Shape

```json
{
  "version": 1,
  "packages": [
    {
      "id": "ext-a",
      "label": "Extension A",
      "description": "Short summary",
      "category": "Custom",
      "source": {
        "mode": "workspace",
        "path": "packages/ext-a",
        "npm": "@gnoviawan/pi-ext-a"
      },
      "enabledByDefault": true,
      "tags": ["custom", "tools"]
    }
  ]
}
```

## Field Definitions

### `version`
Manifest schema version.

- type: `number`
- initial value: `1`

### `packages`
Array of installable items.

### Item fields

#### `id`
Stable unique ID.

- type: `string`
- required
- should be kebab-case

#### `label`
Human-readable name shown in CLI.

- type: `string`
- required

#### `description`
Short help text in selection UI.

- type: `string`
- optional

#### `category`
Used to group items in the UI.

- type: `string`
- optional
- examples: `Custom`, `Themes`, `Review`, `Community`

#### `source`
Describes how this item resolves for install.

Shape:

```json
{
  "mode": "workspace",
  "path": "packages/ext-a",
  "npm": "@gnoviawan/pi-ext-a"
}
```

Supported modes:

##### `workspace`
For custom packages inside the same repo.

Fields:
- `mode`: `workspace`
- `path`: relative package path inside repo
- `npm`: optional future npm package name

Resolution rules:
- in dev mode, installer writes local path
- in release mode, installer writes `npm:<name>` if `npm` exists

##### `npm`
For external or already-published packages.

Fields:

```json
{
  "mode": "npm",
  "name": "@someone/pi-package",
  "version": "^1.2.0"
}
```

Resolution:
- installer writes `npm:@someone/pi-package@^1.2.0`
- if no version, installer writes `npm:@someone/pi-package`

#### `enabledByDefault`
Whether an item is preselected.

- type: `boolean`
- optional
- default: `false`

#### `tags`
Freeform metadata for filtering/search later.

- type: `string[]`
- optional

#### `requires`
List of other item IDs that should also be selected.

- type: `string[]`
- optional

Example:

```json
{
  "id": "ext-review-ui",
  "requires": ["ext-core-utils"]
}
```

Installer behavior:
- auto-add missing dependencies
- show a notice before writing config

#### `hidden`
Hide item from normal list but keep it addressable internally.

- type: `boolean`
- optional
- default: `false`

---

## Source Resolution Rules

The installer resolves each selected manifest item into one Pi package source string.

### Resolution modes

#### Mode: `dev`
Used while developing locally.

For `workspace` items:
- resolve absolute path to package dir
- write a relative path into target `.pi/settings.json` when possible

Example output:

```json
{
  "packages": [
    "../pi-template/packages/ext-a"
  ]
}
```

#### Mode: `release`
Used for end users after packages are published.

For `workspace` items:
- require `source.npm`
- write `npm:<package-name>` or `npm:<package-name>@<version>`

Example output:

```json
{
  "packages": [
    "npm:@gnoviawan/pi-ext-a"
  ]
}
```

For `npm` items:
- always write npm source

---

## CLI Requirements

## Command

Preferred user entrypoint:

```bash
npx @gnoviawan/pi-template
```

Optional aliases later:

```bash
npx @gnoviawan/pi-template init
npx @gnoviawan/pi-template install
```

## Flags

Initial flags:

- `--cwd <path>`: target project directory
- `--manifest <path>`: override manifest path
- `--dev`: use workspace/local-path resolution
- `--write-only`: only write `.pi/settings.json`, do not run `pi install`
- `--install`: run `pi install ... -l` after writing config
- `--select-all`: bypass prompt and select all visible items
- `--yes`: accept confirmations

---

## CLI Flow

### Interactive flow

1. determine target project directory
2. load manifest
3. validate manifest
4. show grouped multi-select UI
5. allow:
   - toggle individual items
   - select all
   - deselect all
6. expand `requires`
7. show summary of selected packages
8. merge into `.pi/settings.json`
9. optionally run `pi install ... -l`
10. print success summary

### Non-interactive flow

Examples:

```bash
npx @gnoviawan/pi-template --select-all --yes --write-only
```

or later:

```bash
npx @gnoviawan/pi-template --only ext-a,ext-b --yes
```

---

## Settings File Behavior

## Target file

Project-local only in first version:

```txt
<target-project>/.pi/settings.json
```

## Merge rules

If file does not exist:
- create it

If file exists:
- parse JSON
- preserve unrelated keys
- merge/update only the `packages` array

### Package merge semantics

- append newly selected package sources if missing
- do not duplicate existing entries
- preserve existing non-conflicting package entries
- do not remove previous packages unless explicitly asked in a future command

Example existing file:

```json
{
  "model": "anthropic/claude-sonnet-4",
  "packages": ["npm:@someone/already-installed"]
}
```

After install:

```json
{
  "model": "anthropic/claude-sonnet-4",
  "packages": [
    "npm:@someone/already-installed",
    "npm:@gnoviawan/pi-ext-a"
  ]
}
```

---

## Custom Extension Package Rules

Each package under `packages/*` must:

1. be a valid npm package
2. be a valid Pi package
3. be independently loadable by Pi

## Required minimal `package.json`

```json
{
  "name": "@gnoviawan/pi-ext-a",
  "version": "0.1.0",
  "private": false,
  "keywords": ["pi-package"],
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*"
  },
  "pi": {
    "extensions": ["./extensions"]
  }
}
```

## Package conventions

- package name should start with a consistent scope/prefix
- one logical extension package per folder
- package-level README should document purpose and config
- runtime deps go in `dependencies`
- Pi core packages stay in `peerDependencies` when appropriate

---

## Workspace Tooling

Recommended:
- package manager: `pnpm`
- workspace config: `pnpm-workspace.yaml`
- language: TypeScript
- build: `tsup` or `tsc`

Example root `pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
```

Root `package.json` example:

```json
{
  "name": "pi-template-monorepo",
  "private": true,
  "packageManager": "pnpm@10",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "build": "pnpm -r build",
    "dev": "pnpm --filter @gnoviawan/pi-template-installer dev",
    "check": "pnpm -r check"
  }
}
```

---

## Example Manifest

```json
{
  "version": 1,
  "packages": [
    {
      "id": "core-tools",
      "label": "Core Tools",
      "description": "Base utilities used by other extensions",
      "category": "Custom",
      "enabledByDefault": true,
      "source": {
        "mode": "workspace",
        "path": "packages/core-tools",
        "npm": "@gnoviawan/pi-core-tools"
      },
      "tags": ["custom", "core"]
    },
    {
      "id": "review-helper",
      "label": "Review Helper",
      "description": "Assist review and audit workflows",
      "category": "Custom",
      "source": {
        "mode": "workspace",
        "path": "packages/review-helper",
        "npm": "@gnoviawan/pi-review-helper"
      },
      "requires": ["core-tools"],
      "tags": ["custom", "review"]
    },
    {
      "id": "community-theme-pack",
      "label": "Community Theme Pack",
      "description": "Third-party Pi theme collection",
      "category": "Community",
      "source": {
        "mode": "npm",
        "name": "@someone/pi-theme-pack",
        "version": "^1.0.0"
      },
      "tags": ["community", "theme"]
    }
  ]
}
```

---

## Installer Internal Modules

Suggested module split for `apps/installer/src`:

### `cli.ts`
Entry point.
- parse args
- call application flow
- print results/errors

### `manifest.ts`
- read manifest file
- validate schema
- expose typed manifest model

### `prompts.ts`
- render interactive selection UI
- support select all / deselect all

### `install-plan.ts`
- resolve selected IDs
- expand dependencies via `requires`
- convert items to Pi package source strings

### `settings.ts`
- load/create `.pi/settings.json`
- merge package entries
- write file safely

---

## Validation Rules

Manifest validation should fail if:
- duplicate item IDs exist
- `workspace` item path does not exist
- `workspace` item has no `npm` field when running in `release` mode
- `requires` references unknown IDs
- `npm` item has empty package name

Package validation warnings:
- package exists but has no `pi` key
- package name does not match manifest `source.npm`
- package is marked hidden and enabledByDefault at the same time

---

## Error Handling

The CLI should produce friendly errors for:
- manifest not found
- invalid JSON in manifest
- invalid JSON in `.pi/settings.json`
- target project dir missing
- package path missing
- `pi` executable missing when `--install` is requested

Error messages should clearly say:
- what failed
- which file/package caused it
- what the user should do next

---

## Versioning Strategy

### Phase 1
- monorepo private root
- custom extension packages may remain unpublished
- installer can run in `--dev` mode for local path output

### Phase 2
- publish custom packages individually to npm
- keep same manifest IDs
- switch default resolution from local-path to npm source

### Phase 3
- optional CI release automation
- optional manifest generation from workspace package metadata

---

## Recommended First Milestone

Build the smallest useful version with these constraints:

### In scope
- one repo monorepo layout
- root manifest
- 2 sample custom extension packages
- installer CLI
- interactive multi-select
- select all
- writes `.pi/settings.json`
- `--dev` local workspace resolution

### Out of scope for milestone 1
- auto-publishing to npm
- remote manifest fetching
- uninstall flow
- package update flow
- rich search/filter UI
- copying raw extension files into `.pi/extensions/`

---

## Final Recommendation

Yes, **we can absolutely build this in one repo**.

Best structure:
- **one monorepo**
- **installer app inside the same repo**
- **custom extensions as separate packages inside `packages/`**
- **one root manifest as the installer source of truth**

This is the best compromise between:
- easy maintenance
- future scalability
- selectable extensions
- compatibility with Pi package installation model

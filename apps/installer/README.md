# @gnoviawan/pi-template

Installer CLI for selecting custom Pi extensions from the monorepo manifest.

## Usage

```bash
npx @gnoviawan/pi-template
```

## Local dev

```bash
node src/cli.js --dev --cwd /path/to/project
```

The published package includes its own bundled `manifest.json`, so `npx @gnoviawan/pi-template` can run outside the monorepo checkout.

## Publish

```bash
npm publish --access public
```

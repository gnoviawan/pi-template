#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getDefaultPackageIds, loadManifest } from "./manifest.js";
import { buildInstallPlan } from "./install-plan.js";
import { promptForConfirmation, promptForPackageIds } from "./prompts.js";
import { mergePackageSources, readSettings, writeSettings } from "./settings.js";

function parseArgs(argv) {
  const args = {
    cwd: process.cwd(),
    manifest: null,
    dev: false,
    install: false,
    writeOnly: false,
    yes: false,
    selectAll: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--cwd") args.cwd = path.resolve(argv[++i]);
    else if (token === "--manifest") args.manifest = path.resolve(argv[++i]);
    else if (token === "--dev") args.dev = true;
    else if (token === "--install") args.install = true;
    else if (token === "--write-only") args.writeOnly = true;
    else if (token === "--yes") args.yes = true;
    else if (token === "--select-all") args.selectAll = true;
    else if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`@gnoviawan/pi-template\n\nUsage:\n  node apps/installer/src/cli.js [options]\n\nOptions:\n  --cwd <path>       Target project directory\n  --manifest <path>  Override manifest path\n  --dev              Resolve workspace packages to local paths\n  --install          Run pi install -l for each resolved source after writing config\n  --write-only       Only update .pi/settings.json\n  --select-all       Select all visible packages without prompting\n  --yes              Skip confirmation prompt\n  -h, --help         Show this help\n`);
}

function findRepoRoot() {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "../../..");
}

function ensureTargetDir(targetDir) {
  if (!existsSync(targetDir)) {
    throw new Error(`Target project directory does not exist: ${targetDir}`);
  }
}

function maybeRunPiInstall(targetProjectDir, packageSources) {
  for (const source of packageSources) {
    const result = spawnSync("pi", ["install", source, "-l"], {
      cwd: targetProjectDir,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    if (result.status !== 0) {
      throw new Error(`pi install failed for ${source}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureTargetDir(args.cwd);

  const repoRoot = findRepoRoot();
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifestPath = args.manifest ?? path.join(packageRoot, "manifest.json");
  const manifest = loadManifest(manifestPath, {
    validateWorkspacePaths: Boolean(args.manifest),
  });

  const selectedIds = args.selectAll
    ? manifest.packages.filter((item) => !item.hidden).map((item) => item.id)
    : await promptForPackageIds(manifest, getDefaultPackageIds(manifest));

  if (selectedIds.length === 0) {
    console.log("No packages selected. Nothing to do.");
    return;
  }

  const plan = buildInstallPlan(selectedIds, manifest, {
    repoRoot,
    targetProjectDir: args.cwd,
    devMode: args.dev,
  });

  if (!args.yes) {
    const confirmed = await promptForConfirmation(plan, args.cwd);
    if (!confirmed) {
      console.log("Cancelled.");
      return;
    }
  }

  const currentSettings = readSettings(args.cwd);
  const nextSettings = mergePackageSources(currentSettings, plan.packageSources);
  const settingsPath = writeSettings(args.cwd, nextSettings);

  console.log(`Updated ${settingsPath}`);
  for (const source of plan.packageSources) {
    console.log(`  + ${source}`);
  }

  if (args.install && !args.writeOnly) {
    maybeRunPiInstall(args.cwd, plan.packageSources);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const packages = [
  "packages/auto-session-name",
  "packages/biome-lsp",
  "packages/compact-tool-preview",
  "packages/session-delete",
  "packages/session-usage",
  "packages/setup-providers",
  "packages/token-usage",
  "packages/tokens-per-second",
  "apps/installer",
];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const syncManifest = spawnSync("node", [path.join(repoRoot, "scripts", "sync-installer-manifest.mjs")], {
  cwd: repoRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (syncManifest.status !== 0) {
  console.error("Failed syncing installer manifest.");
  process.exit(syncManifest.status ?? 1);
}

for (const relPath of packages) {
  const cwd = path.join(repoRoot, relPath);
  console.log(`\n==> Publishing ${relPath}${dryRun ? " (dry run)" : ""}`);

  const publishArgs = ["publish", "--access", "public"];
  if (dryRun) publishArgs.push("--dry-run");

  const result = spawnSync("npm", publishArgs, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    console.error(`Failed publishing ${relPath}`);
    process.exit(result.status ?? 1);
  }
}

console.log("\nAll publish steps completed.");

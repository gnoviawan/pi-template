#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const rootManifestPath = path.join(repoRoot, "manifest.json");
const installerManifestPath = path.join(repoRoot, "apps", "installer", "manifest.json");

const manifest = JSON.parse(readFileSync(rootManifestPath, "utf8"));
const installerManifest = {
  ...manifest,
  packages: manifest.packages.map((item) => {
    if (item.source?.mode !== "workspace") {
      return item;
    }

    return {
      ...item,
      source: {
        ...item.source,
        path: path.posix.join("..", "..", item.source.path),
      },
    };
  }),
};

writeFileSync(installerManifestPath, `${JSON.stringify(installerManifest, null, 2)}\n`);
console.log(`Synced ${installerManifestPath}`);

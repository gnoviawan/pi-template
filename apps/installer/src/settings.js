import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function getSettingsPath(options = {}) {
  if (options.global) {
    return path.join(homedir(), ".pi", "agent", "settings.json");
  }

  return path.join(options.cwd, ".pi", "settings.json");
}

export function readSettings(options = {}) {
  const settingsPath = getSettingsPath(options);
  if (!existsSync(settingsPath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse existing settings JSON at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function mergePackageSources(settings, packageSources) {
  const existing = Array.isArray(settings.packages) ? settings.packages : [];
  const merged = [...existing];

  for (const source of packageSources) {
    if (!merged.includes(source)) {
      merged.push(source);
    }
  }

  return {
    ...settings,
    packages: merged,
  };
}

export function writeSettings(settings, options = {}) {
  const settingsPath = getSettingsPath(options);
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settingsPath;
}

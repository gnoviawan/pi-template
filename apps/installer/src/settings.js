import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function getSettingsPath(targetProjectDir) {
  return path.join(targetProjectDir, ".pi", "settings.json");
}

export function readSettings(targetProjectDir) {
  const settingsPath = getSettingsPath(targetProjectDir);
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

export function writeSettings(targetProjectDir, settings) {
  const settingsPath = getSettingsPath(targetProjectDir);
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return settingsPath;
}

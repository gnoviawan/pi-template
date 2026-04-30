import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function loadManifest(manifestPath, options = {}) {
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to parse manifest JSON at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  validateManifest(parsed, manifestPath, options);
  return parsed;
}

function validateManifest(manifest, manifestPath, options = {}) {
  const { validateWorkspacePaths = true } = options;
  assert(manifest && typeof manifest === "object", "Manifest must be an object.");
  assert(typeof manifest.version === "number", "Manifest version must be a number.");
  assert(Array.isArray(manifest.packages), "Manifest packages must be an array.");

  const ids = new Set();
  for (const item of manifest.packages) {
    assert(item && typeof item === "object", "Each manifest package must be an object.");
    assert(typeof item.id === "string" && item.id.length > 0, "Each package needs a non-empty id.");
    assert(!ids.has(item.id), `Duplicate package id in manifest: ${item.id}`);
    ids.add(item.id);
    assert(typeof item.label === "string" && item.label.length > 0, `Package ${item.id} needs a label.`);
    assert(item.source && typeof item.source === "object", `Package ${item.id} needs a source object.`);

    const source = item.source;
    if (source.mode === "workspace") {
      assert(typeof source.path === "string" && source.path.length > 0, `Workspace package ${item.id} needs source.path.`);
      if (validateWorkspacePaths) {
        const packagePath = path.resolve(path.dirname(manifestPath), source.path);
        assert(existsSync(packagePath), `Workspace package path does not exist for ${item.id}: ${packagePath}`);
      }
    } else if (source.mode === "npm") {
      assert(typeof source.name === "string" && source.name.length > 0, `npm package ${item.id} needs source.name.`);
    } else {
      throw new Error(`Unsupported source.mode for ${item.id}: ${source.mode}`);
    }
  }
}

export function getVisiblePackages(manifest) {
  return manifest.packages.filter((item) => !item.hidden);
}

export function getDefaultPackageIds(manifest) {
  return getVisiblePackages(manifest)
    .filter((item) => item.enabledByDefault)
    .map((item) => item.id);
}

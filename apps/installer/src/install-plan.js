import path from "node:path";

function createPackageMap(manifest) {
  return new Map(manifest.packages.map((item) => [item.id, item]));
}

function expandWithRequirements(selectedIds, manifest) {
  const packageMap = createPackageMap(manifest);
  const resolved = new Set(selectedIds);
  const queue = [...selectedIds];

  while (queue.length > 0) {
    const currentId = queue.shift();
    const item = packageMap.get(currentId);
    if (!item) {
      throw new Error(`Unknown package id: ${currentId}`);
    }

    for (const dependencyId of item.requires ?? []) {
      if (!packageMap.has(dependencyId)) {
        throw new Error(`Package ${currentId} requires unknown package id: ${dependencyId}`);
      }
      if (!resolved.has(dependencyId)) {
        resolved.add(dependencyId);
        queue.push(dependencyId);
      }
    }
  }

  return [...resolved];
}

function toSourceString(item, { repoRoot, targetProjectDir, devMode }) {
  if (item.source.mode === "npm") {
    return item.source.version
      ? `npm:${item.source.name}@${item.source.version}`
      : `npm:${item.source.name}`;
  }

  if (item.source.mode === "workspace") {
    if (!devMode) {
      if (!item.source.npm) {
        throw new Error(`Package ${item.id} has no npm name for release mode.`);
      }
      return `npm:${item.source.npm}`;
    }

    const settingsDir = path.join(targetProjectDir, ".pi");
    const absolutePackagePath = path.resolve(repoRoot, item.source.path);
    const relativePath = path
      .relative(settingsDir, absolutePackagePath)
      .split(path.sep)
      .join("/");
    return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
  }

  throw new Error(`Unsupported source mode for ${item.id}: ${item.source.mode}`);
}

export function buildInstallPlan(selectedIds, manifest, options) {
  const expandedIds = expandWithRequirements(selectedIds, manifest);
  const packageMap = createPackageMap(manifest);
  const items = expandedIds.map((id) => packageMap.get(id)).filter(Boolean);

  return {
    ids: expandedIds,
    items,
    packageSources: items.map((item) => toSourceString(item, options)),
  };
}

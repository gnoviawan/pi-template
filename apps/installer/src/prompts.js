import { checkbox, confirm } from "@inquirer/prompts";

export async function promptForPackageIds(manifest, defaultIds) {
  const visiblePackages = manifest.packages.filter((item) => !item.hidden);
  return checkbox({
    message: "Select Pi extensions to add",
    choices: visiblePackages.map((item) => ({
      name: item.category
        ? `[${item.category}] ${item.label}${item.description ? ` — ${item.description}` : ""}`
        : `${item.label}${item.description ? ` — ${item.description}` : ""}`,
      value: item.id,
      checked: defaultIds.includes(item.id),
    })),
    required: true,
    loop: false,
  });
}

export async function promptForConfirmation(plan, targetProjectDir) {
  const lines = [
    `Target project: ${targetProjectDir}`,
    "",
    "Packages to add:",
    ...plan.items.map(
      (item, index) => `  ${index + 1}. ${item.label} -> ${plan.packageSources[index]}`,
    ),
  ];

  return confirm({
    message: `${lines.join("\n")}\n\nContinue?`,
    default: true,
  });
}

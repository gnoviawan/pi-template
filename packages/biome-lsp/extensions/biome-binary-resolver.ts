/**
 * Resolve the native Biome CLI binary for the current platform.
 *
 * WHY THIS EXISTS:
 * Node.js >= 18.20 / 20.12 / 22+ (CVE-2024-27980 mitigation) SYNCHRONOUSLY
 * throws `spawn EINVAL` when you spawn a `.cmd`/`.bat` file without
 * `shell: true`. The old code did `spawn("npx.cmd", ["@biomejs/biome", ...])`,
 * which failed at every session start on Windows + modern Node.
 *
 * FIX: resolve the real native executable shipped by the platform-specific
 * `@biomejs/cli-*` package (a .exe / mach-o / elf, not a .cmd) and spawn
 * THAT directly with `shell: false`. This is exactly what the official
 * `@biomejs/biome/bin/biome` shim does internally.
 */
import { createRequire } from "node:module";
import { arch, env, platform, release, version } from "node:process";
import { execSync } from "node:child_process";

// Resolve modules in the context of the `@biomejs/biome` package, where the
// platform-specific `@biomejs/cli-*` packages live as siblings. This keeps
// resolution correct regardless of where this resolver file is invoked from
// (it is robust to hoisting and to being copied/transpiled).
// Resolve modules in the context of the `@biomejs/biome` package, where the
// platform-specific `@biomejs/cli-*` packages live as siblings. This keeps
// resolution correct regardless of where this resolver file is invoked from.
const require = createRequire(import.meta.url);
const biomePkgJsonPath = require.resolve("@biomejs/biome/package.json");
const requireFromBiome = createRequire(biomePkgJsonPath);

const PLATFORMS = {
	win32: {
		x64: "@biomejs/cli-win32-x64/biome.exe",
		arm64: "@biomejs/cli-win32-arm64/biome.exe",
	},
	darwin: {
		x64: "@biomejs/cli-darwin-x64/biome",
		arm64: "@biomejs/cli-darwin-arm64/biome",
	},
	linux: {
		x64: "@biomejs/cli-linux-x64/biome",
		arm64: "@biomejs/cli-linux-arm64/biome",
	},
	"linux-musl": {
		x64: "@biomejs/cli-linux-x64-musl/biome",
		arm64: "@biomejs/cli-linux-arm64-musl/biome",
	},
};

function isMusl(): boolean {
	let stderr: Buffer | string;
	try {
		stderr = execSync("ldd --version", { stdio: ["pipe", "pipe", "pipe"] });
	} catch (err) {
		stderr = (err as { stderr?: Buffer | string }).stderr ?? "";
	}
	return String(stderr).includes("musl");
}

/** Environment variables Biome expects when launched from an npm install. */
export function getBiomeSpawnEnv(): NodeJS.ProcessEnv {
	let packageManager: string | null = null;
	const userAgent = env.npm_config_user_agent;
	if (userAgent) packageManager = userAgent.split(" ")[0] ?? null;

	return {
		...env,
		BIOME_DISTRIBUTION: "npm",
		JS_RUNTIME_VERSION: version,
		JS_RUNTIME_NAME: release.name,
		...(packageManager != null ? { NODE_PACKAGE_MANAGER: packageManager } : {}),
	};
}

/**
 * Resolve the native Biome binary path for the current platform.
 * Honours `BIOME_BINARY` like the upstream shim.
 * Throws if no prebuilt binary is available for this platform.
 */
export function resolveBiomeBinary(): string {
	const spec =
		env.BIOME_BINARY ||
		(platform === "linux" && isMusl()
			? PLATFORMS["linux-musl"]?.[arch as "x64" | "arm64"]
			: PLATFORMS[platform as keyof typeof PLATFORMS]?.[
					arch as "x64" | "arm64"
				]);

	if (!spec) {
		throw new Error(
			`No prebuilt Biome binary for platform=${platform} arch=${arch}. ` +
				"Set BIOME_BINARY to point at a local build.",
		);
	}

	return requireFromBiome.resolve(spec);
}

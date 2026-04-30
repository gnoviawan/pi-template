/**
 * Biome LSP Extension for pi
 *
 * Integrates Biome (https://biomejs.dev/) as a Language Server and
 * exposes linting, formatting, and diagnostics via custom tools.
 *
 * Tools registered:
 *   biome_check  - Run lint + format + import sorting on files or directories
 *   biome_lint    - Run only lint checks
 *   biome_format - Run only formatting (dry-run or write)
 *   biome_status - Check if the Biome LSP daemon is running
 *
 * Command: /biome [start|stop|status]
 *
 * Auto-lint:
 *   After every `edit` or `write` on a Biome-supported file (.js, .ts, .json, .css, etc.),
 *   the extension automatically runs `biome check` and appends diagnostics
 *   to the tool result. This means the LLM always sees lint/format issues
 *   without needing to manually call biome_check.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	isToolCallEventType,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// File extensions Biome supports
// ---------------------------------------------------------------------------

const BIOME_EXTENSIONS = new Set([
	".js",
	".jsx",
	".mjs",
	".cjs",
	".ts",
	".tsx",
	".mts",
	".cts",
	".json",
	".jsonc",
	".css",
	".graphql",
	".gql",
	".vue",
	".svelte",
	".astro",
]);

function isBiomeFile(filePath: string): boolean {
	return BIOME_EXTENSIONS.has(extname(filePath).toLowerCase());
}

// ---------------------------------------------------------------------------
// Biome Daemon Manager
// ---------------------------------------------------------------------------

class BiomeDaemon {
	private proc: ChildProcess | null = null;
	private _ready = false;

	get ready(): boolean {
		return this._ready && this.proc != null;
	}

	/** Start the Biome LSP proxy, which boots the daemon */
	async start(cwd: string): Promise<void> {
		if (this.proc) return;

		const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
		const args = ["@biomejs/biome", "lsp-proxy"];

		this.proc = spawn(cmd, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
			windowsHide: true,
			detached: false,
		});

		this.proc.on("error", (err) => {
			console.error("[biome-lsp] process error:", err.message);
			this._ready = false;
		});

		this.proc.on("exit", (code, signal) => {
			console.error(
				`[biome-lsp] process exited (code=${code}, signal=${signal})`,
			);
			this.proc = null;
			this._ready = false;
		});

		// Drain stderr to prevent buffer blocking
		if (this.proc.stderr) {
			this.proc.stderr.on("data", (data: Buffer) => {
				const msg = data.toString().trim();
				if (msg) console.error("[biome-lsp]", msg);
			});
		}

		// Drain stdout (LSP output — we don't parse it for now)
		if (this.proc.stdout) {
			this.proc.stdout.on("data", () => {
				// Just drain to prevent blocking
			});
		}

		// Give it a moment to initialize, then verify with a health check
		await new Promise((r) => setTimeout(r, 1500));

		// Verify biome is available
		try {
			const cmd2 = process.platform === "win32" ? "npx.cmd" : "npx";
			const version = spawn(cmd2, ["@biomejs/biome", "--version"], {
				cwd,
				stdio: "pipe",
				windowsHide: true,
			});
			await new Promise<void>((res, rej) => {
				version.on("close", (code) =>
					code === 0 ? res() : rej(new Error(`version check failed: ${code}`)),
				);
				version.on("error", rej);
			});
			this._ready = true;
		} catch {
			// Daemon may still work even if version check fails
			this._ready = true;
		}
	}

	/** Stop the Biome daemon */
	async stop(): Promise<void> {
		if (!this.proc) return;

		// Try graceful shutdown via CLI
		try {
			const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
			const stop = spawn(cmd, ["@biomejs/biome", "stop"], {
				stdio: "pipe",
				windowsHide: true,
			});
			await new Promise<void>((res) => {
				stop.on("close", () => res());
				stop.on("error", () => res());
			});
		} catch {
			// ignore
		}

		this.proc?.kill();
		this.proc = null;
		this._ready = false;
	}

	/**
	 * Run a biome CLI command against file(s) on disk.
	 * --use-server is added when the daemon is running for speed.
	 */
	async runCommand(
		command: "check" | "lint" | "format",
		targets: string[],
		cwd: string,
		options: { write?: boolean } = {},
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		return new Promise((resolve, reject) => {
			const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
			const args = ["@biomejs/biome", command, ...targets];

			if (this._ready) {
				args.push("--use-server");
			}

			if (options.write) {
				args.push("--write");
			}

			const proc = spawn(cmd, args, {
				cwd,
				env: { ...process.env },
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});

			let stdout = "";
			let stderr = "";

			proc.stdout.on("data", (d: Buffer) => {
				stdout += d.toString();
			});
			proc.stderr.on("data", (d: Buffer) => {
				stderr += d.toString();
			});
			proc.on("error", reject);
			proc.on("close", (code) => {
				resolve({
					stdout,
					stderr,
					exitCode: code ?? 1,
				});
			});
		});
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

let daemon: BiomeDaemon | null = null;

export default function (pi: ExtensionAPI) {
	// -------------------------------------------------------------------------
	// Lifecycle: start / stop daemon
	// -------------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		daemon = new BiomeDaemon();

		// Start the daemon in the background — don't block session startup
		daemon.start(ctx.cwd).catch((err) => {
			console.error("[biome-lsp] failed to start:", err.message);
			ctx.ui.notify(`Biome daemon failed to start: ${err.message}`, "warning");
		});
	});

	pi.on("session_shutdown", async () => {
		if (daemon) {
			await daemon.stop();
			daemon = null;
		}
	});

	// -------------------------------------------------------------------------
	// Auto-lint: automatically run Biome after edit/write on supported files
	// -------------------------------------------------------------------------

	pi.on("tool_result", async (event, ctx) => {
		// Only intercept edit and write tools
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		if (!daemon?.ready) return; // daemon not up yet

		// Extract file path from the tool input
		let filePath = "";
		if (isToolCallEventType("edit", event)) {
			filePath = event.input.path ?? "";
		} else if (isToolCallEventType("write", event)) {
			filePath = event.input.path ?? "";
		} else {
			const input = event.input as { path?: string };
			filePath = input.path ?? "";
		}

		if (!filePath || !isBiomeFile(filePath)) return;

		// Skip if the tool had an error (don't lint broken edits)
		if (event.isError) return;

		const absPath = resolve(ctx.cwd, filePath);
		if (!existsSync(absPath)) return;

		// Run Biome check on the file
		try {
			const result = await daemon.runCommand("check", [absPath], ctx.cwd);

			if (result.exitCode !== 0) {
				const output = (result.stderr + "\n" + result.stdout).trim();
				if (output) {
					const truncated = truncateHead(output, {
						maxLines: 50,
						maxBytes: 4096,
					});

					const biomeNote = `\n\n--- Biome check found issues in ${filePath} ---\n${truncated.content}`;

					// Append diagnostics to the tool result so the LLM sees them
					return {
						content: [
							...(event.content ?? []),
							{ type: "text" as const, text: biomeNote },
						],
					};
				}
			}
		} catch {
			// Silently skip if Biome fails — don't break the edit/write flow
		}

		// No issues or Biome passed — return undefined to keep original result
	});

	// -------------------------------------------------------------------------
	// Tool: biome_check
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "biome_check",
		label: "Biome Check",
		description:
			"Run Biome check (lint + format + import sorting) on files or directories. " +
			"Returns detailed lint errors, formatting issues, and fix suggestions. " +
			"Use this to validate code quality before committing changes. " +
			"Supports JS, TS, JSX, TSX, JSON, JSONC, CSS, and GraphQL files.",
		promptSnippet: "Run Biome lint+format check on files",
		promptGuidelines: [
			"Use biome_check to validate JS/TS/JSON/CSS code quality with Biome after making edits.",
			"Prefer biome_check over manual lint review when the project uses Biome.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String(), {
				description:
					"File or directory paths to check (relative to cwd or absolute). " +
					"Pass a single file like ['src/index.ts'] or a directory like ['src/'].",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!daemon) {
				throw new Error("Biome daemon not initialized. Restart the session.");
			}

			const resolvedPaths = params.paths.map((p) => resolve(ctx.cwd, p));
			for (const p of resolvedPaths) {
				if (!existsSync(p)) {
					throw new Error(`Path not found: ${p}`);
				}
			}

			const result = await daemon.runCommand("check", resolvedPaths, ctx.cwd);

			if (result.exitCode === 0) {
				return {
					content: [
						{
							type: "text",
							text: "✓ Biome check passed. No issues found.",
						},
					],
					details: { exitCode: 0 },
				};
			}

			let output = "Biome check found issues:\n\n";
			if (result.stderr) output += result.stderr;
			if (result.stdout) output += `\n${result.stdout}`;

			const truncated = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			return {
				content: [{ type: "text", text: truncated.content }],
				details: {
					exitCode: result.exitCode,
					truncated: truncated.truncated,
				},
			};
		},
	});

	// -------------------------------------------------------------------------
	// Tool: biome_lint
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "biome_lint",
		label: "Biome Lint",
		description:
			"Run Biome lint on files or directories. Reports lint errors and warnings " +
			"with detailed fix suggestions. Use for a quick lint-only check without formatting. " +
			"Supports JS, TS, JSX, TSX, JSON, CSS, and GraphQL files.",
		promptSnippet: "Run Biome lint check on files",
		promptGuidelines: [
			"Use biome_lint for a quick lint-only check on JavaScript/TypeScript files.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String(), {
				description: "File or directory paths to lint.",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!daemon) {
				throw new Error("Biome daemon not initialized.");
			}

			const resolvedPaths = params.paths.map((p) => resolve(ctx.cwd, p));
			for (const p of resolvedPaths) {
				if (!existsSync(p)) {
					throw new Error(`Path not found: ${p}`);
				}
			}

			const result = await daemon.runCommand("lint", resolvedPaths, ctx.cwd);

			if (result.exitCode === 0) {
				return {
					content: [
						{
							type: "text",
							text: "✓ Biome lint passed. No issues found.",
						},
					],
					details: { exitCode: 0 },
				};
			}

			let output = "Biome lint found issues:\n\n";
			if (result.stderr) output += result.stderr;
			if (result.stdout) output += `\n${result.stdout}`;

			const truncated = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			return {
				content: [{ type: "text", text: truncated.content }],
				details: {
					exitCode: result.exitCode,
					truncated: truncated.truncated,
				},
			};
		},
	});

	// -------------------------------------------------------------------------
	// Tool: biome_format
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "biome_format",
		label: "Biome Format",
		description:
			"Run Biome format on files or directories. By default runs in dry-run mode " +
			"(reports files that need formatting). Set write=true to apply formatting changes. " +
			"Supports JS, TS, JSX, TSX, JSON, JSONC, CSS, and GraphQL files.",
		promptSnippet: "Run Biome format check or apply formatting",
		promptGuidelines: [
			"Use biome_format to check formatting or apply fixes to JS/TS/JSON/CSS files.",
			"Set write=true on biome_format to apply formatting changes to files.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String(), {
				description: "File or directory paths to format.",
			}),
			write: Type.Optional(
				Type.Boolean({
					description:
						"If true, write the formatted output back to the files. Default: false (dry-run only).",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!daemon) {
				throw new Error("Biome daemon not initialized.");
			}

			const resolvedPaths = params.paths.map((p) => resolve(ctx.cwd, p));
			for (const p of resolvedPaths) {
				if (!existsSync(p)) {
					throw new Error(`Path not found: ${p}`);
				}
			}

			const result = await daemon.runCommand("format", resolvedPaths, ctx.cwd, {
				write: params.write ?? false,
			});

			if (result.exitCode === 0) {
				const msg = params.write
					? "✓ Formatted and wrote all files."
					: "✓ All files are already well-formatted.";
				return {
					content: [{ type: "text", text: msg }],
					details: { exitCode: 0, written: params.write ?? false },
				};
			}

			let output = params.write
				? "Biome format applied:\n\n"
				: "Files needing formatting:\n\n";
			if (result.stderr) output += result.stderr;
			if (result.stdout) output += `\n${result.stdout}`;

			const truncated = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			return {
				content: [{ type: "text", text: truncated.content }],
				details: {
					exitCode: result.exitCode,
					truncated: truncated.truncated,
				},
			};
		},
	});

	// -------------------------------------------------------------------------
	// Tool: biome_status
	// -------------------------------------------------------------------------

	pi.registerTool({
		name: "biome_status",
		label: "Biome Status",
		description:
			"Check if the Biome daemon is running. " +
			"Use this to diagnose Biome integration issues.",
		parameters: Type.Object({}),
		async execute() {
			const ready = daemon?.ready ?? false;
			return {
				content: [
					{
						type: "text",
						text: ready
							? "✓ Biome daemon is running and ready for requests."
							: "✗ Biome daemon is not running. Use /biome start to start it.",
					},
				],
				details: { ready },
			};
		},
	});

	// -------------------------------------------------------------------------
	// Command: /biome
	// -------------------------------------------------------------------------

	pi.registerCommand("biome", {
		description: "Manage the Biome daemon (start, stop, status)",
		async handler(args, ctx) {
			const subcommand = (args ?? "status").trim().toLowerCase();
			const ready = daemon?.ready ?? false;

			if (subcommand === "start") {
				if (ready) {
					ctx.ui.notify("Biome daemon is already running", "info");
					return;
				}
				try {
					await daemon?.start(ctx.cwd);
					ctx.ui.notify("Biome daemon started ✓", "info");
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`Failed to start: ${msg}`, "error");
				}
				return;
			}

			if (subcommand === "stop") {
				if (!ready) {
					ctx.ui.notify("Biome daemon is not running", "info");
					return;
				}
				await daemon?.stop();
				ctx.ui.notify("Biome daemon stopped", "info");
				return;
			}

			// status (default)
			ctx.ui.notify(
				ready
					? "Biome daemon: ✓ running"
					: "Biome daemon: ✗ not running (use /biome start)",
				"info",
			);
		},
		getArgumentCompletions(prefix: string) {
			return ["start", "stop", "status"]
				.filter((o) => o.startsWith(prefix))
				.map((o) => ({ value: o, label: o }));
		},
	});

	// -------------------------------------------------------------------------
	// Footer status indicator
	// -------------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		const update = () => {
			ctx.ui.setStatus("biome", daemon?.ready ? "biome ✓" : undefined);
		};

		// Initial + periodic update
		update();
		const interval = setInterval(update, 10_000);

		// Cleanup on shutdown
		pi.on("session_shutdown", () => {
			clearInterval(interval);
		});
	});
}

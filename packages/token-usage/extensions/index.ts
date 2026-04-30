/**
 * Token Usage Extension
 *
 * Tracks LLM token consumption across the current session and the entire project.
 * Uses exact API-reported usage from assistant messages when available,
 * falling back to character-based estimation for local models that don't report usage.
 *
 * Features:
 *   - Scans all past session files on startup (auto-detects historical data)
 *   - Updates in real-time as new messages arrive
 *   - Status bar: "📊 12.5K · 🏠 45.2K" (session / project total)
 *
 * Commands:
 *   /tokens         Show detailed token breakdown in a custom UI panel
 *   /tokens-refresh Force re-scan of all project session files
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, matchesKey, Text } from "@mariozechner/pi-tui";

// ── Types ─────────────────────────────────────────────────────

interface TokenStats {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

interface SessionUsage {
	path: string;
	name: string;
	stats: TokenStats;
}

// ── Constants ─────────────────────────────────────────────────

const STATUS_KEY = "token-usage";
// Rough character-to-token ratio for English + code text
const CHARS_PER_TOKEN = 4;
const SESSION_DIR = join(homedir(), ".pi", "agent", "sessions");

// ── Token estimation helpers ──────────────────────────────────

/** Estimate tokens from a text string using character-length heuristic */
function estimateTokens(text: string): number {
	if (!text || text.length === 0) return 0;
	return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/**
 * Extract text from a content array (handles both string and array formats).
 * Returns concatenated text for estimation purposes.
 */
function extractContentText(content: unknown): string {
	if (typeof content === "string") return content;

	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") {
			parts.push(b.text);
		} else if (b.type === "thinking" && typeof b.thinking === "string") {
			parts.push(b.thinking);
		} else if (b.type === "toolCall" && b.arguments) {
			parts.push(JSON.stringify(b.arguments));
		}
	}
	return parts.join(" ");
}

/**
 * Estimate token usage from an agent message object.
 * Uses API-reported usage when available (non-zero), otherwise estimates.
 */
function estimateMessageTokens(message: Record<string, unknown>): {
	input: number;
	output: number;
} {
	const usage = message.usage as Record<string, number> | undefined;

	// Use API-reported usage if available and non-zero
	if (usage && usage.totalTokens > 0) {
		return {
			input: usage.input || 0,
			output: usage.output || 0,
		};
	}

	// Fallback: estimate from content
	const role = message.role as string;
	const content = message.content;

	if (role === "assistant") {
		// Estimate output from assistant content
		const text = extractContentText(content);
		return { input: 0, output: estimateTokens(text) };
	}

	if (role === "user") {
		// Estimate input from user content
		const text =
			typeof content === "string" ? content : extractContentText(content);
		return { input: estimateTokens(text), output: 0 };
	}

	return { input: 0, output: 0 };
}

// ── Session file scanner ──────────────────────────────────────

/** Parse a single session JSONL file and extract token stats */
function scanSessionFile(filePath: string): TokenStats {
	const stats: TokenStats = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

	try {
		const raw = readFileSync(filePath, "utf-8");
		const lines = raw.trim().split("\n");

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type !== "message") continue;

				const msg = entry.message;
				if (!msg?.role) continue;

				const est = estimateMessageTokens(msg);
				stats.inputTokens += est.input;
				stats.outputTokens += est.output;
			} catch {
				// Skip malformed lines
			}
		}
	} catch {
		// File unreadable — return zeros
	}

	stats.totalTokens = stats.inputTokens + stats.outputTokens;
	return stats;
}

/** Scan all session files for a project directory */
function scanProjectSessions(projectCwd: string): SessionUsage[] {
	const dirName = `--${projectCwd.replace(/[/\\:]/g, "-")}--`;
	const dirPath = join(SESSION_DIR, dirName);

	if (!existsSync(dirPath)) return [];

	const results: SessionUsage[] = [];

	try {
		const entries = readdirSync(dirPath);
		for (const entry of entries) {
			if (!entry.endsWith(".jsonl")) continue;
			const filePath = join(dirPath, entry);
			const stats = scanSessionFile(filePath);
			results.push({
				path: filePath,
				name: entry.replace(".jsonl", "").slice(0, 30),
				stats,
			});
		}
	} catch {
		// Directory unreadable
	}

	return results;
}

// ── Formatting ────────────────────────────────────────────────

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return n.toString();
}

// ── Extension ─────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Current session stats (includes historical entries from before extension load)
	let sessionStats: TokenStats = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
	};
	// Project-wide stats (all sessions)
	let projectStats: TokenStats = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
	};
	// Per-session breakdown (for detailed view)
	let sessionUsages: SessionUsage[] = [];
	// Whether display is enabled
	let displayEnabled = true;

	/** Recalculate project totals from per-session data */
	function recalcProjectStats() {
		projectStats = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
		for (const s of sessionUsages) {
			projectStats.inputTokens += s.stats.inputTokens;
			projectStats.outputTokens += s.stats.outputTokens;
		}
		projectStats.totalTokens =
			projectStats.inputTokens + projectStats.outputTokens;
	}

	/** Scan current session entries from the SessionManager */
	function scanCurrentSession(ctx: {
		sessionManager: { getEntries(): unknown[] };
	}): TokenStats {
		const stats: TokenStats = {
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
		};

		try {
			const entries = ctx.sessionManager.getEntries();
			for (const entry of entries as Array<Record<string, unknown>>) {
				if (entry.type !== "message") continue;
				const msg = entry.message as Record<string, unknown> | undefined;
				if (!msg?.role) continue;

				const est = estimateMessageTokens(msg);
				stats.inputTokens += est.input;
				stats.outputTokens += est.output;
			}
		} catch {
			// Session manager unavailable
		}

		stats.totalTokens = stats.inputTokens + stats.outputTokens;
		return stats;
	}

	/** Full refresh: scan current session + all project sessions */
	function fullRefresh(ctx: {
		cwd: string;
		sessionManager: { getEntries(): unknown[] };
		ui: {
			setStatus: (k: string, t: string) => void;
			theme: { fg: (n: string, t: string) => string };
		};
	}) {
		// Scan current session
		sessionStats = scanCurrentSession(ctx);

		// Scan all project sessions
		sessionUsages = scanProjectSessions(ctx.cwd);
		recalcProjectStats();

		// If current session file is among project sessions, don't double-count
		// (current session is already included in project scan)

		updateStatusBar(ctx);
	}

	/** Update the status bar display */
	function updateStatusBar(ctx: {
		ui: {
			setStatus: (k: string, t: string) => void;
			theme: { fg: (n: string, t: string) => string };
		};
	}) {
		if (!displayEnabled) {
			ctx.ui.setStatus(STATUS_KEY, "");
			return;
		}

		const theme = ctx.ui.theme;
		const sTotal = formatTokens(sessionStats.totalTokens);
		const pTotal = formatTokens(projectStats.totalTokens);

		const sessionStr = theme.fg("accent", `📊 ${sTotal}`);
		const projectStr = theme.fg("dim", `🏠 ${pTotal}`);
		ctx.ui.setStatus(STATUS_KEY, `${sessionStr} ${projectStr}`);
	}

	/** Add tokens from a new assistant message to the running session totals */
	function addMessageUsage(message: Record<string, unknown>) {
		const est = estimateMessageTokens(message);
		sessionStats.inputTokens += est.input;
		sessionStats.outputTokens += est.output;
		sessionStats.totalTokens =
			sessionStats.inputTokens + sessionStats.outputTokens;

		// Also add to the current session file's entry in project stats
		// We'll just recalc project totals on each message for simplicity
		// (or defer to a periodic refresh)
		projectStats.inputTokens += est.input;
		projectStats.outputTokens += est.output;
		projectStats.totalTokens =
			projectStats.inputTokens + projectStats.outputTokens;
	}

	// ── Event Handlers ─────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		fullRefresh(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message?.role !== "assistant") return;

		addMessageUsage(event.message as unknown as Record<string, unknown>);
		updateStatusBar(ctx);
	});

	// ── Commands ───────────────────────────────────────────────

	pi.registerCommand("tokens", {
		description: "Show detailed token usage breakdown",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			// Refresh to get latest data
			fullRefresh(ctx);

			const lines: string[] = [
				"📊 Token Usage Report",
				"══════════════════════════════════",
				"",
				"Current Session:",
				`  Input:   ${sessionStats.inputTokens.toLocaleString()} tokens`,
				`  Output:  ${sessionStats.outputTokens.toLocaleString()} tokens`,
				`  Total:   ${sessionStats.totalTokens.toLocaleString()} tokens`,
				"",
				"Project Total (all sessions):",
				`  Input:   ${projectStats.inputTokens.toLocaleString()} tokens`,
				`  Output:  ${projectStats.outputTokens.toLocaleString()} tokens`,
				`  Total:   ${projectStats.totalTokens.toLocaleString()} tokens`,
				"",
				`  Sessions scanned: ${sessionUsages.length}`,
				"",
				"Per-Session Breakdown:",
			];

			// Sort sessions by total tokens descending
			const sorted = [...sessionUsages].sort(
				(a, b) => b.stats.totalTokens - a.stats.totalTokens,
			);
			for (const s of sorted.slice(0, 15)) {
				const name = s.name.replace(
					/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/,
					"",
				);
				lines.push(
					`  ${s.stats.totalTokens.toLocaleString().padStart(8)} tk — ${name}`,
				);
			}
			if (sorted.length > 15) {
				lines.push(`  ... and ${sorted.length - 15} more sessions`);
			}

			const report = lines.join("\n");

			// Show in a custom UI panel
			await ctx.ui.custom((_tui, theme, _kb, done) => {
				const container = new Container();
				const reportLines = report.split("\n");
				for (let i = 0; i < reportLines.length; i++) {
					const line = reportLines[i]!;
					const isHeading = i === 0 || line.startsWith("════") || line === "";
					const color = isHeading ? "accent" : "dim";
					container.addChild(new Text(theme.fg(color, line), 1, 0));
				}
				container.addChild(
					new Text(theme.fg("dim", "\nPress Enter or Esc to close"), 1, 0),
				);

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
							done(undefined);
						}
					},
				};
			});
		},
	});

	pi.registerCommand("tokens-refresh", {
		description: "Force re-scan of all project session files",
		handler: async (_args, ctx) => {
			fullRefresh(ctx);
			const total = formatTokens(projectStats.totalTokens);
			ctx.ui.notify(
				`Token usage refreshed: ${total} project total across ${sessionUsages.length} sessions`,
				"success",
			);
		},
	});

	// ── Toggle command (shared with /tps pattern) ──────────────
	pi.registerCommand("tokens-toggle", {
		description: "Toggle token usage status display on/off",
		handler: async (_args, ctx) => {
			displayEnabled = !displayEnabled;
			if (!displayEnabled) {
				ctx.ui.setStatus(STATUS_KEY, "");
				ctx.ui.notify("Token usage display: OFF", "info");
			} else {
				updateStatusBar(ctx);
				ctx.ui.notify("Token usage display: ON", "info");
			}
		},
	});

	// ── Cleanup ────────────────────────────────────────────────

	pi.on("session_shutdown", async () => {
		sessionStats = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
		projectStats = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
		sessionUsages = [];
	});
}

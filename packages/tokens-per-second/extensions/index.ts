/**
 * Tokens-Per-Second Extension
 *
 * Displays real-time LLM token generation speed in the pi status bar.
 * Counts text_delta and thinking_delta events during assistant message streaming
 * and calculates rolling tokens-per-second.
 *
 * Usage:
 *   - Auto-loaded from .pi/extensions/tokens-per-second/
 *   - Or: pi -e .pi/extensions/tokens-per-second/index.ts
 *
 * Commands:
 *   /tps          Toggle the TPS status display on/off
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "tokens-per-sec";
const ROLLING_WINDOW_MS = 2000;
const UPDATE_EVERY_N_TOKENS = 5;

export default function (pi: ExtensionAPI) {
	// Per-message streaming state
	let tokenCount = 0;
	let streamStartTime = 0;
	let lastTokenTime = 0;
	let isStreaming = false;

	// Rolling window for recent TPS calculation
	const tokenTimestamps: number[] = [];

	// Whether the status display is enabled
	let displayEnabled = true;

	function clearStatus(ctx: {
		ui: { setStatus: (key: string, text: string) => void };
	}) {
		ctx.ui.setStatus(STATUS_KEY, "");
	}

	function getRollingTps(): number | null {
		// Remove timestamps outside the rolling window
		const cutoff = Date.now() - ROLLING_WINDOW_MS;
		while (tokenTimestamps.length > 0 && tokenTimestamps[0]! < cutoff) {
			tokenTimestamps.shift();
		}

		if (tokenTimestamps.length < 2) return null;

		const windowElapsed =
			tokenTimestamps[tokenTimestamps.length - 1]! - tokenTimestamps[0]!;
		if (windowElapsed <= 0) return null;

		return tokenTimestamps.length / (windowElapsed / 1000);
	}

	function updateStatus(ctx: {
		ui: {
			setStatus: (k: string, t: string) => void;
			theme: { fg: (n: string, t: string) => string };
		};
	}) {
		if (!displayEnabled) return;

		const theme = ctx.ui.theme;
		const icon = theme.fg("accent", "⚡");
		const tkLabel = theme.fg("dim", `${tokenCount}tk`);

		const rollingTps = getRollingTps();
		const rateStr =
			rollingTps !== null
				? theme.fg("success", `${rollingTps.toFixed(0)}t/s`)
				: theme.fg("dim", "—t/s");

		ctx.ui.setStatus(STATUS_KEY, `${icon} ${tkLabel} ${rateStr}`);
	}

	function startStreaming() {
		tokenCount = 0;
		streamStartTime = Date.now();
		lastTokenTime = 0;
		tokenTimestamps.length = 0;
		isStreaming = true;
	}

	function stopStreaming() {
		isStreaming = false;
	}

	function recordToken(ctx?: {
		ui: {
			setStatus: (k: string, t: string) => void;
			theme: { fg: (n: string, t: string) => string };
		};
	}) {
		const now = Date.now();
		tokenCount++;
		lastTokenTime = now;
		if (!streamStartTime) streamStartTime = now;
		tokenTimestamps.push(now);

		// Throttle status updates
		if (ctx && tokenCount % UPDATE_EVERY_N_TOKENS === 0) {
			updateStatus(ctx);
		}
	}

	// ── Event handlers ──────────────────────────────────────────

	pi.on("message_start", async (event) => {
		if (event.message?.role === "assistant") {
			startStreaming();
		}
	});

	pi.on("message_update", async (event, ctx) => {
		const ev = event.assistantMessageEvent;
		if (ev.type === "text_delta" || ev.type === "thinking_delta") {
			recordToken(ctx);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message?.role !== "assistant" || !isStreaming) return;
		stopStreaming();

		if (tokenCount === 0) return;
		if (!displayEnabled) return;

		const elapsed = (lastTokenTime || Date.now()) - streamStartTime;
		const elapsedSec = (elapsed / 1000).toFixed(1);
		const finalTps =
			elapsed > 0 ? (tokenCount / (elapsed / 1000)).toFixed(1) : "0";

		const theme = ctx.ui.theme;
		const icon = theme.fg("accent", "⚡");
		const summary = `${tokenCount} tokens in ${elapsedSec}s`;
		const rate = theme.fg("success", `(${finalTps} t/s)`);
		ctx.ui.setStatus(STATUS_KEY, `${icon} ${summary} ${rate}`);

		// Clear after 15 seconds
		setTimeout(() => {
			ctx.ui.setStatus(STATUS_KEY, "");
		}, 15000);
	});

	pi.on("turn_end", async (_event, _ctx) => {
		// If we have stale state (e.g., message_end didn't fire), clean up
		if (isStreaming) {
			stopStreaming();
		}
		// Clear any leftover status on next turn
	});

	// ── Command: toggle display ─────────────────────────────────

	pi.registerCommand("tps", {
		description: "Toggle tokens-per-second status display on/off",
		handler: async (_args, ctx) => {
			displayEnabled = !displayEnabled;
			if (!displayEnabled) {
				clearStatus(ctx);
				ctx.ui.notify("TPS display: OFF", "info");
			} else {
				ctx.ui.notify("TPS display: ON", "info");
			}
		},
	});

	// Clean up on session shutdown
	pi.on("session_shutdown", async () => {
		isStreaming = false;
		tokenTimestamps.length = 0;
	});
}

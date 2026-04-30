/**
 * Session Usage Tracker Extension
 *
 * Tracks session time with two timer modes:
 *   turn    - Full prompt cycle from before_agent_start to agent_end.
 *             Includes user input, all turns, tool calls, and streaming.
 *             Paused between prompts.
 *   session - Wall-clock time from session start to shutdown.
 *             Always counting while the session is active.
 *
 * State is persisted using appendEntry, so accumulated time, turns, and tool
 * calls carry over when you resume or fork a session.
 *
 * Commands:
 *   /session-usage                  - Show timer and stats
 *   /session-usage reset            - Reset all counters
 *   /session-usage total            - Show time breakdown for all modes
 *   /session-usage mode <turn|session>  - Switch timer mode
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const CUSTOM_TYPE = "session-usage";

type TimerMode = "turn" | "session";

// Emoji/unicode constants to avoid encoding issues in source
const WORK_ICON = "\u23F1"; // stopwatch
const IDLE_ICON = "\u23F8"; // pause
const SPEECH = "\uD83D\uDCE8"; // inbox tray / prompt icon
const GLOBE = "\uD83D\uDD04"; // arrows / turns
const WRENCH = "\uD83D\uDD27"; // wrench / tool calls
const CHART = "\uD83D\uDCCA"; // bar chart
const CALENDAR = "\uD83D\uDCC5"; // calendar
const GREEN_DOT = "\u25CF"; // filled circle
const HOLLOW_DOT = "\u25CB"; // hollow circle

interface UsageState {
	counters: { turn: number; session: number };
	turns: number;
	toolCalls: number;
	prompts: number;
	trackingSince: string;
	timerMode: TimerMode;
}

function formatDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000) % 60;
	const minutes = Math.floor(ms / 60000) % 60;
	const hours = Math.floor(ms / 3600000);

	if (hours > 0) {
		return `${hours}h ${minutes}m ${seconds}s`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}

function formatDurationShort(ms: number): string {
	const seconds = Math.floor(ms / 1000) % 60;
	const minutes = Math.floor(ms / 60000) % 60;
	const hours = Math.floor(ms / 3600000);

	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	}
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function makeDefaultState(): UsageState {
	return {
		counters: { turn: 0, session: 0 },
		turns: 0,
		toolCalls: 0,
		prompts: 0,
		trackingSince: new Date().toISOString(),
		timerMode: "turn",
	};
}

function restoreState(entries: any[]): UsageState {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (
			entry.type === "custom" &&
			entry.customType === CUSTOM_TYPE &&
			entry.data
		) {
			const data = entry.data;
			if (data.counters && data.timerMode) {
				// v2: only turn + session counters (current format)
				return {
					counters: {
						turn: data.counters.turn ?? 0,
						session: data.counters.session ?? 0,
					},
					turns: data.turns ?? 0,
					toolCalls: data.toolCalls ?? 0,
					prompts: data.prompts ?? 0,
					trackingSince: data.trackingSince ?? new Date().toISOString(),
					timerMode: data.timerMode === "session" ? "session" : "turn",
				};
			}
			// v1 migration (had 3 counters: turn/prompt/session + old format with elapsedMs)
			if (
				data.counters &&
				(data.counters.prompt !== undefined || data.counters.turn !== undefined)
			) {
				return {
					counters: {
						turn: (data.counters.prompt ?? 0) + (data.counters.turn ?? 0),
						session: data.counters.session ?? 0,
					},
					turns: data.turns ?? 0,
					toolCalls: data.toolCalls ?? 0,
					prompts: data.prompts ?? 0,
					trackingSince: data.trackingSince ?? new Date().toISOString(),
					timerMode: "turn",
				};
			}
			// v0 migration (had single elapsedMs field)
			return {
				counters: {
					turn: data.elapsedMs ?? 0,
					session: 0,
				},
				turns: data.turns ?? 0,
				toolCalls: data.toolCalls ?? 0,
				prompts: data.prompts ?? 0,
				trackingSince: data.trackingSince ?? new Date().toISOString(),
				timerMode: "turn",
			};
		}
	}
	return makeDefaultState();
}

export default function (pi: ExtensionAPI) {
	let state: UsageState = makeDefaultState();

	let turnStartTime: number | null = null;
	let sessionStartTime: number | null = null;
	let currentTurnToolCalls = 0;
	let timerInterval: ReturnType<typeof setInterval> | null = null;
	let ctxRef: any = null;

	function getCurrentElapsed(): number {
		const now = Date.now();
		switch (state.timerMode) {
			case "turn":
				return state.counters.turn + (turnStartTime ? now - turnStartTime : 0);
			case "session":
				return (
					state.counters.session +
					(sessionStartTime ? now - sessionStartTime : 0)
				);
		}
	}

	function persistState() {
		pi.appendEntry(CUSTOM_TYPE, {
			counters: state.counters,
			turns: state.turns,
			toolCalls: state.toolCalls,
			prompts: state.prompts,
			trackingSince: state.trackingSince,
			timerMode: state.timerMode,
		} satisfies UsageState);
	}

	function isActive(): boolean {
		switch (state.timerMode) {
			case "turn":
				return turnStartTime !== null;
			case "session":
				return sessionStartTime !== null;
		}
	}

	function updateWidget(ctx: any) {
		const elapsed = getCurrentElapsed();
		const theme = ctx.ui.theme;
		const active = isActive();

		const icon = active
			? theme.fg("accent", WORK_ICON)
			: theme.fg("dim", IDLE_ICON);
		const color = active ? "accent" : "dim";
		const duration = theme.fg(color, ` ${formatDurationShort(elapsed)}`);

		let statusTag = "";
		if (state.timerMode === "session") {
			statusTag = theme.fg("success", ` ${GREEN_DOT} session`);
		} else if (active) {
			statusTag = theme.fg("success", ` ${GREEN_DOT} turn`);
		} else {
			statusTag = theme.fg("dim", " idle");
		}

		const modeLabel = theme.fg("dim", ` [${state.timerMode}]`);

		const statsTag = theme.fg(
			"dim",
			` | ${SPEECH} ${state.prompts}  ${GLOBE} ${state.turns}  ${WRENCH} ${state.toolCalls}`,
		);

		ctx.ui.setWidget("session-usage", [
			icon + duration + statusTag + modeLabel + statsTag,
		]);
	}

	function startTicker(ctx: any) {
		stopTicker();
		timerInterval = setInterval(() => {
			updateWidget(ctx);
		}, 1000);
	}

	function stopTicker() {
		if (timerInterval) {
			clearInterval(timerInterval);
			timerInterval = null;
		}
	}

	// -- Events --

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		const entries = ctx.sessionManager.getEntries();
		state = restoreState(entries);

		turnStartTime = null;
		sessionStartTime = Date.now();
		currentTurnToolCalls = 0;

		updateWidget(ctx);
		startTicker(ctx);
	});

	pi.on("session_shutdown", async () => {
		const now = Date.now();
		if (turnStartTime !== null) {
			state.counters.turn += now - turnStartTime;
			turnStartTime = null;
		}
		if (sessionStartTime !== null) {
			state.counters.session += now - sessionStartTime;
			sessionStartTime = null;
		}
		persistState();
		stopTicker();
		ctxRef?.ui?.setWidget("session-usage", undefined);
	});

	// -- Prompt + turn tracking --

	pi.on("before_agent_start", async () => {
		state.prompts++;
		if (state.timerMode === "turn") {
			turnStartTime = Date.now();
			updateWidget(ctxRef);
		}
	});

	pi.on("agent_end", async () => {
		if (state.timerMode === "turn" && turnStartTime !== null) {
			state.counters.turn += Date.now() - turnStartTime;
			turnStartTime = null;
			persistState();
			updateWidget(ctxRef);
		}
	});

	// Track inner turns + tools separately (stats only, not timer)

	pi.on("turn_start", async () => {
		currentTurnToolCalls = 0;
	});

	pi.on("turn_end", async () => {
		state.turns++;
		state.toolCalls += currentTurnToolCalls;
		currentTurnToolCalls = 0;
		persistState();
	});

	pi.on("tool_call", async () => {
		currentTurnToolCalls++;
	});

	// -- /session-usage command --

	pi.registerCommand("session-usage", {
		description:
			"Show session timer and stats (/session-usage [reset|total|mode <turn|session>])",
		handler: async (args, ctx) => {
			const cmd = args.trim().toLowerCase();

			if (cmd.startsWith("mode ")) {
				const raw = cmd.slice(5).trim();
				if (raw !== "turn" && raw !== "session") {
					ctx.ui.notify(`Invalid mode: ${raw}. Use: turn or session`, "error");
					return;
				}
				const newMode = raw as TimerMode;

				// Save any active timer for current mode before switching
				const now = Date.now();
				if (turnStartTime !== null) {
					state.counters.turn += now - turnStartTime;
					turnStartTime = null;
				}

				state.timerMode = newMode;
				persistState();
				ctx.ui.notify(`Timer mode switched to: ${newMode}`, "info");
				updateWidget(ctx);
				return;
			}

			if (cmd === "reset") {
				state = makeDefaultState();
				persistState();
				ctx.ui.notify("Usage counters reset!", "info");
				updateWidget(ctx);
				return;
			}

			if (cmd === "total") {
				const now = Date.now();
				const currentSessionMs = sessionStartTime ? now - sessionStartTime : 0;
				const sessionMs = state.counters.session + currentSessionMs;
				const turnMs =
					state.counters.turn + (turnStartTime ? now - turnStartTime : 0);
				ctx.ui.notify(
					[
						`${CHART} Time Breakdown`,
						"",
						`  turn:    ${formatDuration(turnMs)} (per-prompt cycle)`,
						`  session: ${formatDuration(sessionMs)} (wall-clock total)`,
						"",
						`  Active mode: ${state.timerMode}`,
						`  Tracking since: ${new Date(state.trackingSince).toLocaleString()}`,
					].join("\n"),
					"info",
				);
				return;
			}

			const elapsed = getCurrentElapsed();
			const theme = ctx.ui.theme;

			let statusLine = "";
			if (state.timerMode === "session") {
				statusLine = theme.fg("success", `${GREEN_DOT} Session active`);
			} else {
				const active = isActive();
				statusLine = active
					? theme.fg("success", `${GREEN_DOT} turn active`)
					: theme.fg("dim", `${HOLLOW_DOT} Idle`);
			}

			ctx.ui.notify(
				[
					theme.fg(
						"accent",
						`${CHART} Session Timer (${state.timerMode} mode)`,
					),
					"",
					`  ${WORK_ICON}   Work time:   ${theme.fg("success", formatDuration(elapsed))}`,
					`  ${SPEECH}   Prompts:     ${theme.fg("dim", String(state.prompts))}`,
					`  ${GLOBE}   Turns:       ${theme.fg("dim", String(state.turns))}`,
					`  ${WRENCH}   Tool calls:  ${theme.fg("dim", String(state.toolCalls))}`,
					`  ${statusLine}`,
					`  ${CALENDAR}   Since:       ${theme.fg("dim", new Date(state.trackingSince).toLocaleString())}`,
				].join("\n"),
				"info",
			);
		},
	});
}

/**
 * Auto Session Name Extension
 *
 * Automatically gives sessions descriptive titles instead of using
 * the first user prompt. When you run /resume, you'll see a meaningful
 * title like "Refactor auth module" instead of a raw prompt.
 *
 * How it works:
 * 1. On the first turn of a new session, injects a hidden instruction
 *    asking the LLM to call the `name_session` tool with a concise title.
 * 2. The LLM calls `name_session` before responding, setting the title.
 * 3. Once named, the instruction is not injected again.
 *
 * You can also manually set a name with: /rename-session <title>
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
	let needsNaming = true;

	// Reset naming state on session start
	pi.on("session_start", async (_event, _ctx) => {
		const existingName = pi.getSessionName();
		if (existingName) {
			// Session already has a name (e.g. resumed or manually set)
			needsNaming = false;
		} else {
			needsNaming = true;
		}
	});

	// On first turn without a name, instruct the LLM to name the session
	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!needsNaming) return;

		return {
			message: {
				customType: "auto-name-session",
				content:
					"Before answering, call the name_session tool with a concise, descriptive title (3-8 words) that captures the user's intent for this conversation. Use Title Case. Examples: 'Fix CSS Layout Bug', 'Add User Authentication', 'Refactor Database Layer'. Do NOT use the user's exact prompt as the title—summarize it instead.",
				display: false, // Hidden from user, but sent to LLM
			},
		};
	});

	// The tool the LLM calls to set the session name
	pi.registerTool({
		name: "name_session",
		label: "Name Session",
		description:
			"Set a descriptive title for the current session. This title appears in the session list (/resume) instead of the first user message. Call this once at the start of a conversation.",
		promptSnippet: "Set a concise descriptive title for the session",
		promptGuidelines: [
			"Use name_session exactly once per conversation to set a descriptive session title (3-8 words, Title Case). Summarize the user's intent, don't copy their prompt verbatim.",
		],
		parameters: Type.Object({
			title: Type.String({
				description:
					"A concise, descriptive title for the session in Title Case (3-8 words). Example: 'Fix CSS Layout Bug'",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const title = params.title.trim();

			if (!title) {
				throw new Error("Title cannot be empty");
			}

			pi.setSessionName(title);
			needsNaming = false;

			return {
				content: [
					{
						type: "text" as const,
						text: `Session titled: "${title}"`,
					},
				],
				details: { title },
			};
		},
	});

	// Manual command to rename the session
	pi.registerCommand("rename-session", {
		description:
			"Rename the current session (usage: /rename-session <new title>)",
		handler: async (args, ctx) => {
			const title = args.trim();

			if (title) {
				pi.setSessionName(title);
				needsNaming = false;
				ctx.ui.notify(`Session renamed: "${title}"`, "info");
			} else {
				const current = pi.getSessionName();
				if (current) {
					ctx.ui.notify(`Current session name: "${current}"`, "info");
				} else {
					ctx.ui.notify("No session name set yet", "info");
				}
			}
		},
	});
}

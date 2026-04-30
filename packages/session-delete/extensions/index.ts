/**
 * Session Delete Extension
 *
 * Provides /session-delete command to interactively delete sessions
 * for the current project with a nice TUI selector.
 *
 * Usage:
 *   /session-delete              -- Open session picker with all project sessions
 *   /session-delete <filter>     -- Filter sessions by name before showing picker
 */

import { execFileSync } from "node:child_process";
import { unlink } from "node:fs/promises";
import { basename } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
} from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("session-delete", {
		description:
			"Delete a session for this project (usage: /session-delete [filter])",
		handler: async (args, ctx) => {
			// List sessions for current project
			const sessions = await SessionManager.list(ctx.cwd);
			if (sessions.length === 0) {
				ctx.ui.notify("No sessions found for this project", "warning");
				return;
			}

			let candidates = sessions;

			// Filter by args if provided
			const filter = args.trim().toLowerCase();
			if (filter) {
				candidates = sessions.filter((s) => {
					const hay = `${s.name ?? ""} ${s.firstMessage ?? ""}`.toLowerCase();
					return hay.includes(filter);
				});
				if (candidates.length === 0) {
					ctx.ui.notify(`No sessions match "${filter}"`, "warning");
					return;
				}
			}

			const currentFile = ctx.sessionManager.getSessionFile();

			// If exact single match with filter, skip picker
			if (filter && candidates.length === 1) {
				const target = candidates[0];
				const isCurrent =
					currentFile !== undefined && currentFile === target.path;
				await confirmAndDelete(ctx, target, isCurrent);
				return;
			}

			// Build items for SelectList
			const items: SelectItem[] = candidates.map((s) => {
				const isCurrent = currentFile !== undefined && currentFile === s.path;
				return {
					value: s.path,
					label: formatLabel(s, isCurrent),
					description: formatDescription(s),
				};
			});

			// Show custom TUI selector via overlay
			const selectedPath = await ctx.ui.custom<string | null>(
				(tui, theme, _keybindings, done) => {
					const container = new Container(0, 0, "100%", "100%");
					container.addChild(
						new Text(
							theme.fg(
								"accent",
								theme.bold(
									"Delete Session — ↑↓ navigate · Enter select · Esc cancel",
								),
							),
							1,
							0,
						),
					);

					const listHeight = Math.min(items.length, Math.max(8, items.length));
					const selectList = new SelectList(items, listHeight, {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					});

					selectList.onSelect = (item) => done(item.value);
					selectList.onCancel = () => done(null);
					container.addChild(selectList);

					// Help text
					container.addChild(
						new Text(
							theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"),
							1,
							0,
						),
					);

					return {
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => {
							selectList.handleInput(data);
							tui.requestRender();
						},
					};
				},
				{ overlay: true },
			);

			if (!selectedPath) return;

			const target = candidates.find((s) => s.path === selectedPath);
			if (!target) return;

			const isCurrent =
				currentFile !== undefined && currentFile === target.path;
			await confirmAndDelete(ctx, target, isCurrent);
		},
	});
}

async function confirmAndDelete(
	ctx: any,
	target: any,
	isCurrent: boolean,
): Promise<void> {
	const name = target.name ?? basename(target.path);
	const ok = await ctx.ui.confirm(
		"Delete Session?",
		`${name}${isCurrent ? "\n\n⚠️ This is the ACTIVE session!" : ""}\n\n${target.messageCount} messages · Created ${new Date(target.created).toLocaleDateString()}\n\nAre you sure you want to delete it?`,
	);
	if (!ok) return;

	try {
		await safeDelete(target.path);
		ctx.ui.notify(`Deleted: ${name}`, "success");

		if (isCurrent) {
			ctx.ui.notify("Starting new session...", "info");
			await ctx.newSession();
		}
	} catch (e: any) {
		ctx.ui.notify(`Failed to delete: ${e.message}`, "error");
	}
}

function formatLabel(s: any, isCurrent: boolean): string {
	const name = s.name ?? s.firstMessage?.slice(0, 48) ?? "Untitled";
	return isCurrent ? `● ${name}` : `  ${name}`;
}

function formatDescription(s: any): string {
	const date = new Date(s.modified).toLocaleDateString("id-ID", {
		month: "short",
		day: "numeric",
	});
	const time = new Date(s.modified).toLocaleTimeString("id-ID", {
		hour: "2-digit",
		minute: "2-digit",
	});
	return `${s.messageCount} messages · ${date} ${time}`;
}

function hasTrashCli(): boolean {
	try {
		execFileSync("trash", ["--version"], { stdio: "ignore", timeout: 2000 });
		return true;
	} catch {
		return false;
	}
}

async function safeDelete(filePath: string): Promise<void> {
	if (hasTrashCli()) {
		try {
			execFileSync("trash", [filePath], {
				stdio: "ignore",
				timeout: 5000,
			});
			return;
		} catch {
			// fall through to permanent delete
		}
	}
	await unlink(filePath);
}

/**
 * Compact Tool Preview — slimmer, single-line rendering for all built-in tools.
 *
 * Collapsed state:
 * - one visible line per tool call
 * - no default padded box shell
 * - details only show when expanded
 *
 * Delegates all execution to original tools — only rendering changes.
 */

import { homedir } from "node:os";
import type {
	BashToolDetails,
	EditToolDetails,
	ExtensionAPI,
	FindToolDetails,
	GrepToolDetails,
	LsToolDetails,
	ReadToolDetails,
	WriteToolDetails,
} from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";

const HOME = homedir();
const tilde = (p: string) =>
	p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
const clip = (s: string, n = 72) =>
	s.length <= n ? s : `${s.slice(0, n - 1)}…`;
const shortPath = (p: string, n = 52) => clip(tilde(p), n);
const nel = (s: string) => s.split("\n").filter((l) => l.trim()).length;
const meta = (...parts: Array<string | false | null | undefined>) =>
	parts.filter(Boolean).join(" · ");

type CompactTheme = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
};

const dimLines = (text: string, max: number, theme: CompactTheme) => {
	const ls = text.split("\n");
	const shown = ls.slice(0, max);
	let t = shown.map((l) => theme.fg("dim", l)).join("\n");
	if (ls.length > max) {
		t += `\n${theme.fg("muted", `…${ls.length - max} more`)}`;
	}
	return t;
};

const empty = () => new Container();

const rowText = (
	theme: CompactTheme,
	color: string,
	label: string,
	primary: string,
	secondary?: string,
	_primaryColor = "accent",
) => {
	let t = `${theme.fg(color, theme.bold(label))} ${theme.fg("dim", primary)}`;
	if (secondary) {
		t += theme.fg("dim", ` · ${secondary}`);
	}
	return t;
};

const row = (
	theme: CompactTheme,
	color: string,
	label: string,
	primary: string,
	secondary?: string,
	primaryColor = "accent",
) =>
	new Text(
		rowText(theme, color, label, primary, secondary, primaryColor),
		0,
		0,
	);

// Color tokens per tool label
const COLORS: Record<string, string> = {
	read: "accent",
	bash: "bashMode",
	edit: "warning",
	write: "warning",
	grep: "error",
	find: "success",
	ls: "muted",
};

export default function compactToolPreview(pi: ExtensionAPI) {
	const cwd = process.cwd();

	// ── read ────────────────────────────────────────────────────────────
	const _read = createReadTool(cwd);
	pi.registerTool({
		name: "read",
		label: "read",
		description: _read.description,
		parameters: _read.parameters,
		renderShell: "self",
		async execute(id, p, s, u) {
			return _read.execute(id, p, s, u);
		},
		renderCall(a, theme, context) {
			if (context.executionStarted && !context.isPartial) return empty();
			const range = meta(
				a.offset ? `offset ${a.offset}` : undefined,
				a.limit ? `limit ${a.limit}` : undefined,
				"reading…",
			);
			return row(theme, COLORS.read, "READ", shortPath(a.path), range);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return empty();
			const d = result.details as ReadToolDetails | undefined;
			const c = result.content[0];
			const path = shortPath(context.args.path);
			if (c?.type === "image") {
				return row(
					theme,
					COLORS.read,
					"READ",
					path,
					meta("image", d?.truncation?.truncated && "truncated"),
				);
			}
			if (c?.type !== "text") {
				return row(theme, COLORS.read, "READ", path, "no content");
			}
			const n = c.text.split("\n").length;
			const summary = rowText(
				theme,
				COLORS.read,
				"READ",
				path,
				meta(`${n} lines`, d?.truncation?.truncated && "truncated"),
			);
			if (!expanded) return new Text(summary, 0, 0);
			return new Text(`${summary}\n${dimLines(c.text, 12, theme)}`, 0, 0);
		},
	});

	// ── bash ────────────────────────────────────────────────────────────
	const _bash = createBashTool(cwd);
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: _bash.description,
		parameters: _bash.parameters,
		renderShell: "self",
		async execute(id, p, s, u) {
			return _bash.execute(id, p, s, u);
		},
		renderCall(a, theme, context) {
			if (context.executionStarted && !context.isPartial) return empty();
			return row(
				theme,
				COLORS.bash,
				"BASH",
				clip(a.command, 56),
				meta(a.timeout ? `${a.timeout}s` : undefined, "running…"),
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return empty();
			const d = result.details as BashToolDetails | undefined;
			const c = result.content.find((i) => i.type === "text");
			const out = c?.type === "text" ? c.text : "";
			const n = nel(out);
			const ec = d?.exitCode;
			const status = ec === undefined || ec === 0 ? "ok" : `exit ${ec}`;
			const summary = rowText(
				theme,
				COLORS.bash,
				"BASH",
				clip(context.args.command, 56),
				meta(status, `${n} lines`, d?.truncation?.truncated && "truncated"),
			);
			if (!expanded) return new Text(summary, 0, 0);
			return new Text(`${summary}\n${dimLines(out, 20, theme)}`, 0, 0);
		},
	});

	// ── edit ────────────────────────────────────────────────────────────
	const _edit = createEditTool(cwd);
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: _edit.description,
		parameters: _edit.parameters,
		renderShell: "self",
		async execute(id, p, s, u) {
			return _edit.execute(id, p, s, u);
		},
		renderCall(a, theme, context) {
			if (context.executionStarted && !context.isPartial) return empty();
			const n = Array.isArray(a.edits) ? a.edits.length : 1;
			return row(
				theme,
				COLORS.edit,
				"EDIT",
				shortPath(a.path),
				meta(n > 1 ? `${n} changes` : "1 change", "applying…"),
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return empty();
			const d = result.details as EditToolDetails | undefined;
			const c = result.content.find((i) => i.type === "text");
			const path = shortPath(context.args.path);
			if (c?.type === "text" && /^error/i.test(c.text.trim())) {
				return row(
					theme,
					COLORS.edit,
					"EDIT",
					path,
					clip(c.text.split("\n")[0] ?? c.text, 56),
				);
			}
			if (!d?.diff) return row(theme, COLORS.edit, "EDIT", path, "applied");
			let add = 0;
			let rem = 0;
			for (const l of d.diff.split("\n")) {
				if (l.startsWith("+") && !l.startsWith("+++")) add++;
				if (l.startsWith("-") && !l.startsWith("---")) rem++;
			}
			const summary = rowText(
				theme,
				COLORS.edit,
				"EDIT",
				path,
				meta(`+${add}`, `-${rem}`),
			);
			if (!expanded) return new Text(summary, 0, 0);
			const lines = d.diff.split("\n").slice(0, 25);
			const diff = lines
				.map((l) =>
					l.startsWith("+") && !l.startsWith("+++")
						? theme.fg("success", l)
						: l.startsWith("-") && !l.startsWith("---")
							? theme.fg("error", l)
							: theme.fg("dim", l),
				)
				.join("\n");
			return new Text(`${summary}\n${diff}`, 0, 0);
		},
	});

	// ── write ───────────────────────────────────────────────────────────
	const _write = createWriteTool(cwd);
	pi.registerTool({
		name: "write",
		label: "write",
		description: _write.description,
		parameters: _write.parameters,
		renderShell: "self",
		async execute(id, p, s, u) {
			return _write.execute(id, p, s, u);
		},
		renderCall(a, theme, context) {
			if (context.executionStarted && !context.isPartial) return empty();
			const n = a.content.split("\n").length;
			return row(
				theme,
				COLORS.write,
				"WRITE",
				shortPath(a.path),
				meta(`${n} lines`, "writing…"),
			);
		},
		renderResult(result, { isPartial }, theme, context) {
			if (isPartial) return empty();
			const d = result.details as WriteToolDetails | undefined;
			const c = result.content.find((i) => i.type === "text");
			const path = shortPath(context.args.path);
			if (c?.type === "text" && /^error/i.test(c.text.trim())) {
				return row(
					theme,
					COLORS.write,
					"WRITE",
					path,
					clip(c.text.split("\n")[0] ?? c.text, 56),
				);
			}
			return row(
				theme,
				COLORS.write,
				"WRITE",
				path,
				meta(
					"written",
					typeof d?.bytesWritten === "number"
						? `${d.bytesWritten}B`
						: undefined,
				),
			);
		},
	});

	// ── grep ────────────────────────────────────────────────────────────
	const _grep = createGrepTool(cwd);
	pi.registerTool({
		name: "grep",
		label: "grep",
		description: _grep.description,
		parameters: _grep.parameters,
		renderShell: "self",
		async execute(id, p, s, u) {
			return _grep.execute(id, p, s, u);
		},
		renderCall(a, theme, context) {
			if (context.executionStarted && !context.isPartial) return empty();
			return row(
				theme,
				COLORS.grep,
				"GREP",
				clip(`/${a.pattern}/`, 40),
				meta(
					a.path ? `in ${shortPath(a.path, 28)}` : undefined,
					a.glob && `glob:${a.glob}`,
					"searching…",
				),
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return empty();
			const d = result.details as GrepToolDetails | undefined;
			const c = result.content.find((i) => i.type === "text");
			const out = c?.type === "text" ? c.text : "";
			const n = nel(out);
			const summary = rowText(
				theme,
				COLORS.grep,
				"GREP",
				clip(`/${context.args.pattern}/`, 40),
				meta(
					`${n} matches`,
					d?.matchLimitReached && "limit",
					d?.truncation?.truncated && "truncated",
				),
			);
			if (!expanded) return new Text(summary, 0, 0);
			return new Text(`${summary}\n${dimLines(out, 12, theme)}`, 0, 0);
		},
	});

	// ── find ────────────────────────────────────────────────────────────
	const _find = createFindTool(cwd);
	pi.registerTool({
		name: "find",
		label: "find",
		description: _find.description,
		parameters: _find.parameters,
		renderShell: "self",
		async execute(id, p, s, u) {
			return _find.execute(id, p, s, u);
		},
		renderCall(a, theme, context) {
			if (context.executionStarted && !context.isPartial) return empty();
			return row(
				theme,
				COLORS.find,
				"FIND",
				clip(a.pattern, 36),
				meta(a.path ? `in ${shortPath(a.path, 28)}` : undefined, "searching…"),
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return empty();
			const d = result.details as FindToolDetails | undefined;
			const c = result.content.find((i) => i.type === "text");
			const out = c?.type === "text" ? c.text : "";
			const n = nel(out);
			const summary = rowText(
				theme,
				COLORS.find,
				"FIND",
				clip(context.args.pattern, 36),
				meta(
					`${n} files`,
					d?.resultLimitReached && "limit",
					d?.truncation?.truncated && "truncated",
				),
			);
			if (!expanded) return new Text(summary, 0, 0);
			return new Text(`${summary}\n${dimLines(out, 12, theme)}`, 0, 0);
		},
	});

	// ── ls ─────────────────────────────────────────────────────────────
	const _ls = createLsTool(cwd);
	pi.registerTool({
		name: "ls",
		label: "ls",
		description: _ls.description,
		parameters: _ls.parameters,
		renderShell: "self",
		async execute(id, p, s, u) {
			return _ls.execute(id, p, s, u);
		},
		renderCall(a, theme, context) {
			if (context.executionStarted && !context.isPartial) return empty();
			return row(theme, COLORS.ls, "LS", shortPath(a.path || "."), "listing…");
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return empty();
			const d = result.details as LsToolDetails | undefined;
			const c = result.content.find((i) => i.type === "text");
			const out = c?.type === "text" ? c.text : "";
			const n = nel(out);
			const summary = rowText(
				theme,
				COLORS.ls,
				"LS",
				shortPath(context.args.path || "."),
				meta(
					`${n} entries`,
					d?.entryLimitReached && "limit",
					d?.truncation?.truncated && "truncated",
				),
			);
			if (!expanded) return new Text(summary, 0, 0);
			return new Text(`${summary}\n${dimLines(out, 12, theme)}`, 0, 0);
		},
	});
}

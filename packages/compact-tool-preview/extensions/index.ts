/**
 * Compact Tool Preview — slim, single-line rendering for all built-in tools.
 *
 * Each tool has its own color for the UPPERCASE label.
 * Compact results, expand for detail via Ctrl+E.
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
import { Text } from "@mariozechner/pi-tui";

const HOME = homedir();
const tilde = (p: string) =>
	p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
const clip = (s: string, n = 88) =>
	s.length <= n ? s : `${s.slice(0, n - 1)}…`;
const nel = (s: string) => s.split("\n").filter((l) => l.trim()).length;
const dimLines = (text: string, max: number, theme: any) => {
	const ls = text.split("\n");
	const shown = ls.slice(0, max);
	let t = shown.map((l) => theme.fg("dim", l)).join("\n");
	if (ls.length > max)
		t += `\n${theme.fg("muted", `…${ls.length - max} more`)}`;
	return t;
};

// Color tokens per tool label — each tool gets a distinctive color
// READ=cyan, BASH=orange, EDIT=yellow, WRITE=yellow, GREP=magenta, FIND=blue, LS=muted
const COLORS: Record<string, string> = {
	read: "accent", // cyan/blue — reading/information
	bash: "bashMode", // orange — terminal/shell
	edit: "warning", // yellow — caution, modifying
	write: "warning", // yellow — caution, modifying
	grep: "error", // red/magenta — search highlights
	find: "success", // green — discovery
	ls: "muted", // gray — neutral listing
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
		async execute(id, p, s, u) {
			return _read.execute(id, p, s, u);
		},
		renderCall(a, theme) {
			const color = COLORS.read;
			let t = `${theme.fg(color, theme.bold("READ"))} ${theme.fg("accent", tilde(a.path))}`;
			if (a.offset || a.limit) {
				const parts: string[] = [];
				if (a.offset) parts.push(`offset ${a.offset}`);
				if (a.limit) parts.push(`limit ${a.limit}`);
				t += theme.fg("dim", ` (${parts.join(", ")})`);
			}
			return new Text(t, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("dim", "…"), 0, 0);
			const d = result.details as ReadToolDetails | undefined;
			const c = result.content[0];
			if (c?.type === "image")
				return new Text(theme.fg(COLORS.read, "✓ img"), 0, 0);
			if (c?.type !== "text") return new Text(theme.fg("muted", "—"), 0, 0);
			const n = c.text.split("\n").length;
			let t = theme.fg("success", `${n} lines`);
			if (d?.truncation?.truncated) t += theme.fg("dim", " ✂");
			if (!expanded) return new Text(t, 0, 0);
			return new Text(`${t}\n${dimLines(c.text, 12, theme)}`, 0, 0);
		},
	});

	// ── bash ────────────────────────────────────────────────────────────
	const _bash = createBashTool(cwd);
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: _bash.description,
		parameters: _bash.parameters,
		async execute(id, p, s, u) {
			return _bash.execute(id, p, s, u);
		},
		renderCall(a, theme) {
			const color = COLORS.bash;
			const cmd = clip(a.command, 88);
			let t = `${theme.fg(color, theme.bold("BASH"))} ${theme.fg("accent", cmd)}`;
			if (a.timeout) t += theme.fg("dim", ` (${a.timeout}s)`);
			return new Text(t, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg(COLORS.bash, "…"), 0, 0);
			const d = result.details as BashToolDetails | undefined;
			const c = result.content.find((i) => i.type === "text");
			const out = c?.type === "text" ? c.text : "";
			const n = nel(out);
			const ec = d?.exitCode;
			const ok = ec === undefined || ec === 0;
			let t = ok ? theme.fg("success", "✓") : theme.fg("error", `✗${ec}`);
			t += theme.fg("dim", ` ${n} lines`);
			if (d?.truncation?.truncated) t += theme.fg("dim", " ✂");
			if (!expanded) return new Text(t, 0, 0);
			return new Text(`${t}\n${dimLines(out, 20, theme)}`, 0, 0);
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
		renderCall(a, theme) {
			const color = COLORS.edit;
			const n = Array.isArray(a.edits) ? a.edits.length : 1;
			let t = `${theme.fg(color, theme.bold("EDIT"))} ${theme.fg("accent", tilde(a.path))}`;
			if (n > 1) t += theme.fg("dim", ` ×${n}`);
			return new Text(t, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg(COLORS.edit, "…"), 0, 0);
			const d = result.details as EditToolDetails | undefined;
			const c = result.content.find((i) => i.type === "text");
			if (c?.type === "text" && /^error/i.test(c.text.trim())) {
				return new Text(theme.fg("error", c.text.split("\n")[0]!), 0, 0);
			}
			if (!d?.diff) return new Text(theme.fg(COLORS.edit, "✓ applied"), 0, 0);
			let add = 0,
				rem = 0;
			for (const l of d.diff.split("\n")) {
				if (l.startsWith("+") && !l.startsWith("+++")) add++;
				if (l.startsWith("-") && !l.startsWith("---")) rem++;
			}
			const t = `${theme.fg("success", `+${add}`)} ${theme.fg("error", `-${rem}`)}`;
			if (!expanded) return new Text(t, 0, 0);
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
			return new Text(`${t}\n${diff}`, 0, 0);
		},
	});

	// ── write ───────────────────────────────────────────────────────────
	const _write = createWriteTool(cwd);
	pi.registerTool({
		name: "write",
		label: "write",
		description: _write.description,
		parameters: _write.parameters,
		async execute(id, p, s, u) {
			return _write.execute(id, p, s, u);
		},
		renderCall(a, theme) {
			const color = COLORS.write;
			const n = a.content.split("\n").length;
			return new Text(
				`${theme.fg(color, theme.bold("WRITE"))} ${theme.fg("accent", tilde(a.path))}${theme.fg("dim", ` (${n} lines)`)}`,
				0,
				0,
			);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg(COLORS.write, "…"), 0, 0);
			const d = result.details as WriteToolDetails | undefined;
			const c = result.content.find((i) => i.type === "text");
			if (c?.type === "text" && /^error/i.test(c.text.trim())) {
				return new Text(theme.fg("error", c.text.split("\n")[0]!), 0, 0);
			}
			let t = theme.fg(COLORS.write, "✓ written");
			if (typeof d?.bytesWritten === "number")
				t += theme.fg("dim", ` (${d.bytesWritten}B)`);
			return new Text(t, 0, 0);
		},
	});

	// ── grep ────────────────────────────────────────────────────────────
	const _grep = createGrepTool(cwd);
	pi.registerTool({
		name: "grep",
		label: "grep",
		description: _grep.description,
		parameters: _grep.parameters,
		async execute(id, p, s, u) {
			return _grep.execute(id, p, s, u);
		},
		renderCall(a, theme) {
			const color = COLORS.grep;
			let t = `${theme.fg(color, theme.bold("GREP"))} ${theme.fg("accent", clip(`/${a.pattern}/`, 60))}`;
			if (a.path) t += theme.fg("dim", ` in ${tilde(a.path)}`);
			if (a.glob) t += theme.fg("dim", ` glob:${a.glob}`);
			return new Text(t, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg(COLORS.grep, "…"), 0, 0);
			const d = result.details as GrepToolDetails | undefined;
			const c = result.content.find((i) => i.type === "text");
			const out = c?.type === "text" ? c.text : "";
			const n = nel(out);
			let t = theme.fg(COLORS.grep, `${n} matches`);
			if (d?.matchLimitReached) t += theme.fg("dim", "+");
			if (d?.truncation?.truncated) t += theme.fg("dim", " ✂");
			if (!expanded) return new Text(t, 0, 0);
			return new Text(`${t}\n${dimLines(out, 12, theme)}`, 0, 0);
		},
	});

	// ── find ────────────────────────────────────────────────────────────
	const _find = createFindTool(cwd);
	pi.registerTool({
		name: "find",
		label: "find",
		description: _find.description,
		parameters: _find.parameters,
		async execute(id, p, s, u) {
			return _find.execute(id, p, s, u);
		},
		renderCall(a, theme) {
			const color = COLORS.find;
			let t = `${theme.fg(color, theme.bold("FIND"))} ${theme.fg("accent", clip(a.pattern, 40))}`;
			if (a.path) t += theme.fg("dim", ` in ${tilde(a.path)}`);
			return new Text(t, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg(COLORS.find, "…"), 0, 0);
			const d = result.details as FindToolDetails | undefined;
			const c = result.content.find((i) => i.type === "text");
			const out = c?.type === "text" ? c.text : "";
			const n = nel(out);
			let t = theme.fg(COLORS.find, `${n} files`);
			if (d?.resultLimitReached) t += theme.fg("dim", "+");
			if (d?.truncation?.truncated) t += theme.fg("dim", " ✂");
			if (!expanded) return new Text(t, 0, 0);
			return new Text(`${t}\n${dimLines(out, 12, theme)}`, 0, 0);
		},
	});

	// ── ls ─────────────────────────────────────────────────────────────
	const _ls = createLsTool(cwd);
	pi.registerTool({
		name: "ls",
		label: "ls",
		description: _ls.description,
		parameters: _ls.parameters,
		async execute(id, p, s, u) {
			return _ls.execute(id, p, s, u);
		},
		renderCall(a, theme) {
			const color = COLORS.ls;
			return new Text(
				`${theme.fg(color, theme.bold("LS"))} ${theme.fg("accent", tilde(a.path || "."))}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg(COLORS.ls, "…"), 0, 0);
			const d = result.details as LsToolDetails | undefined;
			const c = result.content.find((i) => i.type === "text");
			const out = c?.type === "text" ? c.text : "";
			const n = nel(out);
			let t = theme.fg(COLORS.ls, `${n} entries`);
			if (d?.entryLimitReached) t += theme.fg("dim", "+");
			if (d?.truncation?.truncated) t += theme.fg("dim", " ✂");
			if (!expanded) return new Text(t, 0, 0);
			return new Text(`${t}\n${dimLines(out, 12, theme)}`, 0, 0);
		},
	});
}

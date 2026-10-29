/**
 * The sidebar's own model-facing tools.
 *
 * They exist so the plugin is self-contained: with only `dsh-wsl-sidebar`
 * installed an agent can run commands, read, write, edit and search inside any
 * WSL distribution without dsh-wsl-tool, dsh-ops or the Windows sandbox — every
 * operation runs as a native Linux command inside the distribution.
 *
 * Names carry the `wslx-` prefix on purpose: `wsl`, `wsl-read`, `wsl-write`,
 * `wsl-edit` and `wsl-grep` belong to dsh-wsl-tool, and DSH registers tools by
 * name, so a shared name would fail to mount when both plugins are installed.
 */
import { killTask, listTasks, readTask, startTask, writeTask } from "./tasks.js";
import {
	DEFAULT_TIMEOUT_MS,
	MAX_TIMEOUT_MS,
	distroFromWindowsPath,
	failureText,
	linuxPathFromWindows,
	resolveDistro,
	runInWsl,
	sessionCwd,
	shq,
} from "./wsl.js";
import { requirePermission } from "./policy.js";

/** A uniform text-returning tool: the model reads one block, whatever the tool. */
function textTool({ name, description, parameters, run }) {
	return {
		name,
		description,
		parameters,
		output: {
			schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
			render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
		},
		execute: async (args, exec) => ({ text: await run(args ?? {}, exec) }),
	};
}

/** Words that can precede the real command in a pipeline. */
const PRIVILEGE_WORDS = new Set(["sudo", "doas", "env", "nohup", "time", "exec", "command", "nice", "ionice", "xargs", "stdbuf"]);
/** Commands that stop the machine rather than change a project. */
const SYSTEM_COMMANDS = new Set(["shutdown", "reboot", "poweroff", "halt"]);

/** Paths whose deletion is never a coding task. */
const CATASTROPHIC_PATTERNS = [
	/^\/+$/,
	/^\/\*+$/,
	/^\/(home|root|Users)\/[^/]+\/?$/,
	/^\/mnt\/[a-z]\/?$/,
	/^\/mnt\/[a-z]\/(Windows|Program Files|ProgramData)\/?$/i,
	/^\/mnt\/[a-z]\/Users\/[^/]+\/?$/i,
];

/** Commands that destroy the machine rather than the project. */
const DESTRUCTIVE = [
	/\bmkfs(\.\w+)?\s/,
	/\bmkswap\s/,
	/\bdd\b[^\n]*\bof=\/dev\//,
	/>\s*\/dev\/(sd|nvme|vd|hd|mmcblk)/,
	/:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
	/\bchmod\s+(-[A-Za-z]+\s+)*[0-7]{3,4}\s+\/(\s|$)/,
	/\bchown\s+(-[A-Za-z]+\s+)*\S+\s+\/(\s|$)/,
	/\bfind\s+\/\s+[^\n]*-delete/,
	/\bshred\b[^\n]*\s\/dev\//,
	/\brm\s+(-[A-Za-z]+\s+)*--no-preserve-root/,
	/\b(wsl|wsl\.exe)\s+--unregister\b/,
	/\bdel\s+\/f\s+\/s\s+\/q\s+[a-z]:\\\*/i,
	/\breg\s+delete\s+HKLM/i,
];

function unquote(word) {
	return word.replace(/^['"]+|['"]+$/g, "");
}

/** True for a path whose recursive deletion destroys a machine or an account. */
function isCatastrophic(target) {
	const bare = unquote(target);
	if (bare.length === 0) return false;
	if (CATASTROPHIC_PATTERNS.some((pattern) => pattern.test(bare))) return true;
	// $HOME and ~ expansions reach the account root, not a project subdirectory.
	if (bare === "*" || bare === "~" || bare === "~/" || bare === "~/*") return true;
	return /^\$\{?HOME\}?(\/?$|\/\*$)/.test(bare);
}

/**
 * Why a command is destructive, or null when it is an ordinary command.
 *
 * Exported for the self-check: the guard is the only thing between a model and
 * `rm -rf /`, so it is worth testing without touching a distribution.
 */
export function destructiveReason(command) {
	const text = String(command ?? "");
	if (text.trim().length === 0) return null;
	for (const pattern of DESTRUCTIVE) {
		if (pattern.test(text)) return `matched ${pattern.source}`;
	}
	for (const segment of text.split(/[;&|\n]+/)) {
		const words = segment.trim().split(/\s+/).filter(Boolean);
		let index = 0;
		while (index < words.length && PRIVILEGE_WORDS.has(words[index])) index += 1;
		const head = words[index];
		if (head === undefined) continue;
		const base = head.includes("/") ? head.slice(head.lastIndexOf("/") + 1) : head;
		const args = words.slice(index + 1);
		if (base === "rm" || base === "srm" || base === "unlink") {
			const target = args.find((word) => !word.startsWith("-") && isCatastrophic(word));
			if (target !== undefined) return `${base} reaching ${unquote(target)}`;
		}
		if (SYSTEM_COMMANDS.has(base)) return `${base} stops the machine`;
		if (base === "systemctl" && args.some((arg) => ["reboot", "poweroff", "halt", "kexec"].includes(arg))) {
			return "systemctl stops the machine";
		}
		if (base === "init" && (args.length === 0 || ["0", "6"].includes(args[0]))) return "init stops the machine";
	}
	return null;
}

/**
 * Refuse a destructive command, and let it through only with explicit authority.
 *
 * `allowDangerous` is the caller's statement of intent, never a bypass: the call
 * still needs danger-full-access or one user approval.
 */
async function guardCommand(ctx, exec, label, command, allowDangerous) {
	const reason = destructiveReason(command);
	if (reason === null) return;
	if (allowDangerous !== true) {
		throw new Error(
			`${label}: refusing a destructive command (${reason}). Pass allowDangerous=true only if it is truly intended; that still needs danger-full-access or a user approval.`,
		);
	}
	await requirePermission(ctx, exec, label, `Destructive command in WSL (${reason}): ${String(command).slice(0, 160)}`);
}

/**
 * The shell expression for one working directory.
 *
 * `~` has to stay expandable: a quoted '~' is a literal directory name, which
 * is how a call with no usable workdir used to fail with "not found".
 */
function workdirExpr(workdir) {
	return workdir === "~" ? '"$HOME"' : shq(workdir);
}

/** Resolve the distro and working directory one call belongs to. */
async function targetOf(args, exec) {
	const cwd = sessionCwd(exec);
	const explicitWorkdir = typeof args.workdir === "string" && args.workdir.trim().length > 0 ? args.workdir.trim() : null;
	const source = explicitWorkdir ?? cwd;
	// A Linux workdir carries no distro, so the session workspace still answers
	// "which distribution am I in"; only a UNC workdir overrides it.
	const distroSource = distroFromWindowsPath(explicitWorkdir) !== null ? explicitWorkdir : cwd;
	const { distro, source: why } = await resolveDistro({ explicit: args.distro, cwd: distroSource });
	const workdir = source === null ? "~" : (linuxPathFromWindows(source) ?? "~");
	return { distro, why, workdir, asRoot: args.asRoot === true };
}

/** wslx-run — the command tool. */
function createRunTool(ctx) {
	return textTool({
		name: "wslx-run",
		description:
			"Run a bash command inside a WSL distribution and return its output. This is the plugin's own tool: it needs no Windows sandbox, no ops_bash and no dsh-wsl-tool, and the command is a native Linux command (bash, rg, sed, git, make, python3 ...). " +
			"`distro` defaults to the distribution the calling session's workspace already lives in (so a \\\\wsl.localhost\\Ubuntu-24.04\\... workspace always runs in Ubuntu), else DSH_WSL_DISTRO when set, else wsl.exe's default. " +
			"`workdir` is a Linux path or a Windows/UNC path; it defaults to the session workspace. Output over 2 MiB is cut and flagged. " +
			"Destructive commands (deleting a filesystem or an account root, mkfs, dd onto a device, machine restarts, wsl --unregister) are refused; allowDangerous only asks for authority, and asRoot needs danger-full-access or one user approval.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "The bash command line to run (single quotes, pipes and globs are fine)." },
				distro: { type: "string", description: "Distribution name; omit to use the session workspace's distribution." },
				asRoot: { type: "boolean", description: "Run as the Linux root account (wsl.exe -u root). Allowed only with the session permission danger-full-access or one user approval; the Windows process itself does not need elevation." },
				workdir: { type: "string", description: "Working directory: a Linux path or a Windows/UNC path. Defaults to the session workspace." },
				timeoutMs: { type: "integer", description: `Deadline in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` },
				allowDangerous: { type: "boolean", description: "Allow a command the guard would otherwise refuse (rm -rf /, mkfs, dd onto a device ...); it still needs danger-full-access or a user approval. Default false." },
			},
			required: ["command"],
		},
		run: async (args, exec) => {
			if (typeof args.command !== "string" || args.command.trim().length === 0) {
				throw new Error("wslx-run: command must be a non-empty string");
			}
			await guardCommand(ctx, exec, "wslx-run", args.command, args.allowDangerous);
			const { distro, why, workdir, asRoot } = await targetOf(args, exec);
			const script = `cd -- ${workdirExpr(workdir)} 2>/dev/null || { echo "wslx: working directory not found: ${shq(workdir)}" >&2; exit 117; }\n${args.command}\n`;
			const result = await runInWsl({ distro, script, asRoot, timeoutMs: args.timeoutMs });
			const header = `[${result.distro ?? "default distro"} · ${workdir} · exit ${result.exitCode}${result.timedOut ? " · timed out" : ""}]`;
			const body = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter((part) => part.length > 0).join("\n");
			return `${header}\n${body.length === 0 ? "(no output)" : body}${result.truncated ? "\n(output capped at 2 MiB)" : ""}`;
		},
	});
}

/** wslx-read — numbered, paged file reads. */
function createReadTool() {
	return textTool({
		name: "wslx-read",
		description:
			"Read a text file inside WSL and return it with line numbers, 2000 lines per call. Reads run as native Linux commands inside the distribution, so the file is never served over the 9p share. " +
			"`path` is a Linux path, a Windows path or a UNC path; a relative path resolves against the session workspace. `distro` defaults to the workspace's distribution.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File to read." },
				offset: { type: "integer", description: "1-based first line; defaults to 1." },
				limit: { type: "integer", description: "Lines to return (1-2000); defaults to 2000." },
				distro: { type: "string", description: "Distribution name; omit to use the session workspace's distribution." },
				asRoot: { type: "boolean", description: "Run as the Linux root account (wsl.exe -u root). Allowed only with the session permission danger-full-access or one user approval; the Windows process itself does not need elevation." },
			},
			required: ["path"],
		},
		run: async (args, exec) => {
			if (typeof args.path !== "string" || args.path.trim().length === 0) throw new Error("wslx-read: path must be a non-empty string");
			const offset = Math.max(Number(args.offset) || 1, 1);
			const limit = Math.min(Math.max(Number(args.limit) || 2000, 1), 2000);
			const { distro, workdir, asRoot } = await targetOf({ distro: args.distro, asRoot: args.asRoot, workdir: undefined }, exec);
			const path = linuxPathFromWindows(args.path) ?? args.path;
			const script =
				`f=${shq(path)}\n` +
				`case "$f" in /*) ;; *) f=${workdirExpr(workdir)}/"$f" ;; esac\n` +
				`[ -f "$f" ] || { echo "wslx: not a file: $f" >&2; exit 118; }\n` +
				`awk -v s=${offset} -v e=${offset + limit - 1} '{ if (++n >= s && n <= e) printf "%6d\\t%s\\n", n, $0 } END { printf "\\n__WSLX_TOTAL__%d\\n", n }' "$f"\n`;
			const result = await runInWsl({ distro, script, asRoot });
			if (result.exitCode !== 0) throw new Error(failureText(`wslx-read: ${path}`, result));
			const text = result.stdout;
			const marker = text.lastIndexOf("\n__WSLX_TOTAL__");
			const total = marker === -1 ? 0 : Number(text.slice(marker + 15).trim()) || 0;
			const body = marker === -1 ? text : text.slice(0, marker);
			const last = offset + limit - 1 >= total ? total : offset + limit - 1;
			const footer =
				total === 0
					? "(empty file)"
					: last >= total
						? `(End of file - total ${total} lines)`
						: `(Showing lines ${offset}-${last} of ${total}. Use offset=${last + 1} to continue.)`;
			return `${body.trimEnd()}\n${footer}`;
		},
	});
}

/** wslx-write — whole-file writes through a Linux-side stdin pipe. */
function createWriteTool() {
	return textTool({
		name: "wslx-write",
		description:
			"Write a whole text file inside WSL. The bytes are piped into `cat` running inside the distribution, which is why this works where writing through \\\\wsl.localhost does not: the 9p share cannot do the atomic rename a Windows writer needs. " +
			"Parent directories are created. Use wslx-edit for a partial change.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File to write (Linux, Windows or UNC path)." },
				content: { type: "string", description: "Full UTF-8 content." },
				distro: { type: "string", description: "Distribution name; omit to use the session workspace's distribution." },
				asRoot: { type: "boolean", description: "Run as the Linux root account (wsl.exe -u root). Allowed only with the session permission danger-full-access or one user approval; the Windows process itself does not need elevation." },
			},
			required: ["path", "content"],
		},
		run: async (args, exec) => {
			if (typeof args.path !== "string" || args.path.trim().length === 0) throw new Error("wslx-write: path must be a non-empty string");
			if (typeof args.content !== "string") throw new Error("wslx-write: content must be a string");
			const { distro, workdir, asRoot } = await targetOf({ distro: args.distro, asRoot: args.asRoot }, exec);
			const path = linuxPathFromWindows(args.path) ?? args.path;
			const script =
				`f=${shq(path)}\n` +
				`case "$f" in /*) ;; *) f=${workdirExpr(workdir)}/"$f" ;; esac\n` +
				`mkdir -p "$(dirname -- "$f")" && cat > "$f" && wc -c < "$f"\n`;
			const result = await runInWsl({ distro, script, asRoot, input: args.content });
			if (result.exitCode !== 0) throw new Error(failureText(`wslx-write: ${path}`, result));
			const bytes = Number(result.stdout.trim()) || 0;
			return `Wrote ${bytes} bytes to ${path}${distro === null ? "" : ` in ${distro}`}.`;
		},
	});
}

/** wslx-edit — literal replacement, applied on the host and written back in Linux. */
function createEditTool() {
	return textTool({
		name: "wslx-edit",
		description:
			"Replace an exact string in a file inside WSL. The file is read and rewritten through Linux-side commands, so a replaced file keeps its mode and owner. `oldString` must be unique unless replaceAll is true.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File to edit (Linux, Windows or UNC path)." },
				oldString: { type: "string", description: "Exact text to replace (byte for byte, including indentation)." },
				newString: { type: "string", description: "Replacement text; empty deletes the match." },
				replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." },
				distro: { type: "string", description: "Distribution name; omit to use the session workspace's distribution." },
				asRoot: { type: "boolean", description: "Run as the Linux root account (wsl.exe -u root). Allowed only with the session permission danger-full-access or one user approval; the Windows process itself does not need elevation." },
			},
			required: ["path", "oldString", "newString"],
		},
		run: async (args, exec) => {
			if (typeof args.path !== "string" || args.path.trim().length === 0) throw new Error("wslx-edit: path must be a non-empty string");
			if (typeof args.oldString !== "string" || args.oldString.length === 0) throw new Error("wslx-edit: oldString must be a non-empty string");
			if (typeof args.newString !== "string") throw new Error("wslx-edit: newString must be a string");
			const { distro, workdir, asRoot } = await targetOf({ distro: args.distro, asRoot: args.asRoot }, exec);
			const path = linuxPathFromWindows(args.path) ?? args.path;
			const resolved =
				`f=${shq(path)}\n` +
				`case "$f" in /*) ;; *) f=${workdirExpr(workdir)}/"$f" ;; esac\n` +
				`printf '%s' "$f"\n`;
			const which = await runInWsl({ distro, script: resolved, asRoot });
			if (which.exitCode !== 0) throw new Error(failureText(`wslx-edit: ${path}`, which));
			const file = which.stdout.trim();
			const read = await runInWsl({ distro, script: `cat -- ${shq(file)}`, asRoot });
			if (read.exitCode !== 0) throw new Error(failureText(`wslx-edit: ${path}`, read));
			if (read.truncated) throw new Error(`wslx-edit: ${path} is larger than the 2 MiB read window; use a smaller file or wslx-run with sed.`);
			const source = read.stdout;
			const occurrences = source.split(args.oldString).length - 1;
			if (occurrences === 0) throw new Error(`wslx-edit: ${path}: oldString not found`);
			if (occurrences > 1 && args.replaceAll !== true) {
				throw new Error(`wslx-edit: ${path}: oldString occurs ${occurrences} times; make it unique or pass replaceAll=true`);
			}
			const updated = args.replaceAll === true ? source.split(args.oldString).join(args.newString) : source.replace(args.oldString, args.newString);
			const write = await runInWsl({ distro, script: `cat > ${shq(file)}`, asRoot, input: updated });
			if (write.exitCode !== 0) throw new Error(failureText(`wslx-edit: ${path}`, write));
			return `Edited ${path} (${occurrences} replacement${occurrences === 1 ? "" : "s"}).`;
		},
	});
}

/** wslx-search — ripgrep when available, GNU grep otherwise. */
function createSearchTool() {
	return textTool({
		name: "wslx-search",
		description:
			"Search file contents inside WSL with a regular expression and return matching lines grouped by file. Uses `rg` when the distribution has it and GNU `grep -E` otherwise; the search runs natively in Linux, so it is fast over a WSL workspace. Returns up to 250 matches.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Regular expression (ripgrep syntax)." },
				path: { type: "string", description: "File or directory; defaults to the session workspace." },
				glob: { type: "string", description: 'One include glob, e.g. "*.ts".' },
				distro: { type: "string", description: "Distribution name; omit to use the session workspace's distribution." },
				asRoot: { type: "boolean", description: "Run as the Linux root account (wsl.exe -u root). Allowed only with the session permission danger-full-access or one user approval; the Windows process itself does not need elevation." },
			},
			required: ["pattern"],
		},
		run: async (args, exec) => {
			if (typeof args.pattern !== "string" || args.pattern.length === 0) throw new Error("wslx-search: pattern must be a non-empty string");
			const { distro, workdir, asRoot } = await targetOf({ distro: args.distro, asRoot: args.asRoot }, exec);
			const dir = args.path === undefined ? workdir : (linuxPathFromWindows(args.path) ?? args.path);
			const glob = typeof args.glob === "string" && args.glob.length > 0 ? args.glob : null;
			const rgGlob = glob === null ? "" : ` --glob ${shq(glob)}`;
			const grepGlob = glob === null ? "" : ` --include=${shq(glob)}`;
			const script =
				`cd -- ${workdirExpr(dir)} 2>/dev/null || cd -- / || exit 117\n` +
				`if command -v rg >/dev/null 2>&1; then\n` +
				`  rg --line-number --no-heading --color never --max-columns 400 --max-count 250${rgGlob} -e ${shq(args.pattern)} -- . ; rc=$?\n` +
				`  case $rc in 0) exit 0 ;; 1) exit 3 ;; *) exit $rc ;; esac\n` +
				`else\n` +
				`  grep -rnE --exclude-dir=.git${grepGlob} -e ${shq(args.pattern)} . | head -250\n` +
				`  case \${PIPESTATUS[0]} in 0) exit 0 ;; 1) exit 3 ;; *) exit 2 ;; esac\n` +
				`fi\n`;
			const result = await runInWsl({ distro, script, asRoot });
			if (result.exitCode === 3) return `No matches for ${args.pattern} in ${dir}.`;
			if (result.exitCode !== 0) throw new Error(failureText(`wslx-search: ${dir}`, result));
			const body = result.stdout.trimEnd().replace(/^\.\//gm, "");
			const lines = body.length === 0 ? 0 : body.split("\n").length;
			return `${lines === 0 ? "No matches" : `${lines} matching line${lines === 1 ? "" : "s"}`} in ${dir}${distro === null ? "" : ` (${distro})`}\n\n${body}`;
		},
	});
}

/** wslx-bg — background jobs and line-fed interactive shells. */
function createBackgroundTool(ctx) {
	return textTool({
		name: "wslx-bg",
		description:
			"Keep a process running inside WSL and talk to it across calls: a dev server, a long test run, or an interactive shell. " +
			"action=start launches it (`mode=command` runs your bash command, `mode=shell` keeps an interactive `bash -i` open that action=input feeds line by line); " +
			"action=output returns everything written after `cursor`; action=input writes one line to stdin; action=kill ends it; action=list shows every task. " +
			"Tasks live inside the plugin process, so they end with DSH and never leave a Linux daemon behind; the default time to live is 30 minutes. " +
			"Without a pseudo-terminal a full-screen TUI (vim, top) cannot work, but REPLs, prompts and `sudo` password reads can. Output over 1 MiB per task drops the oldest lines and says so. " +
			"The same destructive-command guard and root rule apply to action=start.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["start", "output", "input", "kill", "list"], description: "What to do." },
				command: { type: "string", description: "action=start with mode=command: the bash command line." },
				mode: { type: "string", enum: ["command", "shell"], description: 'action=start: "command" (default) runs bash -lc; "shell" keeps an interactive bash open.' },
				distro: { type: "string", description: "Distribution name; omit to use the session workspace's distribution." },
				workdir: { type: "string", description: "action=start: working directory as a Linux path or a Windows/UNC path; defaults to the session workspace." },
				asRoot: { type: "boolean", description: "Run as the Linux root account (wsl.exe -u root). Allowed only with the session permission danger-full-access or one user approval; the Windows process itself does not need elevation." },
				taskId: { type: "string", description: "action=output/input/kill: the id a previous start returned." },
				cursor: { type: "integer", description: "action=output: return output after this offset; pass the previous call's cursor to read only what is new." },
				text: { type: "string", description: "action=input: the line to write to stdin." },
				ttlMinutes: { type: "integer", description: "action=start: terminate after this many minutes (default 30, max 720)." },
				allowDangerous: { type: "boolean", description: "action=start: allow a command the guard would otherwise refuse; it still needs danger-full-access or a user approval. Default false." },
			},
			required: ["action"],
		},
		run: async (args, exec) => {
			const action = String(args.action ?? "");
			if (action === "list") {
				const tasks = listTasks();
				if (tasks.length === 0) return "No WSL tasks in this plugin process.";
				const rows = tasks.map(
					(task) =>
						`${task.id}\t${task.running ? "running" : `exit ${task.exitCode}`}\t${task.seconds}s\t${task.distro ?? "default"}${task.asRoot ? " (root)" : ""}\t${task.cwd}\t${task.command}`,
				);
				return `id\tstate\tage\tdistro\tcwd\tcommand\n${rows.join("\n")}`;
			}
			if (action === "output") {
				if (typeof args.taskId !== "string" || args.taskId.length === 0) throw new Error("wslx-bg: action=output needs taskId");
				const read = readTask(args.taskId, { cursor: args.cursor });
				const state = read.running ? "running" : `exit ${read.exitCode}${read.timedOut ? " (time to live reached)" : ""}`;
				const header = `[${read.id} · ${read.distro ?? "default distro"} · ${read.cwd} · ${state} · cursor ${read.cursor}]`;
				const lost = read.dropped ? "\n(older output dropped: the task log is capped at 1 MiB)" : "";
				const body = read.text.length === 0 ? "(no new output)" : read.text.replace(/\n$/, "");
				return `${header}${lost}\n${body}`;
			}
			if (action === "input") {
				if (typeof args.taskId !== "string" || args.taskId.length === 0) throw new Error("wslx-bg: action=input needs taskId");
				if (typeof args.text !== "string") throw new Error("wslx-bg: action=input needs text");
				const written = writeTask(args.taskId, args.text);
				return `Sent ${args.text.length} byte(s) to ${args.taskId} stdin (cursor ${written.cursor}). Poll with action=output.`;
			}
			if (action === "kill") {
				if (typeof args.taskId !== "string" || args.taskId.length === 0) throw new Error("wslx-bg: action=kill needs taskId");
				const killed = killTask(args.taskId);
				return killed.already ? `${args.taskId} had already exited.` : `Ctrl-C sent to ${args.taskId}; its Windows process tree is killed if it ignores it.`;
			}
			if (action !== "start") throw new Error(`wslx-bg: unknown action "${action}"`);
			const mode = args.mode === "shell" ? "shell" : "command";
			if (mode === "command" && (typeof args.command !== "string" || args.command.trim().length === 0)) {
				throw new Error("wslx-bg: action=start with mode=command needs a non-empty command");
			}
			if (mode === "command") await guardCommand(ctx, exec, "wslx-bg", args.command, args.allowDangerous);
			const { distro, workdir, asRoot } = await targetOf({ distro: args.distro, workdir: args.workdir, asRoot: args.asRoot }, exec);
			const record = startTask({
				distro,
				// mode=shell gets its directory from `--cd`, so its script stays unused.
				script: mode === "command" ? `${args.command}\n` : "",
				cwdUnix: workdir === "~" ? undefined : workdir,
				asRoot,
				mode,
				ttlMs: (Number(args.ttlMinutes) || 30) * 60_000,
			});
			const banner =
				mode === "shell"
					? `Started interactive bash as ${record.id} in ${distro ?? "default distro"} (${workdir})${asRoot ? " as root" : ""}. Feed it with action=input, read it with action=output.`
					: `Started ${record.id} in ${distro ?? "default distro"} (${workdir})${asRoot ? " as root" : ""}: ${args.command}`;
			return `${banner}\nPoll with action=output taskId=${record.id} cursor=0; the task ends after ${Number(args.ttlMinutes) || 30} minute(s) unless you kill it first.`;
		},
	});
}

/** Wrap one tool so `asRoot` asks for authority before anything runs. */
function rootGate(ctx, tool) {
	const name = tool.name;
	const execute = tool.execute;
	return {
		...tool,
		execute: async (args, exec) => {
			const starting = args?.asRoot === true && (args?.action === undefined || args.action === "start");
			if (starting) {
				await requirePermission(
					ctx,
					exec,
					name,
					`${name} asked for the Linux root account${args?.distro ? ` in ${args.distro}` : ""}${typeof args?.command === "string" ? `: ${args.command.slice(0, 160)}` : ""}`,
				);
			}
			return execute(args, exec);
		},
	};
}

/** Every tool this plugin mounts, in the order they appear in a tool list. */
export function createTools(ctx = {}) {
	const tools = [createRunTool(ctx), createReadTool(), createWriteTool(), createEditTool(), createSearchTool(), createBackgroundTool(ctx)];
	return tools.map((tool) => rootGate(ctx, tool));
}

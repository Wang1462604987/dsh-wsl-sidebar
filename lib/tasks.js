/**
 * Long-running WSL processes: background jobs and line-based interactive shells.
 *
 * Both are one `wsl.exe` child kept open on the host. The Linux side is never
 * asked to daemonise, so a task lives exactly as long as this plugin process and
 * dies with it — no orphaned daemons, no pid files, no second bookkeeping layer.
 *
 * Output is kept in one ordered UTF-8 log with an absolute cursor, so a poller
 * asks for "everything after N" instead of re-reading the whole log, and a slow
 * reader cannot make the buffer grow without bound.
 */
import { spawn } from "node:child_process";
import { buildWslArgs, wslEnv } from "./wsl.js";

/** Per-task output ceiling; the oldest characters fall off first and are flagged. */
const MAX_LOG_CHARS = 1 << 20;
/** After Ctrl-C, how long a task gets before its Windows process tree is killed. */
const KILL_GRACE_MS = 4000;
/** How many finished tasks stay queryable. */
const KEEP_FINISHED = 20;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

const tasks = new Map();
let seq = 0;

/**
 * Drop terminal escape sequences from captured output.
 *
 * A shell without a pseudo-terminal still emits its prompt colours and an
 * OSC title sequence; those bytes are noise to a reader, and stripping them
 * keeps the visible text aligned with what a terminal would show.
 */
function stripAnsi(text) {
	const ESC = 27;
	const BEL = 7;
	let out = "";
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) !== ESC) {
			out += text[i];
			continue;
		}
		const next = text[i + 1];
		if (next === "]") {
			let j = i + 2;
			while (j < text.length) {
				const code = text.charCodeAt(j);
				if (code === BEL) {
					j += 1;
					break;
				}
				if (code === ESC && text[j + 1] === "\\") {
					j += 2;
					break;
				}
				j += 1;
			}
			i = j - 1;
			continue;
		}
		if (next === "[") {
			let j = i + 2;
			while (j < text.length && !/[A-Za-z]/.test(text[j])) j += 1;
			i = j;
			continue;
		}
		i += 1;
	}
	return out;
}

/** Append to a task log, dropping the oldest characters past the ceiling. */
function append(record, text) {
	if (text.length === 0) return;
	record.log += text;
	const overflow = record.log.length - MAX_LOG_CHARS;
	if (overflow > 0) {
		record.log = record.log.slice(overflow);
		record.base += overflow;
	}
}

/** Kill one Windows process tree, which takes the wsl.exe child and its Linux job with it. */
function killTree(pid) {
	return new Promise((resolve) => {
		const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		killer.on("error", () => resolve());
		killer.on("close", () => resolve());
	});
}

/** Drop the oldest finished records so a long session does not accumulate them. */
function prune() {
	const finished = [...tasks.values()].filter((task) => !task.running).sort((a, b) => a.startedAt - b.startedAt);
	while (finished.length > KEEP_FINISHED) {
		const victim = finished.shift();
		tasks.delete(victim.id);
	}
}

/**
 * Start one long-running process inside a distribution.
 *
 * @param mode "command" runs `bash -lc script` and exits; "shell" runs
 *             `bash -i`, so writeTask() can feed a REPL line by line.
 */
export function startTask({ distro, script, cwdUnix, asRoot, mode = "command", ttlMs = DEFAULT_TTL_MS }) {
	prune();
	seq += 1;
	const id = `t${seq}`;
	const args = buildWslArgs({ distro, script, cwdUnix, asRoot, mode });
	const child = spawn("wsl.exe", args, {
		env: wslEnv({ TERM: "xterm-256color" }),
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const record = {
		id,
		distro: distro ?? null,
		mode,
		command: mode === "shell" ? "(interactive bash)" : String(script ?? "").trim(),
		cwd: cwdUnix ?? "~",
		asRoot: asRoot === true,
		startedAt: Date.now(),
		child,
		log: "",
		base: 0,
		running: true,
		exitCode: null,
		timedOut: false,
	};
	tasks.set(id, record);
	child.stdin.on("error", () => {});
	child.stdout.on("data", (chunk) => append(record, chunk.toString("utf8")));
	child.stderr.on("data", (chunk) => append(record, chunk.toString("utf8")));
	child.on("error", (error) => {
		record.running = false;
		record.exitCode = -1;
		append(record, `\nwslx-bg: ${error.message}\n`);
	});
	child.on("close", (code) => {
		record.running = false;
		record.exitCode = typeof code === "number" ? code : -1;
		if (record.ttlTimer !== undefined) clearTimeout(record.ttlTimer);
	});
	const ttl = Math.min(Math.max(Number(ttlMs) || DEFAULT_TTL_MS, 60_000), 12 * 60 * 60 * 1000);
	record.ttlTimer = setTimeout(() => {
		record.timedOut = true;
		append(record, "\nwslx-bg: time to live reached; terminating\n");
		killTask(id);
	}, ttl);
	record.ttlTimer.unref?.();
	return record;
}

/** Every task this plugin process knows about, newest last. */
export function listTasks() {
	return [...tasks.values()].map((task) => ({
		id: task.id,
		distro: task.distro,
		mode: task.mode,
		cwd: task.cwd,
		asRoot: task.asRoot,
		running: task.running,
		exitCode: task.exitCode,
		seconds: Math.round((Date.now() - task.startedAt) / 1000),
		command: task.command.length > 120 ? `${task.command.slice(0, 117)}...` : task.command,
	}));
}

/**
 * Read what a task wrote after `cursor`.
 *
 * @returns the visible text (terminal escapes removed), the next cursor, and
 *          whether earlier output was dropped to stay under the ceiling.
 */
export function readTask(id, { cursor = 0 } = {}) {
	const task = tasks.get(id);
	if (task === undefined) throw new Error(`wslx-bg: unknown task "${id}"`);
	const wanted = Math.max(Number(cursor) || 0, 0);
	const dropped = wanted < task.base;
	const from = Math.max(wanted, task.base) - task.base;
	const text = stripAnsi(task.log.slice(from));
	return {
		id: task.id,
		distro: task.distro,
		mode: task.mode,
		cwd: task.cwd,
		running: task.running,
		exitCode: task.exitCode,
		timedOut: task.timedOut,
		cursor: task.base + task.log.length,
		dropped,
		text,
	};
}

/** Send one line (or raw characters) to a running task's stdin. */
export function writeTask(id, text, { newline = true } = {}) {
	const task = tasks.get(id);
	if (task === undefined) throw new Error(`wslx-bg: unknown task "${id}"`);
	if (!task.running) throw new Error(`wslx-bg: task ${id} already exited (code ${task.exitCode})`);
	task.child.stdin.write(newline ? `${text}\n` : text);
	return { id: task.id, cursor: task.base + task.log.length };
}

/**
 * Terminate a task: Ctrl-C first (a REPL answers it), then the Windows process
 * tree, whose Linux children go with it.
 */
export function killTask(id) {
	const task = tasks.get(id);
	if (task === undefined) throw new Error(`wslx-bg: unknown task "${id}"`);
	if (!task.running) return { id: task.id, already: true };
	try {
		task.child.stdin.write(String.fromCharCode(3));
	} catch {
		/* stdin already gone; the tree kill below is what matters */
	}
	const pid = task.child.pid;
	task.child.kill();
	if (pid !== undefined) {
		setTimeout(() => {
			void killTree(pid);
		}, KILL_GRACE_MS).unref?.();
	}
	return { id: task.id, already: false };
}

/**
 * Stop every live task, without throwing for the ones that already exited.
 *
 * Called when the plugin is disposed: a detached `wslx-bg` task would otherwise
 * outlive the plugin (up to its TTL ceiling) with nothing left to report to.
 *
 * @returns {number} how many tasks this actually stopped.
 */
export function killAllTasks() {
	let stopped = 0;
	for (const id of [...tasks.keys()]) {
		try {
			if (killTask(id).already !== true) stopped += 1;
		} catch {
			/* already gone; nothing to stop */
		}
	}
	return stopped;
}

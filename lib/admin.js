/**
 * WSL administration surface for the sidebar panel: distro lifecycle, the two
 * configuration files (`%USERPROFILE%\.wslconfig` and each distro's
 * `/etc/wsl.conf`) and read-only runtime statistics.
 *
 * Everything here is user-initiated UI traffic, not agent tool traffic: the panel
 * asks, the Host answers with one `wsl.exe` call (or one Linux root write), and
 * nothing is retried behind the user's back.
 */
import { execFile } from "node:child_process";
import { readFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runInWsl } from "./wsl.js";

const ADMIN_TIMEOUT_MS = 90_000;

/** Run one wsl.exe call and decode its (usually UTF-16LE) output. */
export function runWslExe(args, { timeoutMs = ADMIN_TIMEOUT_MS } = {}) {
	return new Promise((resolve, reject) => {
		execFile(
			"wsl.exe",
			args,
			{
				encoding: "buffer",
				windowsHide: true,
				maxBuffer: 1 << 22,
				timeout: timeoutMs,
				// wsl.exe prints UTF-16LE by default; this keeps messages readable in every locale.
				env: { ...process.env, WSL_UTF8: "1" }
			},
			(error, stdout, stderr) => {
				const decode = (buffer) => {
					if (buffer.length === 0) return "";
					if (buffer.length > 1 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
					return buffer.toString("utf8").replace(/\0/g, "");
				};
				if (error && typeof error.code === "string" && error.code === "ENOENT") {
					reject(error);
					return;
				}
				resolve({
					exitCode: error === null ? 0 : typeof error?.code === "number" ? error.code : 1,
					stdout: decode(stdout),
					stderr: decode(stderr)
				});
			}
		);
	});
}

/**
 * `wsl.exe -l -v` parsed into one row per distribution.
 *
 * The NAME column may contain spaces, so the row is read from both ends: the
 * leading `*`/spaces mark the default, the last two tokens are STATE and VERSION.
 */
export async function listVerbose() {
	const result = await runWslExe(["-l", "-v"]);
	const rows = [];
	for (const raw of result.stdout.split(/\r?\n/)) {
		const line = raw.replace(/\0/g, "");
		if (line.trim().length === 0) continue;
		const isDefault = /^\s*\*/.test(line);
		const tokens = line.trim().replace(/^\*\s*/, "").split(/\s+/);
		if (tokens.length < 3) continue;
		const version = tokens[tokens.length - 1];
		const state = tokens[tokens.length - 2];
		if (!/^\d+$/.test(version)) continue;
		if (!/^(Running|Stopped|Installing|Uninstalling|Converting|Starting|Stopping)$/i.test(state)) continue;
		const name = tokens.slice(0, -2).join(" ");
		if (name.length === 0 || /^NAME$/i.test(name)) continue;
		rows.push({ name, isDefault, state: state.toLowerCase(), version: Number(version) });
	}
	return rows;
}

/** `wsl.exe --status` / `--version` as plain text, best effort. */
export async function wslSummary() {
	const [status, version] = await Promise.all([
		runWslExe(["--status"]).catch(() => ({ stdout: "", stderr: "" })),
		runWslExe(["--version"]).catch(() => ({ stdout: "", stderr: "" }))
	]);
	const text = (value) => (value.stdout || value.stderr || "").trim();
	return { status: text(status), version: text(version) };
}

/** One distro's live numbers, read inside the distribution with native Linux tools. */
export async function distroStats(distro) {
	const script = [
		"printf 'MEM '; free -b | awk '/^Mem:/{print $2\" \"$3\" \"$7}'",
		"printf 'DISK '; df -B1 / | awk 'NR==2{print $2\" \"$3\" \"$4\" \"$5}'",
		"printf 'LOAD '; cut -d' ' -f1-3 /proc/loadavg",
		"printf 'UPTIME '; cut -d' ' -f1 /proc/uptime",
		"printf 'PORTS\\n'; (ss -ltnH 2>/dev/null || true) | awk '{print $4}'",
		"printf 'PROCS '; ls /proc | grep -c '^[0-9]\\+$'"
	].join("; ");
	const result = await runInWsl({ distro, script, timeoutMs: 20_000 });
	const stats = { memory: null, disk: null, load: null, uptimeSeconds: null, ports: [], processes: null };
	for (const line of result.stdout.split(/\r?\n/)) {
		const [head, ...rest] = line.trim().split(/\s+/);
		const values = rest.join(" ");
		if (head === "MEM") {
			const [total, used, available] = values.split(" ").map(Number);
			if (Number.isFinite(total)) stats.memory = { totalBytes: total, usedBytes: used, availableBytes: available };
		} else if (head === "DISK") {
			const [total, used, available, percent] = values.split(" ");
			if (Number.isFinite(Number(total))) {
				stats.disk = { totalBytes: Number(total), usedBytes: Number(used), availableBytes: Number(available), usedPercent: percent ?? null };
			}
		} else if (head === "LOAD") {
			stats.load = values || null;
		} else if (head === "UPTIME") {
			const seconds = Number(values);
			stats.uptimeSeconds = Number.isFinite(seconds) ? seconds : null;
		} else if (head === "PROCS") {
			const count = Number(values);
			stats.processes = Number.isFinite(count) ? count : null;
		} else if (/^(0\.0\.0\.0|\[::\]|\*|::):\d+$/.test(head ?? "")) {
			stats.ports.push({ address: head.slice(0, head.lastIndexOf(":")), port: Number(head.slice(head.lastIndexOf(":") + 1)) });
		}
	}
	return { distro, exitCode: result.exitCode, ...stats };
}

// -- configuration files -----------------------------------------------------

/** Known `.wslconfig` keys; the panel renders exactly these in its form view. */
export const GLOBAL_SCHEMA = [
	{ section: "wsl2", key: "memory", type: "string", hint: "8GB", label: { en: "Memory limit", zh: "内存上限" } },
	{ section: "wsl2", key: "processors", type: "number", hint: "4", label: { en: "Virtual processors", zh: "虚拟处理器数" } },
	{ section: "wsl2", key: "swap", type: "string", hint: "2GB", label: { en: "Swap size", zh: "交换空间大小" } },
	{ section: "wsl2", key: "swapFile", type: "string", label: { en: "Swap file", zh: "交换文件路径" } },
	{ section: "wsl2", key: "networkingMode", type: "enum", options: ["NAT", "Mirrored", "VirtioProxy"], label: { en: "Networking mode", zh: "网络模式" } },
	{ section: "wsl2", key: "localhostForwarding", type: "bool", label: { en: "localhost forwarding", zh: "localhost 端口转发" } },
	{ section: "wsl2", key: "dnsTunneling", type: "bool", label: { en: "DNS tunneling", zh: "DNS 隧道" } },
	{ section: "wsl2", key: "autoProxy", type: "bool", label: { en: "Auto proxy", zh: "自动代理" } },
	{ section: "wsl2", key: "firewall", type: "bool", label: { en: "Hyper-V firewall", zh: "Hyper-V 防火墙" } },
	{ section: "wsl2", key: "nestedVirtualization", type: "bool", label: { en: "Nested virtualization", zh: "嵌套虚拟化" } },
	{ section: "wsl2", key: "vmIdleTimeout", type: "number", hint: "60000", label: { en: "VM idle timeout (ms)", zh: "虚拟机空闲超时(ms)" } },
	{ section: "wsl2", key: "defaultVhdSize", type: "string", hint: "1TB", label: { en: "Default VHD size", zh: "默认虚拟磁盘大小" } },
	{ section: "experimental", key: "autoMemoryReclaim", type: "enum", options: ["disabled", "gradual", "dropcache"], label: { en: "Auto memory reclaim", zh: "自动回收内存" } },
	{ section: "experimental", key: "sparseVhd", type: "bool", label: { en: "Sparse VHD", zh: "稀疏虚拟磁盘" } },
	{ section: "experimental", key: "hostAddressLoopback", type: "bool", label: { en: "Host address loopback", zh: "主机地址回环" } },
	{ section: "experimental", key: "bestEffortDnsParsing", type: "bool", label: { en: "Best-effort DNS parsing", zh: "尽力解析 DNS" } },
	{ section: "experimental", key: "ignoredPorts", type: "string", hint: "80,443", label: { en: "Ignored ports", zh: "忽略的端口" } },
	{ section: "experimental", key: "useWindowsDnsCache", type: "bool", label: { en: "Use Windows DNS cache", zh: "使用 Windows DNS 缓存" } }
];

/** Known `/etc/wsl.conf` keys. */
export const WSLCONF_SCHEMA = [
	{ section: "boot", key: "systemd", type: "bool", label: { en: "systemd", zh: "启用 systemd" } },
	{ section: "boot", key: "command", type: "string", hint: "/usr/local/bin/start.sh", label: { en: "Boot command", zh: "启动命令" } },
	{ section: "interop", key: "enabled", type: "bool", label: { en: "Windows interop", zh: "Windows 互操作" } },
	{ section: "interop", key: "appendWindowsPath", type: "bool", label: { en: "Append Windows PATH", zh: "追加 Windows PATH" } },
	{ section: "user", key: "default", type: "string", hint: "hugo", label: { en: "Default user", zh: "默认用户" } },
	{ section: "automount", key: "enabled", type: "bool", label: { en: "Automount Windows drives", zh: "自动挂载 Windows 磁盘" } },
	{ section: "automount", key: "mountFsTab", type: "bool", label: { en: "Mount /etc/fstab", zh: "挂载 /etc/fstab" } },
	{ section: "automount", key: "root", type: "string", hint: "/mnt/", label: { en: "Mount root", zh: "挂载根目录" } },
	{ section: "automount", key: "options", type: "string", hint: "metadata,umask=22,fmask=11", label: { en: "Mount options", zh: "挂载选项" } },
	{ section: "network", key: "hostname", type: "string", label: { en: "Hostname", zh: "主机名" } },
	{ section: "network", key: "generateHosts", type: "bool", label: { en: "Generate /etc/hosts", zh: "生成 /etc/hosts" } },
	{ section: "network", key: "generateResolvConf", type: "bool", label: { en: "Generate /etc/resolv.conf", zh: "生成 /etc/resolv.conf" } }
];

/** The global config lives on the Windows side; the profile directory is the same one wsl.exe reads. */
export function globalConfigPath() {
	return join(homedir(), ".wslconfig");
}

/** Parse an INI file into sections and their `key=value` rows, keeping line numbers. */
export function parseIni(text) {
	const newline = /\r\n/.test(text) ? "\r\n" : "\n";
	const lines = text.length === 0 ? [] : text.split(/\r?\n/);
	const sections = [];
	let current = null;
	lines.forEach((line, index) => {
		const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
		if (header !== null) {
			current = { name: header[1].trim(), headerLine: index, entries: [] };
			sections.push(current);
			return;
		}
		const entry = /^\s*([^=#;\[\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
		if (entry !== null && current !== null) {
			current.entries.push({ key: entry[1].trim().toLowerCase(), value: entry[2], line: index });
		}
	});
	return { newline, lines, sections };
}

/** The value of `section.key`, or undefined. */
export function readIniValue(parsed, section, key) {
	const block = parsed.sections.find((candidate) => candidate.name.toLowerCase() === section.toLowerCase());
	if (block === undefined) return undefined;
	const entry = block.entries.find((candidate) => candidate.key === key.toLowerCase());
	return entry?.value;
}

/**
 * Apply `{section, key, value}` edits to an INI text.
 *
 * A `null` value removes the key. Unknown sections are appended, unknown keys are
 * inserted at the end of their section, and every line the edits do not name is
 * preserved byte for byte — the comments and the keys this plugin does not model
 * survive a round trip.
 */
export function applyIniEdits(text, edits) {
	let { newline, lines } = parseIni(text);
	if (lines.length === 0) lines = [];
	for (const edit of edits) {
		const sectionName = String(edit.section ?? "").trim();
		const key = String(edit.key ?? "").trim();
		const value = edit.value === null || edit.value === undefined ? null : String(edit.value).trim();
		if (sectionName.length === 0 || key.length === 0) continue;
		const parsed = parseIni(lines.join(newline));
		let block = parsed.sections.find((candidate) => candidate.name.toLowerCase() === sectionName.toLowerCase());
		if (block === undefined) {
			if (value === null) continue;
			if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
			lines.push(`[${sectionName}]`, `${key}=${value}`);
			continue;
		}
		const entry = block.entries.find((candidate) => candidate.key === key.toLowerCase());
		if (value === null) {
			if (entry !== undefined) lines.splice(entry.line, 1);
			continue;
		}
		if (entry !== undefined) {
			lines[entry.line] = `${key}=${value}`;
			continue;
		}
		// Insert after the section's last key, or right after the header when it has none.
		const lastKey = block.entries.length > 0 ? block.entries[block.entries.length - 1].line : block.headerLine;
		lines.splice(lastKey + 1, 0, `${key}=${value}`);
	}
	let result = lines.join(newline);
	if (result.length > 0 && !result.endsWith(newline)) result += newline;
	return result;
}

/** Read one configuration file: `{ text, exists, path }`. */
export async function readConfig({ scope, distro }) {
	if (scope === "global") {
		const path = globalConfigPath();
		try {
			return { scope, path, exists: true, text: await readFile(path, "utf8") };
		} catch (error) {
			if (error?.code === "ENOENT") return { scope, path, exists: false, text: "" };
			throw error;
		}
	}
	const result = await runInWsl({ distro, asRoot: true, script: "test -f /etc/wsl.conf && cat /etc/wsl.conf || true", timeoutMs: 20_000 });
	return { scope, distro, path: "/etc/wsl.conf", exists: result.stdout.trim().length > 0, text: result.stdout };
}

/** The form model for one file: every known key plus its current value. */
export function configFields(scope, text) {
	const schema = scope === "global" ? GLOBAL_SCHEMA : WSLCONF_SCHEMA;
	const parsed = parseIni(text);
	return schema.map((field) => {
		const value = readIniValue(parsed, field.section, field.key);
		return { ...field, present: value !== undefined, value: value ?? "" };
	});
}

/**
 * Write one configuration file atomically (Windows side) or through Linux root.
 *
 * The form view regenerates lines, so it normalises endings; the raw view is
 * saved byte for byte, because it is the user's own text and rewriting it would
 * turn a harmless save into a surprise diff.
 */
export async function writeConfig({ scope, distro, text, verbatim = false }) {
	const normalized = verbatim ? text : text.replace(/\r\n/g, "\n").replace(/\n*$/, "\n");
	if (scope === "global") {
		const path = globalConfigPath();
		const temporary = `${path}.wsl-sidebar.tmp`;
		await mkdir(dirname(path), { recursive: true });
		await writeFile(temporary, normalized, "utf8");
		await rename(temporary, path);
		return { path, bytes: Buffer.byteLength(normalized, "utf8") };
	}
	const result = await runInWsl({ distro, asRoot: true, script: "cat > /etc/wsl.conf", input: normalized, timeoutMs: 20_000 });
	if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `cannot write /etc/wsl.conf (exit ${result.exitCode})`);
	return { path: "/etc/wsl.conf", bytes: Buffer.byteLength(normalized, "utf8") };
}

/** Whether an export target already exists (the panel refuses to overwrite silently). */
export async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * wsl.exe plumbing shared by the sidebar's own tools.
 *
 * Everything here works one level below the plugin: it turns a distro name, a
 * session working directory and a shell script into a single `wsl.exe` call, so
 * a tool never needs the host's Windows sandbox or an ops_* helper to reach the
 * Linux side. Commands always run as native Linux commands inside the chosen
 * distribution.
 */
import { execFile, spawn } from "node:child_process";

/** Where the sidebar's tools land when no workdir is known. */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
/** Console output ceiling per stream; a larger result is cut and flagged. */
export const MAX_OUTPUT_BYTES = 1 << 21;

/** A short-lived cache, so a panel full of tools does not spawn `wsl -l` each time. */
let distroCache = { at: 0, names: [] };
const DISTRO_CACHE_MS = 5000;

/** Quote one shell word for bash: `it's` -> `'it'\''s'`. */
export function shq(value) {
	return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** Split `\\server\share\rest` into server and tail, or null when it is not a UNC path. */
function splitUnc(path) {
	if (!path.startsWith("\\\\")) return null;
	let rest = path.slice(2);
	if (rest.startsWith("?\\")) rest = rest.slice(2);
	const cut = rest.indexOf("\\");
	const server = cut === -1 ? rest : rest.slice(0, cut);
	const tail = cut === -1 ? "" : rest.slice(cut + 1);
	if (server.toLowerCase() !== "wsl.localhost" && server.toLowerCase() !== "wsl$") return null;
	return { server, tail };
}

/**
 * The distro named by a Windows path, if the path points into WSL.
 * `\\wsl.localhost\Ubuntu-24.04\home` and `\\wsl$\Ubuntu\home` both qualify.
 */
export function distroFromWindowsPath(path) {
	if (typeof path !== "string") return null;
	const unc = splitUnc(path);
	if (unc === null) return null;
	const cut = unc.tail.indexOf("\\");
	const name = cut === -1 ? unc.tail : unc.tail.slice(0, cut);
	return name.length === 0 ? null : name;
}

/**
 * Translate a Windows path to the Linux path the same location has behind `/`.
 * UNC WSL paths and drive letters both work; a Linux path is returned as-is.
 */
export function linuxPathFromWindows(path) {
	if (typeof path !== "string" || path.length === 0) return null;
	const unc = splitUnc(path);
	if (unc !== null) {
		const cut = unc.tail.indexOf("\\");
		const rest = (cut === -1 ? "" : unc.tail.slice(cut + 1)).replace(/\\/g, "/").replace(/\/+$/, "");
		return rest.length === 0 ? "/" : `/${rest}`;
	}
	const drive = /^([A-Za-z]):([\\/](.*))?$/.exec(path);
	if (drive !== null) {
		const rest = (drive[3] ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
		return `/mnt/${drive[1].toLowerCase()}${rest.length === 0 ? "" : `/${rest}`}`;
	}
	if (path.startsWith("/") || path.startsWith("~")) return path;
	return null;
}

/** `wsl.exe -l -q`, decoded from its UTF-16LE output. */
export function listDistros() {
	return new Promise((resolve, reject) => {
		execFile(
			"wsl.exe",
			["-l", "-q"],
			{ encoding: "buffer", windowsHide: true, maxBuffer: 1 << 20, timeout: 15000 },
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				const names = stdout
					.toString("utf16le")
					.split(/\0|\r\n|\n|\r/)
					.map((line) => line.trim())
					.filter((line) => line.length > 0 && !line.startsWith("Forbidden") && !/windows/i.test(line));
				distroCache = { at: Date.now(), names };
				resolve(names);
			},
		);
	});
}

/** The registered distro names, cached for a few seconds. */
export async function knownDistros() {
	if (Date.now() - distroCache.at <= DISTRO_CACHE_MS) return distroCache.names;
	try {
		return await listDistros();
	} catch {
		return distroCache.names;
	}
}

/** The working directory the current tool call belongs to, when the host exposes it. */
export function sessionCwd(exec) {
	const cwd = exec?.agent?.session?.header?.cwd;
	return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}

/**
 * Which distribution a call belongs in.
 *
 * An explicit argument wins, then the distribution the session's own workspace
 * lives in (so a `\\wsl.localhost\Ubuntu-24.04\...` workspace never runs in
 * another distro), then nothing — in which case wsl.exe's default answers.
 *
 * @returns the distro name (null for "the default") and why it was chosen.
 */
export async function resolveDistro({ explicit, cwd } = {}) {
	const available = await knownDistros();
	const pick = (value) => available.find((name) => name.toLowerCase() === String(value).toLowerCase());
	if (typeof explicit === "string" && explicit.trim().length > 0) {
		const match = pick(explicit.trim());
		if (match === undefined) {
			throw new Error(
				`unknown WSL distribution "${explicit}". Installed: ${available.length === 0 ? "(none)" : available.join(", ")}`,
			);
		}
		return { distro: match, source: "argument" };
	}
	const fromCwd = distroFromWindowsPath(cwd);
	if (fromCwd !== null) {
		const match = pick(fromCwd);
		if (match !== undefined) return { distro: match, source: "workspace" };
	}
	// A Windows-path session has no distribution of its own; one explicit setting
	// keeps a multi-distro user from silently landing in wsl.exe's default.
	const configured = process.env.DSH_WSL_DISTRO;
	if (typeof configured === "string" && configured.trim().length > 0) {
		const match = pick(configured.trim());
		if (match !== undefined) return { distro: match, source: "environment" };
	}
	return { distro: null, source: "default" };
}

/** The environment one wsl.exe call runs with: UTF-8 both ways, no WSLENV leakage. */
export function wslEnv(extra) {
	const merged = { ...process.env, ...extra, WSL_UTF8: "1" };
	delete merged.WSLENV;
	return merged;
}

/**
 * The argv one wsl.exe call needs.
 *
 * The script travels as ONE argv element, so nothing can re-quote it on the way
 * through cmd.exe; `--cd` carries the Linux working directory so a caller never
 * has to prefix a `cd`; `-u root` is the Linux root account, which wsl.exe hands
 * out without elevating the Windows process.
 */
export function buildWslArgs({ distro, script, cwdUnix, asRoot, mode = "script" }) {
	const args = [];
	if (distro !== null && distro !== undefined) args.push("-d", distro);
	if (typeof cwdUnix === "string" && cwdUnix.length > 0) args.push("--cd", cwdUnix);
	if (asRoot === true) args.push("-u", "root");
	if (mode === "shell") args.push("-e", "bash", "-i");
	else args.push("-e", "bash", "-lc", script);
	return args;
}

/**
 * Run one bash script inside a distribution.
 *
 * The script travels as a single argv element, so nothing is re-quoted by
 * cmd.exe, and `WSL_UTF8=1` makes both streams UTF-8.
 *
 * @returns exit code, both streams (capped), and whether the timeout killed it.
 */
export function runInWsl({ distro, script, cwdUnix, asRoot, timeoutMs = DEFAULT_TIMEOUT_MS, env = {}, input = undefined }) {
	const args = buildWslArgs({ distro, script, cwdUnix, asRoot, mode: "script" });
	const limit = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
	return new Promise((resolve, reject) => {
		const child = spawn("wsl.exe", args, {
			env: wslEnv(env),
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const out = [];
		const err = [];
		let outBytes = 0;
		let errBytes = 0;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, limit);
		child.stdout.on("data", (chunk) => {
			if (outBytes >= MAX_OUTPUT_BYTES) return;
			const room = Math.min(chunk.length, MAX_OUTPUT_BYTES - outBytes);
			outBytes += room;
			out.push(room === chunk.length ? chunk : chunk.subarray(0, room));
		});
		child.stderr.on("data", (chunk) => {
			if (errBytes >= MAX_OUTPUT_BYTES) return;
			const room = Math.min(chunk.length, MAX_OUTPUT_BYTES - errBytes);
			errBytes += room;
			err.push(room === chunk.length ? chunk : chunk.subarray(0, room));
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				distro: distro ?? null,
				exitCode: typeof code === "number" ? code : -1,
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
				timedOut,
				truncated: outBytes >= MAX_OUTPUT_BYTES || errBytes >= MAX_OUTPUT_BYTES,
			});
		});
		if (input !== undefined) {
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		}
	});
}

/** The failure text a tool raises for a non-zero exit, trimmed for the model. */
export function failureText(prefix, result) {
	const detail = (result.stderr || result.stdout).trim();
	const head = result.timedOut
		? `${prefix}: timed out after the tool deadline`
		: `${prefix}: exit code ${result.exitCode}`;
	return detail.length === 0 ? head : `${head}\n${detail}`;
}

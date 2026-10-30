/**
 * Host half of the WSL sidebar plugin.
 *
 * It owns three webServer routes (distro list, one-directory listing, the panel's
 * diagnostic sink) and the self-contained `wslx-*` tools, so installing this one
 * plugin is enough to browse and operate WSL: no dsh-wsl-tool, no ops_* call and
 * no Windows sandbox sits between a tool and the distribution.
 */
import { readdir } from "node:fs/promises";
import { listDistros } from "./lib/wsl.js";
import { AdminActionDenied, guardAdminAction } from "./lib/policy.js";
import { createTools } from "./lib/tools.js";
import { killAllTasks } from "./lib/tasks.js";
import {
	applyIniEdits,
	configFields,
	distroState,
	distroStats,
	exists,
	listVerbose,
	readConfig,
	runWslExe,
	writeConfig,
	wslSummary
} from "./lib/admin.js";

export const inject = ["webServer", "connection", "tools"];

const DISTROS_PATH = "/__wsl_plugin__/distros";
const LIST_PREFIX = "/__wsl_plugin__/list";
const LOG_PATH = "/__wsl_plugin__/log";
const ADMIN_DISTROS_PATH = "/__wsl_plugin__/admin/distros";
const ADMIN_ACTION_PATH = "/__wsl_plugin__/admin/action";
const ADMIN_CONFIG_PATH = "/__wsl_plugin__/admin/config";
const ADMIN_STATUS_PATH = "/__wsl_plugin__/admin/status";
const PLATFORM_PATH = "/__wsl_plugin__/platform";

/** WSL is a Windows feature; everything this plugin does spawns wsl.exe. */
const WINDOWS = process.platform === "win32";

/** The composition's connection service (typed locally; its package is browser-side). */
function connectionOf(ctx) {
	return Reflect.get(ctx, "connection");
}

function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", "no-store");
	res.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(res, allow) {
	res.statusCode = 405;
	res.setHeader("allow", allow);
	res.end();
}

/** Answer an untrusted/unauthenticated request; true when it was rejected. */
function rejected(ctx, req, res) {
	const connection = connectionOf(ctx);
	const rejection = connection?.requestRejection?.(req);
	if (rejection === undefined || rejection === null || rejection === 0) return false;
	res.statusCode = rejection;
	res.end();
	return true;
}

/** A request the caller got wrong: answered with 400 instead of 500. */
class BadInput extends Error {}

/** Distro names are single UNC path segments; keep them conservative. */
function validDistro(name) {
	return /^[A-Za-z0-9][A-Za-z0-9 ._()-]*$/.test(name);
}

/** Split a relative POSIX path into segments, rejecting traversal. */
function splitRelPath(raw) {
	const segments = String(raw ?? "").split("/").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
	if (segments.some((segment) => segment === "." || segment === ".." || /[:\\]/.test(segment))) return null;
	return segments;
}

/** Read a JSON request body; the panel only ever sends small documents. */
async function readJsonBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > 1 << 20) throw new Error("request body larger than 1 MiB");
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	return text.trim().length === 0 ? {} : JSON.parse(text);
}

export function apply(ctx) {
	// Every route below spawns wsl.exe, which only exists on Windows. The platform
	// route stays mounted everywhere so the panel can say why it is empty instead of
	// showing a page full of spawn ENOENT failures.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: PLATFORM_PATH,
		handler: async (req, res) => {
			if (rejected(ctx, req, res)) return;
			if (req.method !== "GET") {
				sendMethodNotAllowed(res, "GET");
				return;
			}
			sendJson(res, 200, { platform: process.platform, supported: WINDOWS });
		}
	}), `wsl-sidebar: GET ${PLATFORM_PATH}`);

	if (!WINDOWS) {
		console.error(`[wsl-sidebar] WSL only exists on Windows; the panel is inert on ${process.platform}`);
		return;
	}

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: DISTROS_PATH,
		handler: async (req, res) => {
			if (rejected(ctx, req, res)) return;
			if (req.method !== "GET") {
				sendMethodNotAllowed(res, "GET");
				return;
			}
			try {
				sendJson(res, 200, { distros: await listDistros() });
			} catch (error) {
				sendJson(res, 500, { code: "wsl-unavailable", message: String(error?.message ?? error) });
			}
		}
	}), `wsl-sidebar: GET ${DISTROS_PATH}`);

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: LOG_PATH,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendMethodNotAllowed(res, "POST");
				return;
			}
			try {
				const chunks = [];
				for await (const chunk of req) chunks.push(chunk);
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
				console.error(`[wsl-sidebar] ${String(body?.kind ?? "?")}: ${JSON.stringify(body?.detail ?? {})}`);
				sendJson(res, 200, { ok: true });
			} catch (error) {
				sendJson(res, 400, { ok: false, message: String(error?.message ?? error) });
			}
		}
	}), `wsl-sidebar: POST ${LOG_PATH}`);

	// prefix route: /__wsl_plugin__/list/<distro>/<posix/sub/path>
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: LIST_PREFIX,
		handler: async (req, res) => {
			if (rejected(ctx, req, res)) return;
			if (req.method !== "GET") {
				sendMethodNotAllowed(res, "GET");
				return;
			}
			const pathname = new URL(String(req.url), "http://localhost").pathname;
			const rest = decodeURIComponent(pathname.slice(LIST_PREFIX.length)).replace(/^\//, "");
			const slash = rest.indexOf("/");
			const distro = slash === -1 ? rest : rest.slice(0, slash);
			const rel = slash === -1 ? "" : rest.slice(slash + 1);
			if (!validDistro(distro)) {
				sendJson(res, 400, { code: "bad-distro", message: `invalid distro name: ${distro}` });
				return;
			}
			const segments = splitRelPath(rel);
			if (segments === null) {
				sendJson(res, 400, { code: "bad-path", message: "path must not contain traversal or separators" });
				return;
			}
			// The 9p share only exists while the distribution runs, so listing a
			// stopped one would boot it. Say so instead of starting it behind the
			// user's back.
			const state = await distroState(distro);
			if (state !== "running") {
				sendJson(res, 409, { code: "distro-stopped", distro, state, message: `this distribution is not running (${state})` });
				return;
			}
			const unc = `\\\\wsl.localhost\\${distro}` + (segments.length > 0 ? `\\${segments.join("\\")}` : "");
			try {
				const dirents = await readdir(unc, { withFileTypes: true });
				const entries = dirents
					.map((dirent) => ({ name: dirent.name, dir: dirent.isDirectory() }))
					.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
				sendJson(res, 200, { distro, path: segments, unc, entries });
			} catch (error) {
				sendJson(res, 200, { distro, path: segments, unc, entries: [], error: String(error?.code ?? error?.message ?? error) });
			}
		}
	}), `wsl-sidebar: GET ${LIST_PREFIX}<distro>[/<path>]`);

	// -- administration: distro lifecycle, configuration files, runtime numbers --
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ADMIN_DISTROS_PATH,
		handler: async (req, res) => {
			if (rejected(ctx, req, res)) return;
			if (req.method !== "GET") {
				sendMethodNotAllowed(res, "GET");
				return;
			}
			try {
				const rows = await listVerbose();
				sendJson(res, 200, { distros: rows, default: rows.find((row) => row.isDefault)?.name ?? null });
			} catch (error) {
				sendJson(res, 500, { code: "wsl-unavailable", message: String(error?.message ?? error) });
			}
		}
	}), `wsl-sidebar: GET ${ADMIN_DISTROS_PATH}`);

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ADMIN_ACTION_PATH,
		handler: async (req, res) => {
			if (rejected(ctx, req, res)) return;
			if (req.method !== "POST") {
				sendMethodNotAllowed(res, "POST");
				return;
			}
			let body;
			try {
				body = await readJsonBody(req);
			} catch (error) {
				sendJson(res, 400, { code: "bad-request", message: String(error?.message ?? error) });
				return;
			}
			const action = String(body?.action ?? "");
			const distro = body?.distro === undefined || body?.distro === null ? null : String(body.distro);
			try {
				if (distro !== null && !validDistro(distro)) {
					sendJson(res, 400, { code: "bad-distro", message: `invalid distro name: ${distro}` });
					return;
				}
				let args;
				switch (action) {
					case "start":
						if (distro === null) throw new BadInput("start needs a distro");
						args = ["-d", distro, "-e", "true"];
						break;
					case "terminate":
						if (distro === null) throw new BadInput("terminate needs a distro");
						args = ["--terminate", distro];
						break;
					case "set-default":
						if (distro === null) throw new BadInput("set-default needs a distro");
						args = ["--set-default", distro];
						break;
					case "set-version": {
						if (distro === null) throw new BadInput("set-version needs a distro");
						const version = Number(body?.version);
						if (version !== 1 && version !== 2) throw new BadInput("version must be 1 or 2");
						args = ["--set-version", distro, String(version)];
						break;
					}
					case "export": {
						if (distro === null) throw new BadInput("export needs a distro");
						const target = String(body?.path ?? "").trim();
						if (!/^[A-Za-z]:[\\/]/.test(target)) throw new BadInput("export needs an absolute Windows path");
						if ((await exists(target)) && body?.overwrite !== true) {
							sendJson(res, 409, { ok: false, code: "exists", message: `${target} already exists` });
							return;
						}
						args = body?.vhd === true ? ["--export", distro, target, "--vhd"] : ["--export", distro, target];
						break;
					}
					case "shutdown":
						args = ["--shutdown"];
						break;
					default:
						sendJson(res, 400, { code: "bad-action", message: `unknown action: ${action}` });
						return;
				}
				// A well-formed request still asks first when the deployment is
				// restricted: the 403 arrives before any wsl.exe call, and the panel
				// repeats the same request with `acknowledge` once the user agrees.
				try {
					guardAdminAction(ctx, action, body);
				} catch (error) {
					if (!(error instanceof AdminActionDenied)) throw error;
					console.error(`[wsl-sidebar] admin ${action} needs acknowledgement (deployment mode ${error.mode ?? "unknown"})`);
					sendJson(res, 403, {
						ok: false,
						action,
						code: "needs-acknowledge",
						mode: error.mode ?? null,
						message: String(error.message)
					});
					return;
				}
				// An export copies a whole distribution to disk: give it its own budget.
				const result = await runWslExe(args, action === "export" ? { timeoutMs: 30 * 60 * 1000 } : undefined);
				const ok = result.exitCode === 0;
				console.error(`[wsl-sidebar] admin ${action}${distro === null ? "" : " " + distro}: exit ${result.exitCode}${ok ? "" : " " + (result.stderr || result.stdout).trim().slice(0, 300)}`);
				sendJson(res, ok ? 200 : 500, {
					ok,
					action,
					distro,
					command: `wsl.exe ${args.join(" ")}`,
					exitCode: result.exitCode,
					stdout: result.stdout.trim(),
					stderr: result.stderr.trim()
				});
			} catch (error) {
				const bad = error instanceof BadInput;
				sendJson(res, bad ? 400 : 500, {
					ok: false,
					action,
					code: bad ? "bad-request" : "action-failed",
					message: String(error?.message ?? error)
				});
			}
		}
	}), `wsl-sidebar: POST ${ADMIN_ACTION_PATH}`);

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ADMIN_CONFIG_PATH,
		handler: async (req, res) => {
			if (rejected(ctx, req, res)) return;
			const url = new URL(String(req.url), "http://localhost");
			const rawScope = url.searchParams.get("scope");
			const scope = rawScope === null || rawScope.length === 0 ? "global" : rawScope;
			const rawDistro = url.searchParams.get("distro");
			const distro = rawDistro === null || rawDistro.length === 0 ? null : rawDistro;
			try {
				if (scope !== "global" && scope !== "distro") {
					sendJson(res, 400, { code: "bad-scope", message: `unknown scope: ${scope}` });
					return;
				}
				if (scope === "distro" && (distro === null || !validDistro(distro))) {
					sendJson(res, 400, { code: "bad-distro", message: "distro scope needs a valid distro name" });
					return;
				}
				if (req.method === "GET") {
					const config = await readConfig({ scope, distro: distro ?? undefined });
					sendJson(res, 200, {
						scope,
						distro,
						path: config.path,
						exists: config.exists,
						text: config.text,
						state: config.state ?? null,
						fields: configFields(scope, config.text)
					});
					return;
				}
				if (req.method !== "POST") {
					sendMethodNotAllowed(res, "GET, POST");
					return;
				}
				const body = await readJsonBody(req);
				const current = await readConfig({ scope, distro: distro ?? undefined });
				let next;
				if (body?.mode === "fields") {
					const edits = Array.isArray(body?.edits)
						? body.edits.map((edit) => {
							const value = edit?.value;
							return {
								section: String(edit?.section ?? ""),
								key: String(edit?.key ?? ""),
								value: value === null || value === undefined || String(value).trim() === "" ? null : String(value)
							};
						})
						: [];
					next = applyIniEdits(current.text, edits);
				} else {
					next = String(body?.text ?? "");
				}
				if (next.length > 64 * 1024) {
					sendJson(res, 413, { ok: false, code: "too-large", message: "configuration is larger than 64 KiB" });
					return;
				}
				const written = await writeConfig({ scope, distro: distro ?? undefined, text: next, verbatim: body?.mode !== "fields" });
				console.error(`[wsl-sidebar] config write ${scope}${distro === null ? "" : " " + distro}: ${written.path} (${written.bytes} bytes, backup ${written.backup ?? "none"})`);
				sendJson(res, 200, {
					ok: true,
					scope,
					distro,
					path: written.path,
					backup: written.backup ?? null,
					bytes: written.bytes,
					text: next,
					fields: configFields(scope, next),
					needsRestart: true
				});
			} catch (error) {
				const message = String(error?.message ?? error);
				if (error?.code === "distro-stopped") {
					sendJson(res, 409, { ok: false, code: "distro-stopped", message });
					return;
				}
				sendJson(res, 500, { ok: false, message });
			}
		}
	}), `wsl-sidebar: GET/POST ${ADMIN_CONFIG_PATH}`);

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ADMIN_STATUS_PATH,
		handler: async (req, res) => {
			if (rejected(ctx, req, res)) return;
			if (req.method !== "GET") {
				sendMethodNotAllowed(res, "GET");
				return;
			}
			try {
				const [rows, summary] = await Promise.all([listVerbose(), wslSummary()]);
				const distros = await Promise.all(rows.map(async (row) => {
					if (row.state !== "running") return { ...row, stats: null };
					try {
						return { ...row, stats: await distroStats(row.name) };
					} catch (error) {
						return { ...row, stats: null, error: String(error?.message ?? error) };
					}
				}));
				sendJson(res, 200, { distros, wsl: summary });
			} catch (error) {
				sendJson(res, 500, { code: "wsl-unavailable", message: String(error?.message ?? error) });
			}
		}
	}), `wsl-sidebar: GET ${ADMIN_STATUS_PATH}`);

	// The plugin's own tools: they keep the sidebar self-contained, so an agent can
	// run commands and touch files in any distribution without another plugin.
	ctx.effect(() => {
		const disposers = createTools(ctx).map((tool) => ctx.tools.register(tool));
		return () => {
			for (const dispose of disposers.reverse()) dispose?.();
		};
	}, "wsl-sidebar: wslx tools");

	// Background tasks outlive a request; without this they would keep running (up
	// to their 12 h ceiling) after the plugin is reloaded or removed.
	ctx.effect(() => () => {
		const stopped = killAllTasks();
		if (stopped > 0) console.error(`[wsl-sidebar] stopped ${stopped} background task(s) on dispose`);
	}, "wsl-sidebar: stop background tasks on dispose");
}

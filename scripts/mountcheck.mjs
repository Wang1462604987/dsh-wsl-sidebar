/**
 * Mount the host half against a fake Cordis context and exercise the gate.
 *
 *   node scripts/mountcheck.mjs
 *
 * It catches what the self-check cannot: whether `apply()` still wires the tools
 * and whether the permission gate receives the session policy through the real
 * call path. No DSH process, no real web server, and it never lets a destructive
 * command reach a shell.
 */
import { readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { apply } from "../index.js";

const tools = new Map();
const routes = new Map();
const disposers = [];
const policies = { mode: "workspace-write" };

const ctx = {
	effect(fn) {
		disposers.push(fn());
		return () => {};
	},
	webServer: {
		register(route) {
			routes.set(route.path, route);
			return () => {};
		},
	},
	tools: {
		register(tool) {
			tools.set(tool.name, tool);
			return () => {};
		},
	},
	get(name) {
		if (name === "sandboxPolicy") return { resolve: () => ({ mode: policies.mode, workspaceRoot: "E:\\project\\dsh-plug" }) };
		return undefined;
	},
	on() {},
};

apply(ctx);

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  (${detail})`}`);
	if (!ok) failures.push(name);
};
const messageOf = async (run) => {
	try {
		await run();
		return null;
	} catch (error) {
		return String(error?.message ?? error);
	}
};

check("apply mounts six tools", tools.size === 6, [...tools.keys()].join(","));
check("routes registered", routes.size === 8, [...routes.keys()].join(","));
check(
	"console routes are exact paths",
	["/__wsl_plugin__/platform", "/__wsl_plugin__/admin/distros", "/__wsl_plugin__/admin/action", "/__wsl_plugin__/admin/config", "/__wsl_plugin__/admin/status"].every(
		(path) => routes.get(path)?.kind === "exact",
	),
);

const run = tools.get("wslx-run");
const write = tools.get("wslx-write");
const bg = tools.get("wslx-bg");
const exec = { agent: { session: { header: { cwd: "\\\\wsl.localhost\\Ubuntu-24.04\\home\\hugo" } } }, callId: "call-1" };

// workspace-write: every escalation must fail closed, and nothing may execute.
const rootGate = await messageOf(() => run.execute({ command: "id -u", asRoot: true }, exec));
check("asRoot needs approval in workspace-write", /or a user approval/.test(rootGate ?? ""), (rootGate ?? "no error").slice(0, 80));

const fileGate = await messageOf(() => write.execute({ path: "/root/wslx-should-not-exist.txt", content: "x", asRoot: true }, exec));
check("file tools are gated too", /or a user approval/.test(fileGate ?? ""), (fileGate ?? "no error").slice(0, 60));

const bgGate = await messageOf(() => bg.execute({ action: "start", command: "id -u", asRoot: true }, exec));
check("background start is gated too", /or a user approval/.test(bgGate ?? ""), (bgGate ?? "no error").slice(0, 60));

const guardGate = await messageOf(() => run.execute({ command: "rm -rf /", allowDangerous: true }, exec));
check("allowDangerous still needs authority", /or a user approval/.test(guardGate ?? ""), (guardGate ?? "no error").slice(0, 80));

const plainGuard = await messageOf(() => run.execute({ command: "rm -rf /" }, exec));
check("guard refuses without allowDangerous", /refusing a destructive command/.test(plainGuard ?? ""), (plainGuard ?? "no error").slice(0, 60));

const ordinary = await messageOf(() => run.execute({ command: "true" }, exec));
check("ordinary command still runs without escalation", ordinary === null, String(ordinary).slice(0, 60));

// danger-full-access: the same root call goes through, no prompt.
policies.mode = "danger-full-access";
const rootOut = await run.execute({ command: "id -u", asRoot: true }, exec);
check("asRoot runs under danger-full-access", rootOut.text.trimEnd().endsWith("0"), rootOut.text.trim().split("\n").pop());

// ---- console routes: drive them the way the web server does -----------------
function fakeRequest({ method = "GET", url = "/", body = undefined }) {
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
	return {
		method,
		url,
		headers: {},
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk;
		},
	};
}

function fakeResponse() {
	const headers = {};
	return {
		statusCode: 0,
		headers,
		body: "",
		setHeader(name, value) {
			headers[name.toLowerCase()] = value;
		},
		end(payload) {
			this.body = payload ?? "";
		},
	};
}

async function callRoute(path, request) {
	const route = routes.get(path);
	if (route === undefined) throw new Error(`route not registered: ${path}`);
	const response = fakeResponse();
	await route.handler(request, response);
	let json = null;
	try {
		json = JSON.parse(response.body);
	} catch {
		json = null;
	}
	return { status: response.statusCode, json, text: response.body, headers: response.headers };
}

const ADMIN_DISTROS = "/__wsl_plugin__/admin/distros";
const ADMIN_ACTION = "/__wsl_plugin__/admin/action";
const ADMIN_CONFIG = "/__wsl_plugin__/admin/config";
const ADMIN_STATUS = "/__wsl_plugin__/admin/status";

const distrosResponse = await callRoute(ADMIN_DISTROS, fakeRequest({ url: ADMIN_DISTROS }));
check("admin/distros lists distributions", distrosResponse.status === 200 && Array.isArray(distrosResponse.json?.distros) && distrosResponse.json.distros.length > 0, `status ${distrosResponse.status}`);
check("admin/distros reports the default", typeof distrosResponse.json?.default === "string", String(distrosResponse.json?.default));

const methodResponse = await callRoute(ADMIN_DISTROS, fakeRequest({ method: "POST", url: ADMIN_DISTROS }));
check("admin/distros rejects POST with 405", methodResponse.status === 405 && methodResponse.headers.allow === "GET", `status ${methodResponse.status}`);

const configGlobal = await callRoute(ADMIN_CONFIG, fakeRequest({ url: `${ADMIN_CONFIG}?scope=global` }));
check("admin/config reads .wslconfig", configGlobal.status === 200 && Array.isArray(configGlobal.json?.fields) && configGlobal.json.fields.length > 8, `fields ${configGlobal.json?.fields?.length}`);
check("admin/config parses existing values", configGlobal.json?.fields?.some((field) => field.present) === true, `fields ${configGlobal.json?.fields?.length}`);

const configDistro = await callRoute(ADMIN_CONFIG, fakeRequest({ url: `${ADMIN_CONFIG}?scope=distro&distro=Ubuntu-24.04` }));
check("admin/config reads /etc/wsl.conf", configDistro.status === 200 && typeof configDistro.json?.text === "string", `status ${configDistro.status}`);

const badScope = await callRoute(ADMIN_CONFIG, fakeRequest({ url: `${ADMIN_CONFIG}?scope=bogus` }));
check("admin/config rejects an unknown scope", badScope.status === 400, `status ${badScope.status}`);

const backupsBefore = new Set(readdirSync(homedir()).filter((name) => name.startsWith(".wslconfig.bak-")));
const saveResponse = await callRoute(
	ADMIN_CONFIG,
	fakeRequest({ method: "POST", url: ADMIN_CONFIG, body: { scope: "global", mode: "raw", text: configGlobal.json.text } }),
);
check("admin/config saves .wslconfig unchanged", saveResponse.status === 200 && saveResponse.json?.needsRestart === true, `status ${saveResponse.status}`);
const configAgain = await callRoute(ADMIN_CONFIG, fakeRequest({ url: `${ADMIN_CONFIG}?scope=global` }));
check("admin/config write is lossless", configAgain.json?.text === configGlobal.json.text, "compared with the file before the save");

// The save keeps the previous contents; this script must not leave that copy behind.
const backup = saveResponse.json?.backup;
check(
	"admin/config kept a backup of the previous contents",
	typeof backup === "string" && readdirSync(homedir()).includes(backup.slice(backup.indexOf(".wslconfig.bak-"))),
	String(backup),
);
for (const name of readdirSync(homedir())) {
	if (name.startsWith(".wslconfig.bak-") && !backupsBefore.has(name)) rmSync(join(homedir(), name), { force: true });
}

const badAction = await callRoute(ADMIN_ACTION, fakeRequest({ method: "POST", url: ADMIN_ACTION, body: { action: "explode" } }));
check("admin/action rejects an unknown action", badAction.status === 400 && badAction.json?.code === "bad-action", `status ${badAction.status}`);

const traversal = await callRoute(ADMIN_ACTION, fakeRequest({ method: "POST", url: ADMIN_ACTION, body: { action: "export", distro: "Ubuntu-24.04", path: "../../evil" } }));
check("admin/action rejects a relative export path", traversal.status === 400, `status ${traversal.status}`);

// ---- the irreversible actions ask first on a restricted deployment ----------
policies.mode = "workspace-write";
const askedFirst = await callRoute(ADMIN_ACTION, fakeRequest({ method: "POST", url: ADMIN_ACTION, body: { action: "terminate", distro: "Ubuntu-24.04" } }));
check("admin/action asks before terminate", askedFirst.status === 403 && askedFirst.json?.code === "needs-acknowledge", `status ${askedFirst.status}`);

const acknowledged = await callRoute(
	ADMIN_ACTION,
	fakeRequest({ method: "POST", url: ADMIN_ACTION, body: { action: "export", distro: "Ubuntu-24.04", path: "../../evil", acknowledge: "export" } }),
);
check("admin/action lets an acknowledged call reach validation", acknowledged.status === 400, `status ${acknowledged.status}`);

policies.mode = "danger-full-access";
const unrestricted = await callRoute(
	ADMIN_ACTION,
	fakeRequest({ method: "POST", url: ADMIN_ACTION, body: { action: "export", distro: "Ubuntu-24.04", path: "Z:\\__wsl_sidebar_probe__\\probe.tar" } }),
);
check("admin/action skips the prompt under danger-full-access", unrestricted.status !== 403, `status ${unrestricted.status}`);

const platformResponse = await callRoute("/__wsl_plugin__/platform", fakeRequest({ url: "/__wsl_plugin__/platform" }));
check(
	"platform route reports Windows",
	platformResponse.status === 200 && platformResponse.json?.supported === true && platformResponse.json?.platform === "win32",
	String(platformResponse.json?.platform),
);

const statusResponse = await callRoute(ADMIN_STATUS, fakeRequest({ url: ADMIN_STATUS }));
check("admin/status samples running distros", statusResponse.status === 200 && Array.isArray(statusResponse.json?.distros), `status ${statusResponse.status}`);
check(
	"admin/status carries stats for a running distro",
	statusResponse.json?.distros?.some((row) => row.state === "running" && typeof row.stats?.memory?.totalBytes === "number") === true,
	"needs one running distribution",
);

console.log(failures.length === 0 ? "\nall mount checks passed" : `\n${failures.length} check(s) failed`);
process.exit(failures.length === 0 ? 0 : 1);

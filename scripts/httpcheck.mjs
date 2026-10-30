/**
 * Drive the plugin's web routes through a real HTTP server.
 *
 *   node scripts/httpcheck.mjs
 *
 * mountcheck.mjs calls the handlers with fake request objects; this one uses a
 * real http.Server and real fetch() calls, so the stream reading, headers and
 * status codes are exercised the way the Harness web server exercises them.
 */
import { createServer } from "node:http";
import { apply } from "../index.js";

const routes = [];
const disposers = [];

const ctx = {
	effect(fn) {
		disposers.push(fn());
		return () => {};
	},
	webServer: {
		register(route) {
			routes.push(route);
			return () => {};
		},
	},
	tools: { register: () => () => {} },
	// The panel's routes run outside any agent session, so the Host resolves the
	// deployment default here; "unrestricted" keeps the happy paths prompt-free.
	get: (name) => (name === "sandboxPolicy" ? { resolve: () => ({ mode: "danger-full-access" }) } : undefined),
	on() {},
};

apply(ctx);

const server = createServer(async (req, res) => {
	const pathname = new URL(String(req.url), "http://localhost").pathname;
	const exact = routes.find((route) => route.kind === "exact" && route.path === pathname);
	const prefix = routes.find((route) => route.kind === "prefix" && pathname.startsWith(route.path));
	const route = exact ?? prefix;
	if (route === undefined) {
		res.statusCode = 404;
		res.end();
		return;
	}
	await route.handler(req, res);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  (${detail})`}`);
	if (!ok) failures.push(name);
};

const get = (path) => fetch(base + path);
const post = (path, body) =>
	fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const distros = await get("/__wsl_plugin__/admin/distros");
const distrosJson = await distros.json();
check("GET admin/distros", distros.status === 200 && distrosJson.distros.length > 0, `${distrosJson.distros.length} distro(s)`);
check("cache is disabled on JSON answers", distros.headers.get("cache-control") === "no-store", distros.headers.get("cache-control"));

const method = await post("/__wsl_plugin__/admin/distros", {});
check("POST admin/distros is 405", method.status === 405 && method.headers.get("allow") === "GET", `status ${method.status}`);

const config = await get("/__wsl_plugin__/admin/config?scope=global");
const configJson = await config.json();
check("GET admin/config", config.status === 200 && typeof configJson.text === "string", `${configJson.fields.length} field(s)`);

const distroConfig = await get("/__wsl_plugin__/admin/config?scope=distro&distro=Ubuntu-24.04");
check("GET admin/config?scope=distro", distroConfig.status === 200, `status ${distroConfig.status}`);

const badScope = await get("/__wsl_plugin__/admin/config?scope=nope");
check("unknown scope is 400", badScope.status === 400, `status ${badScope.status}`);

const huge = await post("/__wsl_plugin__/admin/config", { scope: "global", mode: "raw", text: "x".repeat(70 * 1024) });
check("oversized configuration is 413", huge.status === 413, `status ${huge.status}`);

const badAction = await post("/__wsl_plugin__/admin/action", { action: "explode" });
check("unknown action is 400", badAction.status === 400, `status ${badAction.status}`);

const badVersion = await post("/__wsl_plugin__/admin/action", { action: "set-version", distro: "Ubuntu-24.04", version: 7 });
check("bad version is 400", badVersion.status === 400, `status ${badVersion.status}`);

const status = await get("/__wsl_plugin__/admin/status");
const statusJson = await status.json();
check("GET admin/status", status.status === 200 && Array.isArray(statusJson.distros), `${statusJson.distros.length} row(s)`);

const list = await get("/__wsl_plugin__/distros");
check("legacy GET distros still answers", list.status === 200, `status ${list.status}`);

const folder = await get("/__wsl_plugin__/list/Ubuntu-24.04/home");
const folderJson = await folder.json();
check("GET list/<distro>/<path>", folder.status === 200 && Array.isArray(folderJson.entries), `${folderJson.entries?.length} entr(ies)`);

const missing = await get("/__wsl_plugin__/nope");
check("unknown path is 404", missing.status === 404, `status ${missing.status}`);

// A form save rewrites only the keys it was given; saving a key with its current
// value must leave the file readable, and a raw save must restore it exactly.
const before = configJson.text;
const sample = configJson.fields.find((field) => field.present);
const formSave = await post("/__wsl_plugin__/admin/config", {
	scope: "global",
	mode: "fields",
	edits: sample === undefined ? [] : [{ section: sample.section, key: sample.key, value: sample.value }],
});
const after = await (await get("/__wsl_plugin__/admin/config?scope=global")).json();
check("form save accepted", formSave.status === 200, `status ${formSave.status}`);
check("form save keeps the file parseable", typeof after.text === "string" && after.text.includes("[wsl2]"), "wsl2 section still present");
const restored = await post("/__wsl_plugin__/admin/config", { scope: "global", mode: "raw", text: before });
const restoredText = (await (await get("/__wsl_plugin__/admin/config?scope=global")).json()).text;
check("raw save restores the original bytes", restored.status === 200 && restoredText === before, `bytes ${Buffer.byteLength(restoredText, "utf8")}`);

server.close();
console.log(failures.length === 0 ? "\nall http checks passed" : `\n${failures.length} check(s) failed`);
process.exit(failures.length === 0 ? 0 : 1);

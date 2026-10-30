/**
 * Render harness: evaluates client.js against a miniature React (hooks, effects,
 * a fetch stub) so a broken panel is caught here instead of after a server restart.
 *
 * Usage: node scripts/rendercheck.mjs
 */
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
let registered = null;
const g = globalThis;
g.window = { __ModuleLoader__: { load: (mod) => { registered = mod; } } };
g.localStorage = { getItem: () => null, setItem: () => {} };

const DATA = {
	"/__wsl_plugin__/admin/distros": {
		distros: [
			{ name: "Arch", isDefault: true, state: "stopped", version: 2 },
			{ name: "Ubuntu-24.04", isDefault: false, state: "running", version: 2 }
		],
		default: "Arch"
	},
	"/__wsl_plugin__/distros": { distros: ["Arch", "Ubuntu-24.04"] },
	"/__wsl_plugin__/admin/status": {
		wsl: { status: "默认分发: Arch\n默认版本: 2", version: "WSL 版本: 3.0.3.0" },
		distros: [
			{ name: "Arch", isDefault: true, state: "stopped", version: 2, stats: null },
			{
				name: "Ubuntu-24.04",
				isDefault: false,
				state: "running",
				version: 2,
				stats: {
					memory: { totalBytes: 16_437_362_688, usedBytes: 1_669_857_280, availableBytes: 14_767_505_408 },
					disk: { totalBytes: 1_081_101_176_832, usedBytes: 52_693_372_928, availableBytes: 973_415_448_576, usedPercent: "6%" },
					load: "0.01 0.06 0.08",
					uptimeSeconds: 13_638.64,
					ports: [{ address: "0.0.0.0", port: 1883 }],
					processes: 69
				}
			}
		]
	},
	"/__wsl_plugin__/admin/config": {
		scope: "global",
		distro: null,
		path: "C:\\Users\\14626\\.wslconfig",
		exists: true,
		text: "[wsl2]\nnetworkingMode=Mirrored\nmemory=8GB\n",
		fields: [
			{ section: "wsl2", key: "memory", type: "string", hint: "8GB", label: { en: "Memory limit", zh: "内存上限" }, present: true, value: "8GB" },
			{ section: "wsl2", key: "networkingMode", type: "enum", options: ["NAT", "Mirrored", "VirtioProxy"], label: { en: "Networking mode", zh: "网络模式" }, present: true, value: "Mirrored" },
			{ section: "wsl2", key: "localhostForwarding", type: "bool", label: { en: "localhost forwarding", zh: "localhost 端口转发" }, present: false, value: "" },
			{ section: "experimental", key: "autoMemoryReclaim", type: "enum", options: ["disabled", "gradual", "dropcache"], label: { en: "Auto memory reclaim", zh: "自动回收内存" }, present: false, value: "" }
		]
	}
};

const calls = [];
const bodies = [];
/** When set, every irreversible action is refused until it carries `acknowledge`. */
let requireAcknowledgement = false;
g.fetch = async (url, init) => {
	const path = String(url).split("?")[0];
	const method = init?.method ?? "GET";
	calls.push(method + " " + String(url));
	const body = method === "POST" ? JSON.parse(init?.body ?? "{}") : null;
	if (body !== null) bodies.push({ path, body });
	if (path === "/__wsl_plugin__/admin/action" && requireAcknowledgement && body?.acknowledge !== body?.action) {
		const refusal = {
			ok: false,
			action: body?.action,
			code: "needs-acknowledge",
			mode: "workspace-write",
			message: "this deployment runs in workspace-write permission, so it needs an explicit confirmation"
		};
		return { ok: false, status: 403, async text() { return JSON.stringify(refusal); } };
	}
	let payload = DATA[path];
	if (payload === undefined) payload = { entries: [], error: "ENOENT" };
	if (path === "/__wsl_plugin__/admin/action") payload = { ok: true, action: body?.action, command: "wsl.exe --" + (body?.action ?? "?"), stdout: "", stderr: "" };
	if (path === "/__wsl_plugin__/admin/config" && method === "POST") payload = { ...DATA[path], text: body?.text ?? DATA[path].text, backup: "C:\\Users\\14626\\.wslconfig.bak-20261030-090000" };
	return {
		ok: true,
		status: 200,
		async text() {
			return JSON.stringify(payload);
		},
		async json() {
			return payload;
		}
	};
};

// -- miniature React ---------------------------------------------------------
const store = new Map();
const effects = [];
let cursor = 0;
let pathStack = [];
let needsRender = false;

function useHookSlot(kind) {
	const where = pathStack.join("/") + "#" + kind + "#" + cursor;
	cursor += 1;
	return where;
}

const React = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(4) }),
	useState(init) {
		const key = useHookSlot("state");
		if (!store.has(key)) store.set(key, typeof init === "function" ? init() : init);
		const set = (next) => {
			const value = typeof next === "function" ? next(store.get(key)) : next;
			if (Object.is(value, store.get(key))) return;
			if (process.env.TRACE) console.log("set", key, "->", JSON.stringify(value)?.slice(0, 60));
			store.set(key, value);
			needsRender = true;
		};
		return [store.get(key), set];
	},
	useEffect(effect, deps) {
		const key = useHookSlot("effect");
		const previous = store.get(key + ":deps");
		const same = Array.isArray(deps) && Array.isArray(previous) && deps.length === previous.length && deps.every((value, index) => Object.is(value, previous[index]));
		if (!same) {
			store.set(key + ":deps", deps);
			effects.push({ key, effect, deps });
		}
	},
	useCallback(fn, deps) {
		// useCallback memoizes the function itself, it does not call it.
		return memoValue(() => fn, deps);
	},
	useMemo(fn, deps) {
		return memoValue(fn, deps);
	}
};

/** Memoize like React: recompute only when the dependency array changes. */
function memoValue(factory, deps) {
	const key = useHookSlot("memo");
	const previous = store.get(key);
	const same = previous !== undefined && Array.isArray(deps) && Array.isArray(previous.deps) && deps.length === previous.deps.length && deps.every((value, index) => Object.is(value, previous.deps[index]));
	if (process.env.TRACE) console.log("memo", key, same ? "reuse" : "fresh", typeof (same ? previous.value : factory));
	if (same) return previous.value;
	const value = factory();
	if (process.env.TRACE) console.log("memo store", key, "value:", typeof value, Array.isArray(value) ? "array" : "");
	store.set(key, { value, deps });
	return value;
}

let ctx = null;
const slots = [];
function mount() {
	g.window.__ModuleLoader__.load = (mod) => { registered = mod; };
	const factorySrc = source;
	// eslint-disable-next-line no-eval
	(0, eval)(factorySrc);
	const mod = registered.factory((name) => {
		if (name === "react") return React;
		throw new Error("unexpected require: " + name);
	});
	ctx = {
		locale: { resolveText: (value) => value?.zh ?? value?.en ?? "" },
		effect: (fn) => { fn(); return () => {}; },
		slots: {
			register: (meta, render) => { slots.push({ meta, render }); return () => {}; },
			inject: (name, fn) => { fn(); return () => {}; }
		},
		workspaces: { create: async () => ({ workspaceId: "ws-1" }), list: { getSnapshot: () => ({ items: [] }) } },
		uiWorkspace: { openWorkspace: async () => {} }
	};
	mod.apply(ctx);
}

/** Render an element tree, executing function components. */
function render(node, depth = 0) {
	if (node === null || node === undefined || node === false || node === true) return [];
	if (Array.isArray(node)) return node.flatMap((child) => render(child, depth));
	if (typeof node === "string" || typeof node === "number") return [{ text: String(node) }];
	if (typeof node.type === "function") {
		const name = node.type.name || "anonymous";
		pathStack.push(name + "@" + depth);
		const savedCursor = cursor;
		cursor = 0;
		let out;
		try {
			out = node.type({ ...node.props, children: node.children });
		} finally {
			cursor = savedCursor;
			pathStack.pop();
		}
		return render(out, depth + 1);
	}
	const kids = node.children.flatMap((child) => render(child, depth + 1));
	return [{ type: node.type, props: node.props, children: kids }];
}

async function settle(rounds = 8) {
	for (let round = 0; round < rounds; round += 1) {
		needsRender = false;
		let cursorLocal = 0;
		void cursorLocal;
		cursor = 0;
		const tree = render({ type: slots.find((slot) => slot.meta.name === "settings.section").render, props: {}, children: [] });
		// Run effects queued by this render.
		for (const entry of effects.splice(0)) {
			if (process.env.TRACE) {
				const dep = entry.deps?.[0];
				console.log("run effect", entry.key, "dep0:", typeof dep, dep && typeof dep === "object" ? Object.keys(dep) : "");
			}
			entry.effect();
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (!needsRender) return tree;
	}
	throw new Error("render did not settle");
}

mount();
let tree = await settle();
const flat = JSON.stringify(tree);
if (flat.includes("undefined")) throw new Error("tree contains undefined");

function findNode(node, predicate) {
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = findNode(child, predicate);
			if (hit !== undefined) return hit;
		}
		return undefined;
	}
	if (node === null || typeof node !== "object") return undefined;
	if (predicate(node)) return node;
	return findNode(node.children ?? [], predicate);
}

function findAll(node, predicate, sink = []) {
	if (Array.isArray(node)) {
		for (const child of node) findAll(child, predicate, sink);
		return sink;
	}
	if (node === null || typeof node !== "object") return sink;
	if (predicate(node)) sink.push(node);
	findAll(node.children ?? [], predicate, sink);
	return sink;
}

const textOf = (node) => Array.isArray(node?.children) ? node.children.map((child) => child.text ?? textOf(child)).join("") : (node?.text ?? "");

function clickByText(root, label) {
	// Deepest, shortest match wins: an overlay that wraps a dialog also contains
	// the label, but the button inside is the thing a user clicks.
	const matches = findAll(root, (candidate) => typeof candidate.props?.onClick === "function" && textOf(candidate).includes(label));
	if (matches.length === 0) throw new Error("no clickable node labeled " + label);
	matches.sort((a, b) => textOf(a).length - textOf(b).length);
	matches[0].props.onClick();
	return matches[0];
}

const report = [];
process.on("unhandledRejection", (error) => { console.log(report.join(String.fromCharCode(10))); console.error(error); process.exit(1); });
const expect = (condition, message) => {
	report.push((condition ? "ok   " : "FAIL ") + message);
	if (!condition) process.exitCode = 1;
};

// Distros tab (default): both rows, default badge, lifecycle buttons.
expect(flat.includes("Ubuntu-24.04") && flat.includes("运行中"), "distro rows rendered with state");
expect(flat.includes("默认"), "default badge rendered");
expect(flat.includes("停止"), "stop button rendered for the running distro");

const before = calls.length;
const stopButton = findNode(tree, (candidate) => typeof candidate.props?.onClick === "function" && textOf(candidate) === "停止");
if (stopButton === undefined) throw new Error("stop button not found");
stopButton.props.onClick();
tree = await settle();
expect(calls.some((call) => call.startsWith("POST /__wsl_plugin__/admin/action")), "stop posted to /admin/action");

// Config tab: fields, form/raw switch, save posts edits, restart needs a second confirm.
clickByText(tree, "配置");
tree = await settle();
expect(JSON.stringify(tree).includes("内存上限"), "config form rendered a schema label");

// Enum fields are our own list now: open, hover, pick — with colours we control.
const triggerOf = (root) => findNode(root, (candidate) => typeof candidate.props?.onClick === "function"
	&& candidate.props?.style?.justifyContent === "space-between"
	&& textOf(candidate).includes("▼"));
const optionOf = (root, label) => findNode(root, (candidate) => typeof candidate.props?.onClick === "function"
	&& typeof candidate.props?.onMouseEnter === "function"
	&& textOf(candidate) === label);
const firstTrigger = triggerOf(tree);
if (firstTrigger === undefined) {
	const buttons = findAll(tree, (c) => typeof c.props?.onClick === "function");
	for (const b of buttons) console.log("BTN", JSON.stringify(textOf(b)), b.props?.style?.justifyContent, b.props?.title);
	throw new Error("no dropdown trigger in the config form");
}
firstTrigger.props.onClick();
tree = await settle();
const option = optionOf(tree, "true");
if (option === undefined) throw new Error("opening the dropdown did not list its options");
option.props.onMouseEnter();
tree = await settle();
expect(JSON.stringify(optionOf(tree, "true")?.props?.style).includes("127,127,127,.22"), "hovered option gets an explicit background");
optionOf(tree, "true").props.onClick();
tree = await settle();
expect(!JSON.stringify(tree).includes("<select"), "no native select is rendered");

// Tabs carry their own hover colours too: the panel lives in someone else's CSS.
const tabNode = (root, label) => findNode(root, (candidate) => candidate.props?.role === "tab" && textOf(candidate) === label);
const runtimeTab = tabNode(tree, "运行态");
if (runtimeTab === undefined) throw new Error("runtime tab not found");
const beforeHover = JSON.stringify(runtimeTab.props.style);
runtimeTab.props.onMouseEnter();
tree = await settle();
const afterHover = JSON.stringify(tabNode(tree, "运行态")?.props?.style);
expect(afterHover !== beforeHover && afterHover.includes("127,127,127,.14"), "hovered tab gets an explicit background");
clickByText(tree, "保存");
tree = await settle();
expect(calls.filter((call) => call.startsWith("POST /__wsl_plugin__/admin/config")).length > 0, "save posted config edits");
expect(JSON.stringify(tree).includes("需要重启"), "save reported the restart requirement");
expect(JSON.stringify(tree).includes("备份到"), "save reported where the previous config went");
clickByText(tree, "立即重启 WSL");
tree = await settle();
expect(JSON.stringify(tree).includes("确认重启 WSL"), "restart confirm dialog opened");
const shutdownCalls = () => calls.filter((call) => call.startsWith("POST /__wsl_plugin__/admin/action")).length;
const beforeShutdown = shutdownCalls();
clickByText(tree, "确认重启");
tree = await settle();
expect(shutdownCalls() > beforeShutdown, "confirmed restart posted the shutdown action");

// Runtime tab: numbers, ports.
clickByText(tree, "运行态");
tree = await settle();
const runtimeText = JSON.stringify(tree);
expect(runtimeText.includes("Ubuntu-24.04"), "runtime rendered a distro");
expect(runtimeText.includes("1.6 GB") || runtimeText.includes("GB"), "runtime rendered byte-formatted memory");
expect(runtimeText.includes("1883"), "runtime rendered listening ports");

// The folders tab is gone: only three tabs exist, and no directory browser in the page.
const tabLabels = findAll(tree, (candidate) => candidate.props?.role === "tab").map(textOf);
expect(tabLabels.length === 3 && !tabLabels.includes("目录"), "panel has exactly the three administration tabs");

// A restricted deployment asks before it touches a distribution, and the retry
// carries the acknowledgement the Host demanded.
clickByText(tree, "发行版");
tree = await settle();
requireAcknowledgement = true;
const actionPosts = () => bodies.filter((entry) => entry.path === "/__wsl_plugin__/admin/action");
const beforeAsk = actionPosts().length;
clickByText(tree, "停止");
tree = await settle();
expect(JSON.stringify(tree).includes("此操作不可撤销"), "restricted deployment opened the confirm dialog");
expect(actionPosts().length === beforeAsk + 1 && actionPosts().at(-1).body.acknowledge === undefined, "the first attempt carried no acknowledgement");
clickByText(tree, "确认执行");
tree = await settle();
expect(actionPosts().at(-1).body.acknowledge === "terminate", "the confirmed retry carried the acknowledgement");
requireAcknowledgement = false;

// A non-Windows deployment explains itself instead of spawning a missing wsl.exe.
DATA["/__wsl_plugin__/platform"] = { platform: "linux", supported: false };
slots.length = 0;
store.clear();
effects.length = 0;
mount();
const offTree = await settle();
expect(JSON.stringify(offTree).includes("WSL 只在 Windows 上存在"), "non-Windows deployment shows the notice");
expect(!JSON.stringify(offTree).includes("发行版"), "non-Windows deployment hides the administration tabs");

console.log(report.join("\n"));
console.log("requests:", calls.length, calls.slice(0, 6));
console.log("render ok");

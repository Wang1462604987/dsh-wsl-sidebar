/**
 * Self-check for the plugin's own tools.
 *
 *   node scripts/selfcheck.mjs [distro]
 *
 * It exercises the pieces that have failed before: distribution resolution from
 * a UNC workspace, asRoot on every file tool, the destructive-command guard, and
 * a background task read by cursor. No test framework, no extra dependency.
 */
import { buildWslArgs, distroFromWindowsPath, linuxPathFromWindows, resolveDistro, runInWsl } from "../lib/wsl.js";
import { createTools, destructiveReason } from "../lib/tools.js";
import { readTask, startTask } from "../lib/tasks.js";
import { distroState, listVerbose, readConfig, writeConfig } from "../lib/admin.js";

const distro = process.argv[2] ?? "Ubuntu-24.04";
let failures = 0;

function check(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  (${detail})`}`);
	if (!ok) failures += 1;
}

/** One Windows UNC path, built from parts so the test file has no escape soup. */
const unc = ["", "", "wsl.localhost", distro, "home", "hugo"].join("\\");

check("unc -> distro", distroFromWindowsPath(unc) === distro, distroFromWindowsPath(unc) ?? "null");
check("unc -> linux path", linuxPathFromWindows(unc) === "/home/hugo", linuxPathFromWindows(unc) ?? "null");
check("drive -> linux path", linuxPathFromWindows("C:\\Users\\14626") === "/mnt/c/Users/14626");
check("argv carries root", buildWslArgs({ distro, script: "true", asRoot: true }).includes("-u"));
check("argv carries cd", buildWslArgs({ distro, script: "true", cwdUnix: "/home/hugo" }).includes("--cd"));

const resolved = await resolveDistro({ cwd: unc });
check("workspace distro wins", resolved.distro === distro && resolved.source === "workspace", JSON.stringify(resolved));

/** A context whose session already runs in danger-full-access, with no approval channel. */
function fullContext() {
	return { get: (name) => (name === "sandboxPolicy" ? { resolve: () => ({ mode: "danger-full-access" }) } : undefined) };
}
/** A workspace-write context with no approval channel: every escalation must fail closed. */
function narrowContext() {
	return { get: (name) => (name === "sandboxPolicy" ? { resolve: () => ({ mode: "workspace-write" }) } : undefined) };
}

const catastrophic = [
	"rm -rf /",
	"rm -rf /*",
	"sudo rm -rf / --no-preserve-root",
	"rm -rf ~",
	"rm -rf $HOME/*",
	"rm -rf /home/hugo",
	"rm -rf /mnt/c/Windows",
	"mkfs.ext4 /dev/sdb",
	"dd if=/dev/zero of=/dev/sda",
	":(){ :|:& };:",
	"wsl --unregister Ubuntu-24.04",
	"shutdown -h now",
	"systemctl poweroff",
];
const ordinary = [
	"rm -rf build",
	"rm -rf /home/hugo/temp/paho.mqtt.cpp-1.6.0",
	"rm -f /tmp/x.txt",
	"git commit -m 'reboot handling'",
	"echo shutdown",
	"npm test && ls -la",
];
for (const command of catastrophic) {
	check(`guard blocks: ${command}`, destructiveReason(command) !== null, String(destructiveReason(command)));
}
for (const command of ordinary) {
	check(`guard allows: ${command}`, destructiveReason(command) === null, String(destructiveReason(command)));
}

const tools = createTools(fullContext());
check("six tools", tools.length === 6, tools.map((tool) => tool.name).join(","));
check(
	"asRoot on every tool",
	tools.every((tool) => tool.parameters.properties.asRoot?.type === "boolean"),
);

const run = tools.find((tool) => tool.name === "wslx-run");
const exec = { agent: { session: { header: { cwd: unc } } } };
const rootOut = await run.execute({ command: "id -u", asRoot: true }, exec);
check("asRoot reaches uid 0 under danger-full-access", rootOut.text.includes("\n0\n") || rootOut.text.trimEnd().endsWith("\n0"), rootOut.text.split("\n")[1]);

const narrowRun = createTools(narrowContext()).find((tool) => tool.name === "wslx-run");
const expectThrow = async (label, run) => {
	try {
		await run();
		check(label, false, "no error");
	} catch (error) {
		check(label, /approval|grant|did not grant/.test(error.message), error.message.slice(0, 120));
	}
};
await expectThrow("asRoot fails closed without approval", () => narrowRun.execute({ command: "id -u", asRoot: true }, exec));
await expectThrow("destructive+allowDangerous still needs authority", () =>
	narrowRun.execute({ command: "rm -rf /", allowDangerous: true }, exec),
);

let guard = false;
try {
	await run.execute({ command: "rm -rf / --no-preserve-root" }, exec);
} catch (error) {
	guard = /refusing a destructive command/.test(error.message);
}
check("destructive guard", guard);

const write = tools.find((tool) => tool.name === "wslx-write");
const read = tools.find((tool) => tool.name === "wslx-read");
const edit = tools.find((tool) => tool.name === "wslx-edit");
const probe = `/tmp/wslx-selfcheck-${Date.now()}.txt`;
await write.execute({ path: probe, content: "alpha\nbeta\n" }, exec);
await edit.execute({ path: probe, oldString: "beta", newString: "gamma" }, exec);
const back = await read.execute({ path: probe }, exec);
check("write/read/edit round trip", back.text.includes("gamma") && !back.text.includes("beta"), back.text.split("\n")[1]);
await run.execute({ command: `rm -f ${probe}` }, exec);

const task = startTask({ distro, script: "echo first\necho second\n", mode: "command" });
await new Promise((resolve) => setTimeout(resolve, 1500));
const first = readTask(task.id, { cursor: 0 });
const second = readTask(task.id, { cursor: first.cursor });
check("background task output", first.text.includes("first") && first.text.includes("second"), JSON.stringify(first.text));
check("cursor is incremental", second.text === "", JSON.stringify(second.text));
check("unicode argv passes through", (await runInWsl({ distro, script: "printf '中文\\n'" })).stdout.includes("中文"));


// Opening the config page must not boot a distribution: reading and writing
// /etc/wsl.conf both need a running one, so a stopped one is refused untouched.
const rows = await listVerbose();
const idle = rows.find((row) => row.state !== "running");
if (idle !== undefined) {
	const config = await readConfig({ scope: "distro", distro: idle.name });
	check("stopped distro config reads as stopped", config.state !== "running" && config.text === "", config.state);
	let refusal = "";
	try {
		await writeConfig({ scope: "distro", distro: idle.name, text: "[boot]" });
	} catch (error) {
		refusal = error.code ?? error.message;
	}
	check("stopped distro config refuses the write", refusal === "distro-stopped", refusal);
	const after = await distroState(idle.name);
	check("stopped distro is still stopped", after !== "running", after);
} else {
	console.log("SKIP  stopped-distro config guard  (every distribution is running)");
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

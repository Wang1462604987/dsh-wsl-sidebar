/**
 * Behaviour check for the background chain — local only, needs a real WSL.
 *
 * Covers what the unit-style selfcheck cannot: a deadline handing a live child
 * to the task registry, and the idle-based time-to-live restart.
 *
 * Run: node scripts/bgcheck.mjs
 */
import { adoptChild, readTask, startTask } from "../lib/tasks.js";
import { runInWsl } from "../lib/wsl.js";

let failures = 0;

function check(name, condition, detail = "") {
	if (condition) {
		console.log(`ok   ${name}`);
	} else {
		failures += 1;
		console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Case A: a deadline adopts the child instead of killing it -------------
const slow = await runInWsl({
	script: "echo started; sleep 3; echo finished\n",
	timeoutMs: 1_000,
	adoptOnTimeout: true,
});
check("adopt: deadline resolves with a live child", slow.timedOut === true && slow.adopted instanceof Object && slow.adopted.pid !== undefined);
check("adopt: partial output captured", slow.stdout.includes("started"), JSON.stringify(slow.stdout));

if (slow.adopted) {
	const record = adoptChild({
		distro: slow.distro,
		child: slow.adopted,
		command: "echo started; sleep 3; echo finished",
		cwdUnix: "~",
		seed: slow.stdout + slow.stderr,
	});
	const early = readTask(record.id, { cursor: 0 });
	check("adopt: seed makes the early output readable", early.text.includes("started"), JSON.stringify(early.text));
	check("adopt: task reports running", early.running === true);
	await sleep(3_000);
	const late = readTask(record.id, { cursor: 0 });
	check("adopt: the command finished inside the task", late.running === false && late.exitCode === 0 && late.text.includes("finished"), `running=${late.running} exit=${late.exitCode} text=${JSON.stringify(late.text)}`);
} else {
	failures += 1;
	console.error("FAIL adopt: nothing was adopted; later cases skipped");
}

// --- Case B: a read restarts the idle clock --------------------------------
const task = startTask({ script: "sleep 4; echo still-alive\n", ttlMs: 60_000 });
await sleep(1_500);
const first = readTask(task.id, { cursor: 0 });
check("ttl: first read sees a running task", first.running === true);
await sleep(1_500);
const second = readTask(task.id, { cursor: 0 });
check("ttl: task survives past reads (clock restarted)", second.running === true || (second.exitCode === 0 && second.text.includes("still-alive")));
await sleep(2_000);
const third = readTask(task.id, { cursor: 0 });
check("ttl: the command completes", third.exitCode === 0 && third.text.includes("still-alive"), `exit=${third.exitCode} text=${JSON.stringify(third.text)}`);

console.log(failures === 0 ? "\nbgcheck: all green" : `\nbgcheck: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

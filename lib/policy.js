/**
 * Session permission for the plugin's risky operations.
 *
 * Two things in this plugin reach past "read my files": the Linux root account
 * (`asRoot`) and the handful of commands that destroy a machine instead of a
 * project. Both need the same proof from DSH: either the session already runs in
 * danger-full-access, or the user grants this one call through the approval
 * channel. Anything else fails closed, before a process starts.
 */

/** DSH's three session modes, in widening order. */
const MODES = ["read-only", "workspace-write", "danger-full-access"];

/** The session's current policy, when the service is mounted at all. */
export function currentPolicy(ctx, exec) {
	try {
		const service = ctx?.get?.("sandboxPolicy");
		const session = exec?.agent?.session;
		if (typeof service?.resolve !== "function" || session === undefined) return undefined;
		const policy = service.resolve({ session });
		return MODES.includes(policy?.mode) ? policy : undefined;
	} catch {
		// A missing or failing policy service is "unknown", never "allowed".
		return undefined;
	}
}

/**
 * Throw unless danger-full-access is already granted or the user allows this call.
 *
 * @returns {Promise<string>} why it was allowed, for the tool's own output.
 */
export async function requirePermission(ctx, exec, toolName, reason) {
	const policy = currentPolicy(ctx, exec);
	if (policy?.mode === "danger-full-access") return "the session already runs in danger-full-access";

	let approval;
	try {
		approval = ctx?.get?.("approval");
	} catch {
		approval = undefined;
	}
	if (exec?.agent === undefined || typeof approval?.request !== "function") {
		throw new Error(
			`${toolName}: this needs either the session permission "danger-full-access" or a user approval, and no approval channel is available, so nothing ran. Reason: ${reason}`,
		);
	}

	let outcome;
	try {
		outcome = await approval.request({
			agent: exec.agent,
			callId: exec.callId,
			toolName,
			reason,
			signal: exec.signal,
		});
	} catch (error) {
		// No answerer, no open turn, or a cancelled prompt: all mean "no", never "try anyway".
		throw new Error(`${toolName}: the approval request failed (${String(error?.message ?? error)}); nothing ran. Reason: ${reason}`);
	}
	if (outcome !== "allowed-once") {
		throw new Error(`${toolName}: the user did not grant this (${String(outcome)}); nothing ran. Reason: ${reason}`);
	}

	// The mode can change while the prompt is open; that is a new authority.
	const after = currentPolicy(ctx, exec);
	if (after !== undefined && policy !== undefined && after.mode !== policy.mode && after.mode !== "danger-full-access") {
		throw new Error(`${toolName}: the session permission changed while the approval was pending; nothing ran.`);
	}
	return "the user allowed this one call";
}

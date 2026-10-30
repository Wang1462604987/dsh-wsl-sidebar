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
 * The deployment's default permission mode, for callers that have no session.
 *
 * The panel's HTTP routes are called by the browser, not by an agent, so there is
 * no `exec.session` to resolve against: `resolve({})` answers with the mode the
 * whole deployment started in (`DSH_PERMISSION_MODE`, else `workspace-write`).
 */
export function deploymentMode(ctx) {
	try {
		const service = ctx?.get?.("sandboxPolicy");
		if (typeof service?.resolve !== "function") return undefined;
		const policy = service.resolve({});
		return MODES.includes(policy?.mode) ? policy.mode : undefined;
	} catch {
		return undefined;
	}
}

/** Refusal from {@link guardAdminAction}, carrying enough for the panel to ask back. */
export class AdminActionDenied extends Error {
	constructor(action, mode) {
		super(`this deployment runs in ${mode ?? "an unknown"} permission, so "${action}" needs an explicit confirmation`);
		this.name = "AdminActionDenied";
		this.action = action;
		this.mode = mode;
	}
}

/** Panel actions that a second click cannot undo. */
const IRREVERSIBLE_ACTIONS = new Set(["shutdown", "terminate", "set-version", "export"]);

/**
 * Require a deliberate "yes" for the panel actions that are not reversible.
 *
 * DSH admits exactly one authenticated owner Peer per browser page, so every
 * caller that can reach these routes at all is already this Harness's own page;
 * this guard is therefore not a sandbox boundary. It is the difference between a
 * misclick and a deliberate one, it stays out of the way when the deployment
 * already runs in danger-full-access, and it leaves an audit line behind.
 */
export function guardAdminAction(ctx, action, body) {
	if (!IRREVERSIBLE_ACTIONS.has(action)) return;
	const mode = deploymentMode(ctx);
	if (mode === "danger-full-access") return;
	if (String(body?.acknowledge ?? "") === action) return;
	throw new AdminActionDenied(action, mode);
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

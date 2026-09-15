/**
 * Gateway → Agent profile resolution (WP2 compat layer).
 *
 * The gateway addresses an agent by *account*: `channels.dingtalk.accounts.<accountId>`
 * is the DingTalk robot's key and, historically, the only agent reference — with an
 * optional `agentDir` override. This module is the single place that turns an account
 * into an {@link AgentBinding} (Agent identity + home), so the gateway no longer
 * carries its own copy of `resolveAgentDir(accountId, account.agentDir)` per call site.
 *
 * Compat rules — see `@cornfield/coding-agent/agent-domain`'s `resolveAgentBinding` for
 * the full precedence and the reason for each step:
 *
 *   - `accountId` stays the account's key and the IM identity. It is deliberately *not*
 *     rewritten into a registry key: renaming would rewrite `registry.json` entries,
 *     channel keys (`dingtalk:<id>`) and session names. An account that wants to name a
 *     registered Agent declares `agentId`.
 *   - a declared `agentDir` (every gateway.json written before this field existed) keeps
 *     winning, verbatim — those accounts need no migration, and when the directory is a
 *     registered Agent's home the reverse lookup recovers that Agent's id.
 *   - no declaration anywhere → the same default the gateway used before this module,
 *     so an unconfigured account is not relocated.
 *   - a declared `agentDir` and a registered `agentId` that disagree resolve to the
 *     declared directory (the operator's direct instruction) and warn once, because one
 *     of the two sources is stale and only the operator can say which.
 */

import { type AgentBinding, resolveAgentBinding } from "@cornfield/coding-agent/agent-domain";
import { logger } from "@cornfield/utils";
import type { DingtalkAccountConfig } from "./types";

/** An {@link AgentBinding} plus the gateway account it was resolved for. */
export interface AccountAgentBinding extends AgentBinding {
	/** The gateway account key this binding belongs to (`channels.dingtalk.accounts.<id>`). */
	accountId: string;
}

/**
 * Resolve the Agent behind a DingTalk account.
 *
 * Idempotent and read-only: it reads `registry.json` and the agentDir declaration, and
 * writes neither. Never throws for configuration problems — the gateway has to boot —
 * so the result is always a usable binding plus a warning in the log when two
 * authorities disagree.
 *
 * Accounts are skipped for disabled state *before* this call (`accounts.<id>.enabled`),
 * so a disabled account never reaches resolution.
 */
export async function resolveAccountAgentBinding(
	accountId: string,
	account: Pick<DingtalkAccountConfig, "agentId" | "agentDir">,
): Promise<AccountAgentBinding> {
	const binding = await resolveAgentBinding({
		agentId: account.agentId ?? accountId,
		agentDir: account.agentDir,
	});

	if (binding.conflict) {
		logger.warn("Account agentDir disagrees with the registered Agent", {
			accountId,
			requestedAgentId: binding.conflict.requestedAgentId,
			declaredAgentDir: binding.conflict.declaredAgentDir,
			registeredAgentDir: binding.conflict.registeredAgentDir,
			using: binding.conflict.declaredAgentDir,
		});
	}

	logger.debug("Resolved account agent binding", {
		accountId,
		agentId: binding.agentId,
		agentDir: binding.agentDir,
		agentDirSource: binding.agentDirSource,
		registered: binding.profile !== null,
	});

	return { ...binding, accountId };
}

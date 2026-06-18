/**
 * agentDir path resolution.
 *
 * Default location: `~/.omp/agents/<accountId>/` (one account = one agentDir).
 * An explicit directory always wins, used by the gateway when a user configures
 * a non-default path during install.
 */

import * as os from "node:os";
import * as path from "node:path";

function getDefaultAgentDir(accountId: string): string {
	return path.join(os.homedir(), ".omp", "agents", accountId);
}

/**
 * Resolve the agentDir for `<accountId>`. Returns `<explicitDir>` if provided,
 * otherwise `~/.omp/agents/<accountId>/`.
 */
export function resolveAgentDir(accountId: string, explicitDir?: string): string {
	return explicitDir || getDefaultAgentDir(accountId);
}

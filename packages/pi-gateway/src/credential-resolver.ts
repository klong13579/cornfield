/**
 * Credential resolver: reads API keys from agent.db auth_credentials
 * and resolves them as env vars for child processes.
 *
 * Flow:
 * 1. Read ~/.omp/agent/models.yml to find provider→apiKey env-var mapping
 * 2. Read agent.db auth_credentials for stored API keys
 * 3. Return env vars to set for the spawned process
 */
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { logger } from "@oh-my-pi/pi-utils";

const { readFileSync } = fs;

/**
 * Resolve API keys from agent.db and return env vars for the spawned process.
 * Only includes keys whose referenced env var is NOT already set.
 */
export function resolveCredentialEnvVars(): Record<string, string> {
	const homeDir = os.homedir();
	const agentDir = path.join(homeDir, ".omp", "agent");
	const modelsPath = path.join(agentDir, "models.yml");
	const dbPath = path.join(agentDir, "agent.db");

	// Read models.yml to get apiKey references (provider → env var name)
	const providerEnvMap = readProviderApiKeyRefs(modelsPath);

	// Read agent.db auth_credentials
	const storedKeys = readAuthCredentials(dbPath);

	const envVars: Record<string, string> = {};
	const missing: string[] = [];

	for (const [provider, envVarName] of Object.entries(providerEnvMap)) {
		// Already set in current process? Skip.
		if (process.env[envVarName]) continue;

		// Look up in stored credentials
		const storedKey = storedKeys[provider];
		if (storedKey) {
			envVars[envVarName] = storedKey;
		} else {
			missing.push(`${provider} → ${envVarName}`);
		}
	}

	if (missing.length > 0) {
		logger.warn("Credentials not found in agent.db; use omp login or ensure env var is set", { missing });
	}

	return envVars;
}

/**
 * Parse models.yml to extract provider → env var name mappings.
 * Matches the pattern:
 *   narwal-plan:
 *     baseUrl: ...
 *     apiKey: NARWAL_PLAN_API_KEY
 */
function readProviderApiKeyRefs(modelsPath: string): Record<string, string> {
	const result: Record<string, string> = {};
	try {
		const content = readFileSync(modelsPath, "utf-8");
		const lines = content.split("\n");
		let currentProvider: string | null = null;

		for (const line of lines) {
			// Provider header: two-space prefix, alphanumeric name with hyphens
			const providerMatch = line.match(/^  ([a-zA-Z0-9_-]+):$/);
			if (providerMatch) {
				currentProvider = providerMatch[1];
				// Providers section header? Skip.
				if (currentProvider === "providers") {
					currentProvider = null;
				}
				continue;
			}

			if (currentProvider) {
				// apiKey: ENV_VAR_NAME
				const apiKeyMatch = line.match(/^    apiKey:\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*$/);
				if (apiKeyMatch) {
					result[currentProvider] = apiKeyMatch[1];
					currentProvider = null;
					continue;
				}
				// Indented content that's not apiKey? Different field, keep parsing.
				if (line.match(/^    /)) continue;

				// Non-indented or different indentation = end of provider block
				if (line.trim() && !line.match(/^ {2,4}/)) currentProvider = null;
			}
		}
	} catch {
		// models.yml not found - not an error, just no keys from this source
	}

	return result;
}

interface AuthCredentialRow {
	provider: string;
	data: string;
}

function readAuthCredentials(dbPath: string): Record<string, string> {
	const result: Record<string, string> = {};
	try {
		const db = new Database(dbPath, { readonly: true });
		try {
			const rows = db
				.query("SELECT provider, data FROM auth_credentials WHERE credential_type = 'api_key'")
				.all() as AuthCredentialRow[];
			for (const row of rows) {
				try {
					const parsed = JSON.parse(row.data) as { key?: string };
					if (parsed.key) {
						result[row.provider] = parsed.key;
					}
				} catch {
					// Ignore unparseable data
				}
			}
		} finally {
			db.close();
		}
	} catch {
		// DB not found or inaccessible
	}

	return result;
}
import * as path from "node:path";
import { getAgentDir } from "@cornfield/utils";

/** Paths that come from the developer's real user/agent config, not the test fixture. */
function isExternalUserExtensionPath(extPath: string): boolean {
	const userExtensionsDir = path.join(getAgentDir(), "extensions");
	if (extPath.startsWith(userExtensionsDir)) return true;
	// Plugin marketplace installs into ~/.cornfield/plugins (user-level), and
	// discoverAndLoadExtensions picks up their dist/extension.ts — these are
	// real user extensions, not test fixtures.
	const userPluginsDir = path.join(getAgentDir(), "..", "plugins");
	if (extPath.startsWith(userPluginsDir)) return true;
	// Leftover settings.json paths into first-party packages (now inlined in sdk.ts).
	if (extPath.includes(`${path.sep}packages${path.sep}moa-extension${path.sep}`)) return true;
	return false;
}

export function filterUserExtensions<T extends { path: string }>(extensions: T[]): T[] {
	return extensions.filter(ext => !isExternalUserExtensionPath(ext.path));
}

export function filterUserExtensionErrors<T extends { path: string }>(errors: T[]): T[] {
	return errors.filter(err => !isExternalUserExtensionPath(err.path));
}

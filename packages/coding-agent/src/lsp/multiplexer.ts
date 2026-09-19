import { logger } from "@cornfield/utils";
import { checkDaemonRunning, findDreyBinary, getDreyCommand, isDreySupported } from "./drey";
import { detectLspmux, getLspmuxCommand, isLspmuxSupported } from "./lspmux";

/**
 * The single place that decides how a configured language server command is
 * actually spawned.
 *
 * Two multiplexers share server instances across sessions, each for a different
 * server, and each may decline (server unsupported, daemon unavailable, custom
 * args): the first one that accepts wins, and everything else falls through to a
 * direct spawn. A failure inside a multiplexer is a downgrade, never a broken
 * language server, so every attempt is caught here.
 */

export interface ResolvedLspCommand {
	command: string;
	args: string[];
	env?: Record<string, string>;
}

export interface Multiplexer {
	readonly name: string;
	supports(command: string): boolean;
	/** Declines by returning the command unchanged. */
	wrap(command: string, args: string[]): Promise<ResolvedLspCommand>;
}

/** Consulted in order; the first one that accepts wins. */
export const MULTIPLEXERS: readonly Multiplexer[] = [
	{
		name: "drey",
		supports: isDreySupported,
		wrap: getDreyCommand,
	},
	{
		name: "lspmux",
		supports: isLspmuxSupported,
		wrap: getLspmuxCommand,
	},
];

/**
 * Resolve a configured language server command to the one to spawn.
 *
 * @param command - Configured server command (already resolved to a path)
 * @param args - Configured args
 * @param multiplexers - Override the multiplexer list (tests inject fakes)
 */
export async function resolveLspCommand(
	command: string,
	args?: string[],
	multiplexers: readonly Multiplexer[] = MULTIPLEXERS,
): Promise<ResolvedLspCommand> {
	const baseArgs = args ?? [];

	for (const multiplexer of multiplexers) {
		if (!multiplexer.supports(command)) {
			continue;
		}
		try {
			const wrapped = await multiplexer.wrap(command, baseArgs);
			if (wrapped.command !== command) {
				return wrapped;
			}
		} catch (err) {
			logger.warn(`${multiplexer.name} multiplexing failed; trying the next option`, {
				command,
				error: String(err),
			});
		}
	}

	return { command, args: baseArgs };
}

/**
 * Status lines for the lsp tool's `status` action: one per installed
 * multiplexer, empty when none is present (so callers append nothing).
 */
export async function describeMultiplexers(): Promise<string[]> {
	const lines: string[] = [];

	try {
		const dreyBinary = await findDreyBinary();
		if (dreyBinary) {
			lines.push(
				(await checkDaemonRunning(dreyBinary))
					? "drey: active (typescript-language-server shared across sessions)"
					: "drey: installed but daemon not running",
			);
		}
	} catch (err) {
		logger.debug("drey status unavailable", { error: String(err) });
	}

	try {
		const lspmuxState = await detectLspmux();
		if (lspmuxState.available) {
			lines.push(
				lspmuxState.running ? "lspmux: active (multiplexing enabled)" : "lspmux: installed but server not running",
			);
		}
	} catch (err) {
		logger.debug("lspmux status unavailable", { error: String(err) });
	}

	return lines;
}

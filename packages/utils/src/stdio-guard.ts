/**
 * Stdio / fatal-handler guards.
 *
 * Broken TTY writes (EIO/EPIPE/…) emit `error` on stdout/stderr. Without a
 * listener those become `uncaughtException`. The postmortem handler then
 * writes to stderr / winston Console again → another EIO → another uncaught
 * → unbounded JS heap growth (observed: ~12万次 / 14GB in ~15s).
 *
 * These helpers:
 *   1. Absorb stdio stream `error` events so they never become uncaught.
 *   2. Provide a reentrant-safe fatal handler that exits on first reentry
 *      instead of logging again.
 */

const BROKEN_STDIO_CODES = new Set([
	"EIO",
	"EPIPE",
	"ENOTTY",
	"EBADF",
	"ERR_STREAM_DESTROYED",
	"ERR_STREAM_WRITE_AFTER_END",
]);

const GUARD_FLAG = Symbol.for("oh-my-pi.stdioErrorGuard");

/** True when `err` looks like a dead/broken stdout/stderr write. */
export function isBrokenStdioError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const code = (err as NodeJS.ErrnoException).code;
	return typeof code === "string" && BROKEN_STDIO_CODES.has(code);
}

/**
 * Attach a no-op `error` listener so broken-pipe events are not promoted to
 * uncaughtException. Safe to call multiple times on the same stream.
 */
export function installStdioErrorGuards(stream: NodeJS.WriteStream | NodeJS.ReadStream): void {
	const flagged = stream as NodeJS.WriteStream & { [GUARD_FLAG]?: boolean };
	if (flagged[GUARD_FLAG]) return;
	flagged[GUARD_FLAG] = true;
	stream.on("error", () => {
		// Intentionally swallow. Callers that care about write success already
		// check return values / use try-catch around sync writes.
	});
}

export type FatalHandlerDeps = {
	writeStderr: (text: string) => void;
	logError: (message: string, context?: Record<string, unknown>) => void;
	runCleanup: () => Promise<void>;
	exit: (code: number) => void;
	logMessage: string;
};

/**
 * Build a fatal-error handler with reentrancy protection.
 *
 * First call: best-effort stderr + log, then cleanup (unless broken stdio) and exit(1).
 * Reentrant calls: exit(1) immediately — no further logging (breaks the EIO storm).
 */
export function createFatalHandler(deps: FatalHandlerDeps): (label: string, err: Error) => Promise<void> {
	let handling = false;

	return async (label: string, err: Error): Promise<void> => {
		if (handling) {
			deps.exit(1);
			return;
		}
		handling = true;

		try {
			deps.writeStderr(formatFatalError(label, err));
		} catch {
			// stderr itself may be the broken stream
		}

		try {
			deps.logError(deps.logMessage, { err, stack: err.stack });
		} catch {
			// logger console transport may also hit EIO
		}

		// Dead TTY: skip cleanup (it may also try to write) and exit immediately.
		if (isBrokenStdioError(err)) {
			deps.exit(1);
			return;
		}

		try {
			await deps.runCleanup();
		} catch {
			// Cleanup failures must not prevent exit
		}
		deps.exit(1);
	};
}

export function formatFatalError(label: string, err: Error): string {
	const name = err.name || "Error";
	const message = err.message || "(no message)";
	const stack = err.stack || "";
	const stackLines = stack.split("\n").slice(1);
	const formattedStack = stackLines.length > 0 ? `\n${stackLines.join("\n")}` : "";
	return `\n[${label}] ${name}: ${message}${formattedStack}\n`;
}

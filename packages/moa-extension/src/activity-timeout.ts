/**
 * Dual timeout controller: hard wall-clock + idle (no-progress) kill.
 *
 * Used by plan workers so a hung tool call dies on idle, while a worker that
 * is still streaming tokens / tool results keeps running until `timeoutMs`.
 */
export interface ActivityTimeoutOptions {
	timeoutMs: number;
	/** 0 disables idle killing. */
	idleTimeoutMs?: number;
	onAbort: () => void;
}

export interface ActivityTimeoutController {
	bump: () => void;
	dispose: () => void;
	readonly timedOut: boolean;
	readonly idleTimedOut: boolean;
}

export function createActivityTimeout(options: ActivityTimeoutOptions): ActivityTimeoutController {
	const timeoutMs = Math.max(0, Math.floor(options.timeoutMs));
	const idleTimeoutMs = Math.max(0, Math.floor(options.idleTimeoutMs ?? 0));
	let timedOut = false;
	let idleTimedOut = false;
	let disposed = false;
	let hardHandle: ReturnType<typeof setTimeout> | undefined;
	let idleHandle: ReturnType<typeof setTimeout> | undefined;

	const fire = (idle: boolean) => {
		if (disposed || timedOut) return;
		timedOut = true;
		idleTimedOut = idle;
		try {
			options.onAbort();
		} catch {
			// ignore abort errors
		}
	};

	const armIdle = () => {
		if (idleHandle) clearTimeout(idleHandle);
		idleHandle = undefined;
		if (disposed || timedOut || idleTimeoutMs <= 0) return;
		idleHandle = setTimeout(() => fire(true), idleTimeoutMs);
	};

	if (timeoutMs > 0) {
		hardHandle = setTimeout(() => fire(false), timeoutMs);
	}
	armIdle();

	return {
		bump() {
			if (disposed || timedOut) return;
			armIdle();
		},
		dispose() {
			disposed = true;
			if (hardHandle) clearTimeout(hardHandle);
			if (idleHandle) clearTimeout(idleHandle);
			hardHandle = undefined;
			idleHandle = undefined;
		},
		get timedOut() {
			return timedOut;
		},
		get idleTimedOut() {
			return idleTimedOut;
		},
	};
}

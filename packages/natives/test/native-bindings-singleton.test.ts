/**
 * Regression: compiled omp + extension bundles must not dlopen pi_natives twice.
 * A process-global singleton (Symbol.for) lets a second loader evaluation reuse
 * the first bindings without calling process.dlopen again.
 */
import { describe, expect, it } from "bun:test";
import {
	NATIVE_BINDINGS_SYMBOL,
	getCachedNativeBindings,
	setCachedNativeBindings,
} from "../native/loader-state";

describe("pi_natives process-global bindings singleton", () => {
	it("exposes a stable Symbol.for key shared across realms", () => {
		expect(NATIVE_BINDINGS_SYMBOL).toBe(Symbol.for("@oh-my-pi/pi-natives.bindings"));
	});

	it("returns undefined when nothing has been cached yet", () => {
		const store: Record<symbol, unknown> = {};
		expect(getCachedNativeBindings(store)).toBeUndefined();
	});

	it("round-trips bindings through an injected global store", () => {
		const store: Record<symbol, unknown> = {};
		const bindings = { ping: () => "pong" };
		setCachedNativeBindings(bindings, store);
		expect(getCachedNativeBindings(store)).toBe(bindings);
	});
});

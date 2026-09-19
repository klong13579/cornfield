/**
 * pi:// protocol handler.
 *
 * `pi://` serves the embedded documentation index (a 1.6MB generated bundle).
 * The handler was changed to load that index on first use instead of at import
 * time, because a static import put it in the boot graph of every cornfield
 * process — including gateway children and non-interactive runs that never read
 * a doc.
 *
 * What these tests pin down is *behaviour*: listing, reading, nested paths,
 * error text, and the path guards. The deferral itself (that the index is no
 * longer in the boot graph) is measured, not unit-tested — see the heap
 * snapshots recorded with the change.
 */
import { describe, expect, test } from "bun:test";
import { PiProtocolHandler } from "../../src/internal-urls/pi-protocol";
import type { InternalUrl } from "../../src/internal-urls/types";

/** A pi:// URL as the parser hands it to the handler. */
function pi(input: string): InternalUrl {
	return new URL(input) as InternalUrl;
}

/**
 * A pi:// URL whose raw host/path segments are set directly. The handler reads
 * `rawHost`/`rawPathname` first (they preserve case and separators the WHATWG
 * URL parser would rewrite), so this is the shape hostile or unusual input
 * arrives in.
 */
function piRaw(rawHost: string, rawPathname?: string): InternalUrl {
	const url = new URL("pi://") as InternalUrl;
	url.rawHost = rawHost;
	if (rawPathname !== undefined) url.rawPathname = rawPathname;
	return url;
}

describe("PiProtocolHandler", () => {
	test("loads the embedded index lazily and works on first use", async () => {
		const handler = new PiProtocolHandler();
		const resource = await handler.resolve(pi("pi://"));

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.url).toBe("pi://");
		expect(resource.content.startsWith("# Documentation")).toBe(true);
		expect(resource.content).toContain("(pi://README.md)");
		expect(resource.size).toBeGreaterThan(0);
	});

	test("reads a named doc (index entry present in the listing)", async () => {
		const handler = new PiProtocolHandler();
		const listing = await handler.resolve(pi("pi://"));
		const resource = await handler.resolve(pi("pi://roadmap.md"));

		expect(listing.content).toContain("(pi://roadmap.md)");
		expect(resource.content.length).toBeGreaterThan(0);
		expect(resource.contentType).toBe("text/markdown");
		expect(resource.url).toBe("pi://roadmap.md");
	});

	test("reads a nested doc path", async () => {
		const handler = new PiProtocolHandler();
		const resource = await handler.resolve(pi("pi://agent/session.md"));

		expect(resource.content.length).toBeGreaterThan(0);
		expect(resource.content).toContain("session");
	});

	test("the lazy load is memoised: repeated reads stay consistent", async () => {
		const handler = new PiProtocolHandler();
		const first = await handler.resolve(pi("pi://roadmap.md"));
		const second = await handler.resolve(pi("pi://roadmap.md"));

		expect(second.content).toBe(first.content);
		expect(second.size).toBe(first.size);
	});

	test("unknown doc reports not-found with suggestions", async () => {
		const handler = new PiProtocolHandler();
		// "session" resolves to no exact entry but is a prefix of two real docs,
		// so the handler must offer them.
		const err = await handler.resolve(pi("pi://session")).catch((e: Error) => e);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("Documentation file not found: session");
		expect((err as Error).message).toContain("Did you mean");
		expect((err as Error).message).toContain("agent/session.md");
	});

	test("unknown doc with nothing similar points at the listing", async () => {
		const handler = new PiProtocolHandler();
		const err = await handler.resolve(pi("pi://zzzz-not-a-doc.md")).catch((e: Error) => e);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("Documentation file not found: zzzz-not-a-doc.md");
		expect((err as Error).message).toContain("Use pi:// to list available files.");
	});

	test("rejects absolute paths", async () => {
		const handler = new PiProtocolHandler();
		const err = await handler.resolve(piRaw("/etc/passwd")).catch((e: Error) => e);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("Absolute paths are not allowed");
	});

	test("rejects path traversal", async () => {
		const handler = new PiProtocolHandler();
		const err = await handler.resolve(piRaw("..", "/secrets.md")).catch((e: Error) => e);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("Path traversal");
	});
});

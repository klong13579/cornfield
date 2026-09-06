import { afterEach, describe, expect, it, vi } from "bun:test";
import { fetchLatestReleaseFromGithub } from "../src/cli/update-cli";

function mockFetchOnce(status: number, body: unknown, statusText?: string): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
		new Response(JSON.stringify(body), {
			status,
			statusText,
			headers: { "Content-Type": "application/json" },
		}),
	);
}

describe("fetchLatestReleaseFromGithub", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("parses the latest release tag and strips the v prefix", async () => {
		mockFetchOnce(200, { tag_name: "v1.2.3" });

		const release = await fetchLatestReleaseFromGithub("owner/repo");

		expect(release).toEqual({ tag: "v1.2.3", version: "1.2.3" });
	});

	it("requests the releases/latest endpoint of the given repo with a User-Agent", async () => {
		const spy = mockFetchOnce(200, { tag_name: "v1.1.0" });

		await fetchLatestReleaseFromGithub("klong13579/cornfield");

		const [url, init] = spy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.github.com/repos/klong13579/cornfield/releases/latest");
		expect((init.headers as Record<string, string>)["User-Agent"]).toBeTruthy();
	});

	it("propagates the abort signal to the fetch", async () => {
		const spy = mockFetchOnce(200, { tag_name: "v1.1.0" });
		const controller = new AbortController();

		await fetchLatestReleaseFromGithub("owner/repo", controller.signal);

		const [, init] = spy.mock.calls[0] as [string, RequestInit];
		expect(init.signal).toBe(controller.signal);
	});

	it("throws on a non-ok response (e.g. no releases yet)", async () => {
		mockFetchOnce(404, { message: "Not Found" }, "Not Found");

		await expect(fetchLatestReleaseFromGithub("owner/repo")).rejects.toThrow(
			/Failed to fetch release info: Not Found/,
		);
	});

	it("throws when the response has no tag_name", async () => {
		mockFetchOnce(200, {});

		await expect(fetchLatestReleaseFromGithub("owner/repo")).rejects.toThrow(/no tag_name/);
	});

	it("accepts a tag without the v prefix", async () => {
		mockFetchOnce(200, { tag_name: "1.2.3" });

		const release = await fetchLatestReleaseFromGithub("owner/repo");

		expect(release).toEqual({ tag: "1.2.3", version: "1.2.3" });
	});
});

import { describe, expect, test } from "bun:test";
import { EMPTY_BROWSER_STATE, mergeBrowserState, type PersistedCookie } from "@oh-my-pi/pi-coding-agent/tools";

function cookie(overrides: Partial<PersistedCookie> & Pick<PersistedCookie, "name" | "domain">): PersistedCookie {
	return {
		value: "val",
		path: "/",
		expires: -1,
		httpOnly: false,
		secure: false,
		sameSite: "Lax",
		...overrides,
	};
}

describe("mergeBrowserState — cookie deduplication", () => {
	test("same name+domain+path: new cookie overwrites old in full", () => {
		const existing = {
			...EMPTY_BROWSER_STATE,
			cookies: [cookie({ name: "session", domain: ".github.com", value: "old", secure: false })],
		};
		const merged = mergeBrowserState(
			existing,
			[cookie({ name: "session", domain: ".github.com", value: "new", secure: true })],
			"",
			{},
		);
		expect(merged.cookies).toHaveLength(1);
		expect(merged.cookies[0]!.value).toBe("new");
		expect(merged.cookies[0]!.secure).toBe(true);
	});

	test("same name, different domain: both survive", () => {
		const existing = { ...EMPTY_BROWSER_STATE, cookies: [cookie({ name: "token", domain: ".a.com" })] };
		const merged = mergeBrowserState(existing, [cookie({ name: "token", domain: ".b.com" })], "", {});
		expect(merged.cookies).toHaveLength(2);
		expect(merged.cookies.map(c => c.domain).sort()).toEqual([".a.com", ".b.com"]);
	});

	test("same name+domain, different path: both survive", () => {
		const existing = { ...EMPTY_BROWSER_STATE, cookies: [cookie({ name: "token", domain: ".a.com", path: "/" })] };
		const merged = mergeBrowserState(existing, [cookie({ name: "token", domain: ".a.com", path: "/api" })], "", {});
		expect(merged.cookies).toHaveLength(2);
		expect(merged.cookies.map(c => c.path).sort()).toEqual(["/", "/api"]);
	});
});

describe("mergeBrowserState — localStorage isolation", () => {
	test("different origins do not bleed into each other", () => {
		const existing = {
			...EMPTY_BROWSER_STATE,
			localStorage: { "https://a.com": { k1: "v1" } },
		};
		const merged = mergeBrowserState(existing, [], "https://b.com", { k2: "v2" });
		expect(merged.localStorage["https://a.com"]).toEqual({ k1: "v1" });
		expect(merged.localStorage["https://b.com"]).toEqual({ k2: "v2" });
	});

	test("same origin: new keys overwrite, old keys survive", () => {
		const existing = {
			...EMPTY_BROWSER_STATE,
			localStorage: { "https://a.com": { k1: "old", k2: "keep" } },
		};
		const merged = mergeBrowserState(existing, [], "https://a.com", { k1: "new", k3: "added" });
		expect(merged.localStorage["https://a.com"]).toEqual({ k1: "new", k2: "keep", k3: "added" });
	});

	test("empty localStorage data does not create origin entry", () => {
		const existing = { ...EMPTY_BROWSER_STATE };
		const merged = mergeBrowserState(existing, [], "https://a.com", {});
		expect(merged.localStorage).toEqual({});
	});
});

describe("mergeBrowserState — metadata", () => {
	test("updatedAt is set to a fresh ISO timestamp", () => {
		const before = new Date().toISOString();
		const merged = mergeBrowserState(EMPTY_BROWSER_STATE, [], "", {});
		const after = new Date().toISOString();
		expect(merged.updatedAt >= before).toBe(true);
		expect(merged.updatedAt <= after).toBe(true);
	});

	test("version is preserved as 1", () => {
		const merged = mergeBrowserState(EMPTY_BROWSER_STATE, [], "", {});
		expect(merged.version).toBe(1);
	});
});

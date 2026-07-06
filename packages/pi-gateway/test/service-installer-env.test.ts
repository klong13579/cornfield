/**
 * Service installer env-persistence contract tests.
 *
 * The launchd plist / systemd unit file must carry the resolved
 * `OMP_GATEWAY_TEST_*` env into the supervised process, otherwise issue-
 * reproduction (which depends on POST /test/inject being live) breaks
 * the moment the operator reinstalls the service. We don't actually run
 * launchd / systemd here — we just verify the generated config files
 * carry the right env entries, since that's the boundary between
 * `service install` and the supervised process's env.
 *
 * Resolution rules (see `resolvePersistedEnv` in service-installer.ts):
 *   1. Explicit non-empty shell value wins.
 *   2. Otherwise `PERSISTED_ENV_DEFAULTS` applies.
 *   3. Otherwise the var is omitted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	gatewayServicePath,
	generateLaunchdPlist,
	generateSystemdService,
	PERSISTED_ENV_DEFAULTS,
	PERSISTED_ENV_VARS,
	resolvePersistedEnv,
} from "../src/service-installer";

describe("resolvePersistedEnv", () => {
	const originalEnv = { ...process.env };
	afterEach(() => {
		// Restore the original env, only touching the keys we set
		for (const name of PERSISTED_ENV_VARS) {
			if (originalEnv[name] === undefined) delete process.env[name];
			else process.env[name] = originalEnv[name];
		}
	});

	test("applies defaults when the shell has neither var", () => {
		delete process.env.OMP_GATEWAY_TEST_MODE;
		delete process.env.OMP_GATEWAY_TEST_PORT;
		expect(resolvePersistedEnv()).toEqual({
			OMP_GATEWAY_TEST_MODE: "1",
			OMP_GATEWAY_TEST_PORT: "7890",
		});
	});

	test("uses explicit shell value when set", () => {
		process.env.OMP_GATEWAY_TEST_MODE = "1";
		process.env.OMP_GATEWAY_TEST_PORT = "9000";
		expect(resolvePersistedEnv()).toEqual({
			OMP_GATEWAY_TEST_MODE: "1",
			OMP_GATEWAY_TEST_PORT: "9000",
		});
	});

	test("respects explicit opt-out (e.g. 0) over the default", () => {
		process.env.OMP_GATEWAY_TEST_MODE = "0";
		delete process.env.OMP_GATEWAY_TEST_PORT;
		expect(resolvePersistedEnv()).toEqual({
			OMP_GATEWAY_TEST_MODE: "0",
			OMP_GATEWAY_TEST_PORT: "7890",
		});
	});

	test("treats empty-string shell values as unset (default applies)", () => {
		process.env.OMP_GATEWAY_TEST_MODE = "";
		process.env.OMP_GATEWAY_TEST_PORT = "";
		expect(resolvePersistedEnv()).toEqual({
			OMP_GATEWAY_TEST_MODE: "1",
			OMP_GATEWAY_TEST_PORT: "7890",
		});
	});

	test("mixes default + explicit (one set, one not)", () => {
		delete process.env.OMP_GATEWAY_TEST_MODE;
		process.env.OMP_GATEWAY_TEST_PORT = "9999";
		expect(resolvePersistedEnv()).toEqual({
			OMP_GATEWAY_TEST_MODE: "1",
			OMP_GATEWAY_TEST_PORT: "9999",
		});
	});

	test("respects the allowlist ordering", () => {
		process.env.OMP_GATEWAY_TEST_PORT = "7890";
		process.env.OMP_GATEWAY_TEST_MODE = "1";
		expect(Object.keys(resolvePersistedEnv())).toEqual(["OMP_GATEWAY_TEST_MODE", "OMP_GATEWAY_TEST_PORT"]);
	});

	test("accepts an explicit env snapshot for hermetic tests", () => {
		const env = { OMP_GATEWAY_TEST_MODE: "1", OMP_GATEWAY_TEST_PORT: "9000" };
		expect(resolvePersistedEnv(env)).toEqual({
			OMP_GATEWAY_TEST_MODE: "1",
			OMP_GATEWAY_TEST_PORT: "9000",
		});
	});

	test("PERSISTED_ENV_DEFAULTS stays in sync with PERSISTED_ENV_VARS", () => {
		// Guard: every defaulted name must also be in the allowlist, so
		// resolvePersistedEnv actually emits it.
		for (const name of Object.keys(PERSISTED_ENV_DEFAULTS)) {
			expect(PERSISTED_ENV_VARS).toContain(name);
		}
	});
});

describe("gatewayServicePath", () => {
	test("lists ~/.local/bin first so user-installed CLIs win", () => {
		const path = gatewayServicePath({ HOME: "/Users/test" });
		const segments = path.split(":");
		expect(segments[0]).toBe("/Users/test/.local/bin");
		// .local/bin must come BEFORE .bun/bin and before /opt/homebrew/bin
		expect(segments.indexOf("/Users/test/.local/bin")).toBeLessThan(segments.indexOf("/Users/test/.bun/bin"));
		expect(segments.indexOf("/Users/test/.local/bin")).toBeLessThan(segments.indexOf("/opt/homebrew/bin"));
	});

	test("expands $HOME from the env argument (hermetic)", () => {
		const path = gatewayServicePath({ HOME: "/custom/home" });
		expect(path.startsWith("/custom/home/.local/bin:")).toBe(true);
		expect(path).not.toContain("$HOME");
	});

	test("includes all the standard install dirs", () => {
		const path = gatewayServicePath({ HOME: "/Users/test" });
		for (const required of [
			"/Users/test/.local/bin",
			"/Users/test/.bun/bin",
			"/opt/homebrew/bin",
			"/usr/local/bin",
			"/usr/bin",
			"/bin",
			"/usr/sbin",
			"/sbin",
		]) {
			expect(path.split(":")).toContain(required);
		}
	});
});

describe("generateLaunchdPlist env persistence", () => {
	test("emits defaults when no OMP_GATEWAY_TEST_* is set", () => {
		const env: NodeJS.ProcessEnv = { HOME: "/Users/test" };
		const plist = generateLaunchdPlist("/tmp/log", env);
		const envSection = plist.split("<key>EnvironmentVariables</key>")[1]?.split("</dict>")[0] ?? "";
		expect(envSection).toContain("<key>PATH</key>");
		expect(envSection).toContain("/Users/test/.local/bin");
		expect(envSection).toContain("<key>OMP_GATEWAY_TEST_MODE</key>\n\t\t<string>1</string>");
		expect(envSection).toContain("<key>OMP_GATEWAY_TEST_PORT</key>\n\t\t<string>7890</string>");
	});

	test("uses explicit OMP_GATEWAY_TEST_MODE=1 when set", () => {
		const env: NodeJS.ProcessEnv = { HOME: "/Users/test", OMP_GATEWAY_TEST_MODE: "1" };
		const plist = generateLaunchdPlist("/tmp/log", env);
		expect(plist).toContain("<key>OMP_GATEWAY_TEST_MODE</key>");
		expect(plist).toContain("<string>1</string>");
	});

	test("respects explicit opt-out (0) over the default", () => {
		const env: NodeJS.ProcessEnv = { HOME: "/Users/test", OMP_GATEWAY_TEST_MODE: "0" };
		const plist = generateLaunchdPlist("/tmp/log", env);
		expect(plist).toContain("<key>OMP_GATEWAY_TEST_MODE</key>\n\t\t<string>0</string>");
		expect(plist).toContain("<key>OMP_GATEWAY_TEST_PORT</key>\n\t\t<string>7890</string>");
	});

	test("includes both vars with both values when both are set", () => {
		const env: NodeJS.ProcessEnv = {
			HOME: "/Users/test",
			OMP_GATEWAY_TEST_MODE: "1",
			OMP_GATEWAY_TEST_PORT: "9000",
		};
		const plist = generateLaunchdPlist("/tmp/log", env);
		expect(plist).toContain("<key>OMP_GATEWAY_TEST_MODE</key>\n\t\t<string>1</string>");
		expect(plist).toContain("<key>OMP_GATEWAY_TEST_PORT</key>\n\t\t<string>9000</string>");
	});

	test("XML-escapes values containing XML metacharacters", () => {
		const env: NodeJS.ProcessEnv = {
			HOME: "/Users/test",
			OMP_GATEWAY_TEST_MODE: 'a&b<c>"',
		};
		const plist = generateLaunchdPlist("/tmp/log", env);
		// Each metacharacter must be replaced with the entity reference
		expect(plist).toContain("a&amp;b&lt;c&gt;&quot;");
		expect(plist).not.toContain('a&b<c>"');
	});
});

describe("generateSystemdService env persistence", () => {
	test("emits defaults when no OMP_GATEWAY_TEST_* is set", () => {
		const env: NodeJS.ProcessEnv = { HOME: "/Users/test" };
		const unit = generateSystemdService("/tmp/log", env);
		const serviceSection = unit.split("[Service]")[1]?.split("[Install]")[0] ?? "";
		expect(serviceSection).toContain('Environment="PATH=');
		expect(serviceSection).toContain("/Users/test/.local/bin");
		expect(serviceSection).toContain('Environment="OMP_GATEWAY_TEST_MODE=1"');
		expect(serviceSection).toContain('Environment="OMP_GATEWAY_TEST_PORT=7890"');
	});

	test("includes OMP_GATEWAY_TEST_MODE=1 when set", () => {
		const env: NodeJS.ProcessEnv = { HOME: "/Users/test", OMP_GATEWAY_TEST_MODE: "1" };
		const unit = generateSystemdService("/tmp/log", env);
		expect(unit).toContain('Environment="OMP_GATEWAY_TEST_MODE=1"');
	});

	test("respects explicit opt-out (0) over the default", () => {
		const env: NodeJS.ProcessEnv = { HOME: "/Users/test", OMP_GATEWAY_TEST_MODE: "0" };
		const unit = generateSystemdService("/tmp/log", env);
		expect(unit).toContain('Environment="OMP_GATEWAY_TEST_MODE=0"');
		expect(unit).toContain('Environment="OMP_GATEWAY_TEST_PORT=7890"');
	});

	test("includes both vars with both values when both are set", () => {
		const env: NodeJS.ProcessEnv = {
			HOME: "/Users/test",
			OMP_GATEWAY_TEST_MODE: "1",
			OMP_GATEWAY_TEST_PORT: "9000",
		};
		const unit = generateSystemdService("/tmp/log", env);
		expect(unit).toContain('Environment="OMP_GATEWAY_TEST_MODE=1"');
		expect(unit).toContain('Environment="OMP_GATEWAY_TEST_PORT=9000"');
	});

	test("escapes embedded double quotes and backslashes in values", () => {
		const env: NodeJS.ProcessEnv = {
			HOME: "/Users/test",
			OMP_GATEWAY_TEST_MODE: 'a"b\\c',
		};
		const unit = generateSystemdService("/tmp/log", env);
		// Backslashes doubled, double-quotes backslash-escaped
		expect(unit).toContain('Environment="OMP_GATEWAY_TEST_MODE=a\\"b\\\\c"');
	});
});

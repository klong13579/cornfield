/**
 * Service installer env-persistence contract tests.
 *
 * The launchd plist / systemd unit file must carry any operator-set
 * OMP_GATEWAY_TEST_* env into the supervised process, otherwise issue-
 * reproduction (which depends on POST /test/inject being live) breaks
 * the moment the operator reinstalls the service. We don't actually run
 * launchd / systemd here — we just verify the generated config files
 * carry the right env entries, since that's the boundary between
 * `service install` and the supervised process's env.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	generateLaunchdPlist,
	generateSystemdService,
	getPersistedEnvNames,
	PERSISTED_ENV_VARS,
} from "../src/service-installer";

describe("getPersistedEnvNames", () => {
	const originalEnv = { ...process.env };
	afterEach(() => {
		// Restore the original env, only touching the keys we set
		for (const name of PERSISTED_ENV_VARS) {
			if (originalEnv[name] === undefined) delete process.env[name];
			else process.env[name] = originalEnv[name];
		}
	});

	test("returns the allowlist when every var is set", () => {
		process.env.OMP_GATEWAY_TEST_MODE = "1";
		process.env.OMP_GATEWAY_TEST_PORT = "7890";
		expect(getPersistedEnvNames()).toEqual(["OMP_GATEWAY_TEST_MODE", "OMP_GATEWAY_TEST_PORT"]);
	});

	test("skips vars that are unset", () => {
		delete process.env.OMP_GATEWAY_TEST_MODE;
		process.env.OMP_GATEWAY_TEST_PORT = "7890";
		expect(getPersistedEnvNames()).toEqual(["OMP_GATEWAY_TEST_PORT"]);
	});

	test("skips vars that are set to empty string", () => {
		process.env.OMP_GATEWAY_TEST_MODE = "";
		process.env.OMP_GATEWAY_TEST_PORT = "7890";
		expect(getPersistedEnvNames()).toEqual(["OMP_GATEWAY_TEST_PORT"]);
	});

	test("respects the allowlist ordering", () => {
		process.env.OMP_GATEWAY_TEST_PORT = "7890";
		process.env.OMP_GATEWAY_TEST_MODE = "1";
		expect(getPersistedEnvNames()).toEqual(["OMP_GATEWAY_TEST_MODE", "OMP_GATEWAY_TEST_PORT"]);
	});

	test("accepts an explicit env snapshot for hermetic tests", () => {
		const env = { OMP_GATEWAY_TEST_MODE: "1", OMP_GATEWAY_TEST_PORT: "9000" };
		expect(getPersistedEnvNames(env)).toEqual(["OMP_GATEWAY_TEST_MODE", "OMP_GATEWAY_TEST_PORT"]);
	});
});

describe("generateLaunchdPlist env persistence", () => {
	test("omits persisted-env block when no OMP_GATEWAY_TEST_* is set", () => {
		const env: NodeJS.ProcessEnv = { HOME: "/Users/test" };
		const plist = generateLaunchdPlist("/tmp/log", env);
		// Only the static PATH entry should be inside EnvironmentVariables
		const envSection = plist.split("<key>EnvironmentVariables</key>")[1]?.split("</dict>")[0] ?? "";
		expect(envSection).toContain("<key>PATH</key>");
		expect(envSection).not.toContain("OMP_GATEWAY_TEST_MODE");
		expect(envSection).not.toContain("OMP_GATEWAY_TEST_PORT");
	});

	test("includes OMP_GATEWAY_TEST_MODE=1 when set", () => {
		const env: NodeJS.ProcessEnv = { HOME: "/Users/test", OMP_GATEWAY_TEST_MODE: "1" };
		const plist = generateLaunchdPlist("/tmp/log", env);
		expect(plist).toContain("<key>OMP_GATEWAY_TEST_MODE</key>");
		expect(plist).toContain("<string>1</string>");
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
	test("omits persisted-env lines when no OMP_GATEWAY_TEST_* is set", () => {
		const env: NodeJS.ProcessEnv = { HOME: "/Users/test" };
		const unit = generateSystemdService("/tmp/log", env);
		const serviceSection = unit.split("[Service]")[1]?.split("[Install]")[0] ?? "";
		expect(serviceSection).toContain('Environment="PATH=');
		expect(serviceSection).not.toContain("OMP_GATEWAY_TEST_MODE");
		expect(serviceSection).not.toContain("OMP_GATEWAY_TEST_PORT");
	});

	test("includes OMP_GATEWAY_TEST_MODE=1 when set", () => {
		const env: NodeJS.ProcessEnv = { HOME: "/Users/test", OMP_GATEWAY_TEST_MODE: "1" };
		const unit = generateSystemdService("/tmp/log", env);
		expect(unit).toContain('Environment="OMP_GATEWAY_TEST_MODE=1"');
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

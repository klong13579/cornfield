/**
 * Gateway skill picker tests.
 *
 * Verifies:
 * - isSkillCommand() matches the trigger set (/skills, /skill,
 *   /skills <filter>, /skill <name>) case-insensitively, and
 *   ignores non-matches (especially CJK continuation false-positives,
 *   mirroring the NewSessionHandler test).
 * - handle() intercepts the command:
 *   - no arg → plain-text markdown list of all skills
 *   - exact skill name arg → direct invocation (setPending + reply)
 *   - filter arg → plain-text markdown list filtered to the substring
 *   - non-matching arg → "没有匹配" reply
 *   - empty skill cache → "当前没有可用" reply
 * - applyPendingSkillContext() reads the cached skill file and prepends
 *   the skill content as a system note to the next inbound message
 * - consumePendingSkill() is one-shot
 * - pending skills expire after TTL
 *
 * Uses an in-memory SkillCache backed by a real temp dir with SKILL.md
 * files (mirroring how the real gateway resolves skills from disk).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SkillCommand } from "../src/gateway-skills";
import { SkillCache } from "../src/skill-cache";
import type { InboundMessage } from "../src/types";

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function makeInbound(text: string, conversationId = "conv-test"): InboundMessage {
	return {
		channelId: "dingtalk",
		accountId: "ops",
		userId: "user1",
		conversationId,
		isGroup: false,
		content: { type: "text", text },
		timestamp: new Date(),
	};
}

async function makeSkillDir(rootDir: string, skills: Array<{ name: string; description: string }>): Promise<string> {
	const skillsDir = path.join(rootDir, ".omp", "agent", "skills");
	await fs.mkdir(skillsDir, { recursive: true });
	for (const s of skills) {
		const dir = path.join(skillsDir, s.name);
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(
			path.join(dir, "SKILL.md"),
			`---\ndescription: ${s.description}\n---\n\n# ${s.name}\n\nBody of ${s.name}.`,
		);
	}
	return skillsDir;
}

/** Read all SKILL.md files from a `dir/<name>/SKILL.md` shape and return
 *  Skill objects. Mirrors the production loadSkills behavior closely enough
 *  for our test surface — we only need name + description + filePath. */
async function loadSkillsFromDir(
	dir: string,
	level: "user" | "project" = "user",
): Promise<
	Array<{
		name: string;
		description: string;
		filePath: string;
		baseDir: string;
		source: string;
		level: "user" | "project";
	}>
> {
	const out: Array<{
		name: string;
		description: string;
		filePath: string;
		baseDir: string;
		source: string;
		level: "user" | "project";
	}> = [];
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		const skillFile = path.join(dir, entry.name, "SKILL.md");
		try {
			const content = await Bun.file(skillFile).text();
			const descMatch = content.match(/^---\n([\s\S]*?)\n---/);
			let description = "";
			if (descMatch) {
				const descLine = descMatch[1]?.match(/^description:\s*(.+)$/m);
				if (descLine) description = descLine[1]?.trim() ?? "";
			}
			out.push({
				name: entry.name,
				description,
				filePath: skillFile,
				baseDir: path.join(dir, entry.name),
				source: `test:${level}`,
				level,
			});
		} catch {
			// skip
		}
	}
	return out;
}

interface StubChannelOpts {
	sentMessages?: OutboundMessage[];
}

function makeStubChannel(opts: StubChannelOpts = {}): DingTalkChannel {
	const sent = opts.sentMessages ?? [];
	const stub = {
		id: "dingtalk",
		name: "DingTalk",
		sendMessage: async (msg: OutboundMessage) => {
			sent.push(msg);
		},
	} as unknown as DingTalkChannel;
	return stub;
}

function makeHarness(
	skillsDir: string,
	_channel: DingTalkChannel,
	opts: { resolveDisabledExtensions?: () => string[] | Promise<string[]> } = {},
) {
	const skillCache = new SkillCache({
		resolveCwd: () => skillsDir,
		// Inject a deterministic loader so the test doesn't depend on
		// the real `os.homedir()`-backed `loadSkills` (Bun caches
		// `os.homedir()` so HOME overrides in beforeEach don't
		// propagate). The loader mirrors the production behavior of
		// filtering out skills whose name appears in
		// `disabledExtensions` (after stripping the `skill:` prefix,
		// matching what `loadSkills` in the coding-agent does).
		loader: async ({ disabledExtensions } = {}) => {
			const skills = await loadSkillsFromDir(skillsDir);
			const disabled = new Set(
				(disabledExtensions ?? []).filter(id => id.startsWith("skill:")).map(id => id.slice("skill:".length)),
			);
			const filtered = skills.filter(s => !disabled.has(s.name));
			return { skills: filtered as never, warnings: [] };
		},
		resolveDisabledExtensions: opts.resolveDisabledExtensions,
	});

	let lastReplyText = "";
	const command = new SkillCommand({
		skillCache,
		sendAgentResponse: async (_msg, text) => {
			lastReplyText = text;
		},
		extractMessageText: m => (m.content.type === "text" ? m.content.text : ""),
	});
	return { command, skillCache, getReply: () => lastReplyText };
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("SkillCommand", () => {
	let rootDir: string;
	let skillsDir: string;

	beforeEach(async () => {
		rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gw-skill-"));
		skillsDir = await makeSkillDir(rootDir, [
			{ name: "triage-ticket", description: "工单分诊与归类" },
			{ name: "weekly-report", description: "周报生成" },
			{ name: "debug-issue", description: "排查问题" },
		]);
	});

	afterEach(async () => {
		await fs.rm(rootDir, { recursive: true, force: true });
	});

	// ───────────────────────────────────────────────────────────────
	// Trigger detection
	// ───────────────────────────────────────────────────────────────

	describe("isSkillCommand", () => {
		test.each([
			"/skills",
			"/skill",
			"/skills triage",
			"/skill triage",
			"/skills   ticket",
			"  /skills",
			"  /skill",
			"/SKILL",
			"/SKILLS",
			"/Skill foo",
			"/Skills foo",
		])("matches %p", text => {
			const channel = makeStubChannel();
			const h = makeHarness(skillsDir, channel);
			expect(h.command.isSkillCommand(text)).toBe(true);
		});

		test.each([
			"hello",
			"what is /skills?",
			"create /skills file",
			"使用 /skills",
			"/skillstest",
			"/skillsa",
			"/skillst",
			"/s",
			"//skill",
			"//skills",
			"",
			" ",
		])("does NOT match %p", text => {
			const channel = makeStubChannel();
			const h = makeHarness(skillsDir, channel);
			expect(h.command.isSkillCommand(text)).toBe(false);
		});
	});

	// ───────────────────────────────────────────────────────────────
	// /skills slash command interception
	// ───────────────────────────────────────────────────────────────

	describe("handle (slash command)", () => {
		test("/skills (no arg) replies with a markdown list of all skills", async () => {
			const channel = makeStubChannel();
			const h = makeHarness(skillsDir, channel);

			const handled = await h.command.handle(makeInbound("/skills"), "ops");
			expect(handled).toBe(true);
			const reply = h.getReply();
			expect(reply).toContain("可用技能");
			expect(reply).toContain("(3)"); // 3 skills seeded in beforeEach
			expect(reply).toContain("**triage-ticket**");
			expect(reply).toContain("**weekly-report**");
			expect(reply).toContain("**debug-issue**");
			// Header + per-skill lines + usage hint
			expect(reply).toContain("/skill <name>");
			// Descriptions are NOT rendered in the IM list — the
			// message should be name-only, kept compact for mobile.
			expect(reply).not.toContain("工单分诊与归类");
			expect(reply).not.toContain("周报生成");
			expect(reply).not.toContain("排查问题");
			// Per-skill line is exactly `name`, no `— description` tail.
			expect(reply).toMatch(/^- 📚 \*\*triage-ticket\*\*$/m);
		});

		test("/skills sorts skills by name for stable output", async () => {
			const channel = makeStubChannel();
			const h = makeHarness(skillsDir, channel);
			await h.command.handle(makeInbound("/skills"), "ops");
			const reply = h.getReply();
			// debug < triage < weekly alphabetically
			const dIdx = reply.indexOf("**debug-issue**");
			const tIdx = reply.indexOf("**triage-ticket**");
			const wIdx = reply.indexOf("**weekly-report**");
			expect(dIdx).toBeGreaterThan(-1);
			expect(tIdx).toBeGreaterThan(dIdx);
			expect(wIdx).toBeGreaterThan(tIdx);
		});

		test("/skills with filter narrows the list and shows the filtered subset", async () => {
			const channel = makeStubChannel();
			const h = makeHarness(skillsDir, channel);
			await h.command.handle(makeInbound("/skills triage"), "ops");
			const reply = h.getReply();
			expect(reply).toContain("可用技能");
			expect(reply).toContain("(1)"); // only triage-ticket matches "triage"
			expect(reply).toContain("**triage-ticket**");
			expect(reply).not.toContain("**weekly-report**");
			expect(reply).not.toContain("**debug-issue**");
		});

		test("/skills with non-matching filter replies and consumes", async () => {
			const channel = makeStubChannel();
			const h = makeHarness(skillsDir, channel);
			const handled = await h.command.handle(makeInbound("/skills nonexistent"), "ops");
			expect(handled).toBe(true);
			expect(h.getReply()).toContain("没有匹配");
			expect(h.getReply()).toContain("nonexistent");
		});

		test("/skills with no skills available replies with helpful text", async () => {
			const emptyDir = path.join(rootDir, "empty");
			await fs.mkdir(path.join(emptyDir, ".omp", "agent"), { recursive: true });

			const channel = makeStubChannel();
			const h = makeHarness(emptyDir, channel);

			const handled = await h.command.handle(makeInbound("/skills"), "ops");
			expect(handled).toBe(true);
			expect(h.getReply()).toContain("当前没有可用的技能");
		});

		test("/skills with 12 skills still renders all 12 in one text message (no card pagination)", async () => {
			const bigDir = path.join(rootDir, "big");
			await fs.mkdir(bigDir, { recursive: true });
			for (let i = 0; i < 12; i++) {
				const dir = path.join(bigDir, `skill-${i.toString().padStart(2, "0")}`);
				await fs.mkdir(dir, { recursive: true });
				await Bun.write(path.join(dir, "SKILL.md"), `---\ndescription: Skill ${i}\n---\n\n# Skill ${i}`);
			}

			const channel = makeStubChannel();
			const h = makeHarness(bigDir, channel);

			const handled = await h.command.handle(makeInbound("/skills"), "ops");
			expect(handled).toBe(true);
			const reply = h.getReply();
			expect(reply).toContain("(12)");
			// All 12 names should be in the output (not paginated).
			for (let i = 0; i < 12; i++) {
				expect(reply).toContain(`**skill-${i.toString().padStart(2, "0")}**`);
			}
			// No "还有" follow-up text (no pagination).
			expect(reply).not.toContain("还有");
		});

		test("non-matching message returns false and does NOT reply", async () => {
			const channel = makeStubChannel();
			const h = makeHarness(skillsDir, channel);

			const handled = await h.command.handle(makeInbound("hello world"), "ops");
			expect(handled).toBe(false);
			expect(h.getReply()).toBe("");
		});

		// ───────────────────────────────────────────────────────
		// /skill (singular) alias
		// ───────────────────────────────────────────────────────

		test("/skill (no arg, singular) shows the same list as /skills", async () => {
			const channel = makeStubChannel();
			const h = makeHarness(skillsDir, channel);

			const handled = await h.command.handle(makeInbound("/skill"), "ops");
			expect(handled).toBe(true);
			const reply = h.getReply();
			expect(reply).toContain("可用技能");
			expect(reply).toContain("**triage-ticket**");
			expect(reply).toContain("**weekly-report**");
			expect(reply).toContain("**debug-issue**");
		});

		// ───────────────────────────────────────────────────────
		// /skill <name> direct invocation
		// ───────────────────────────────────────────────────────

		test("/skill <exact_name> directly invokes (sets pending, replies)", async () => {
			const channel = makeStubChannel();
			const h = makeHarness(skillsDir, channel);

			const handled = await h.command.handle(makeInbound("/skill triage-ticket"), "ops");
			expect(handled).toBe(true);
			const reply = h.getReply();
			expect(reply).toContain("triage-ticket");
			expect(reply).toContain("已选择");
			// Description is NOT rendered in the confirmation — name only.
			expect(reply).not.toContain("工单分诊与归类");
			// Pending was set
			expect(h.command.consumePendingSkill("ops", makeInbound("").conversationId)).toBe("triage-ticket");
		});

		test("/skill <filter> (no exact match) falls back to filtered list", async () => {
			const channel = makeStubChannel();
			const h = makeHarness(skillsDir, channel);

			const handled = await h.command.handle(makeInbound("/skill weekly"), "ops");
			expect(handled).toBe(true);
			// "weekly" doesn't match any exact name, so filter kicks in.
			// Substring match picks up "weekly-report".
			const reply = h.getReply();
			expect(reply).toContain("可用技能");
			expect(reply).toContain("(1)");
			expect(reply).toContain("**weekly-report**");
		});

		test("/skill <unknown_name> replies not-found and consumes", async () => {
			const channel = makeStubChannel();
			const h = makeHarness(skillsDir, channel);

			const handled = await h.command.handle(makeInbound("/skill ghost-skill"), "ops");
			expect(handled).toBe(true);
			const reply = h.getReply();
			expect(reply).toContain("ghost-skill");
			expect(reply).toContain("没有匹配");
		});
	});

	// ───────────────────────────────────────────────────────────────
	// applyPendingSkillContext: prepend on next message
	// ───────────────────────────────────────────────────────────────

	describe("applyPendingSkillContext", () => {
		test("consumes pending skill, reads file, prepends to message", async () => {
			const channel = makeStubChannel();
			const h = makeHarness(skillsDir, channel);

			// Set up a pending skill (bypass /skill invocation)
			h.command.setPendingSkill("ops", "conv-1", "triage-ticket");

			const msg = makeInbound("帮我处理工单 #12345", "conv-1");
			const modified = await h.command.applyPendingSkillContext(msg, "ops", "conv-1");

			expect(modified).toBe(true);
			if (msg.content.type !== "text") throw new Error("expected text");
			// Pending was consumed
			expect(h.command.consumePendingSkill("ops", "conv-1")).toBeNull();
			// Skill content prepended as system note + skill block
			expect(msg.content.text).toContain("[System note:");
			expect(msg.content.text).toContain("triage-ticket");
			expect(msg.content.text).toContain("# triage-ticket");
			expect(msg.content.text).toContain("Body of triage-ticket");
			// User message follows
			expect(msg.content.text).toContain("帮我处理工单 #12345");
		});

		test("returns false and is a no-op when no pending skill", async () => {
			const channel = makeStubChannel();
			const h = makeHarness(skillsDir, channel);

			const msg = makeInbound("hello", "conv-1");
			const modified = await h.command.applyPendingSkillContext(msg, "ops", "conv-1");
			expect(modified).toBe(false);
			if (msg.content.type !== "text") throw new Error("expected text");
			expect(msg.content.text).toBe("hello");
		});

		test("is one-shot — second call returns false", async () => {
			const channel = makeStubChannel();
			const h = makeHarness(skillsDir, channel);
			h.command.setPendingSkill("ops", "conv-1", "triage-ticket");

			const msg1 = makeInbound("first", "conv-1");
			const msg2 = makeInbound("second", "conv-1");

			expect(await h.command.applyPendingSkillContext(msg1, "ops", "conv-1")).toBe(true);
			expect(await h.command.applyPendingSkillContext(msg2, "ops", "conv-1")).toBe(false);
			if (msg2.content.type !== "text") throw new Error("expected text");
			expect(msg2.content.text).toBe("second");
		});

		test("handles markdown content type", async () => {
			const channel = makeStubChannel();
			const h = makeHarness(skillsDir, channel);
			h.command.setPendingSkill("ops", "conv-1", "weekly-report");

			const msg: InboundMessage = {
				...makeInbound(""),
				content: { type: "markdown", markdown: "请给我周报" },
			};
			await h.command.applyPendingSkillContext(msg, "ops", "conv-1");
			if (msg.content.type !== "markdown") throw new Error("expected markdown");
			expect(msg.content.markdown).toContain("# weekly-report");
			expect(msg.content.markdown).toContain("请给我周报");
		});
	});

	// ───────────────────────────────────────────────────────────────
	// End-to-end: /skill <name> → next message
	// ───────────────────────────────────────────────────────────────

	describe("end-to-end /skill <name> → next message", () => {
		const E2E_CONV = "e2e-conv";

		test("user picks via direct invocation, then types a real request, gets the skill context prepended", async () => {
			const channel = makeStubChannel();
			const h = makeHarness(skillsDir, channel);

			// 1. User types /skill triage-ticket → direct invoke (sets pending, replies)
			expect(await h.command.handle(makeInbound("/skill triage-ticket", E2E_CONV), "ops")).toBe(true);

			// 2. User types a real request → skill context prepended
			const msg = makeInbound("处理工单 #12345", E2E_CONV);
			await h.command.applyPendingSkillContext(msg, "ops", E2E_CONV);
			if (msg.content.type !== "text") throw new Error("expected text");
			expect(msg.content.text).toMatch(/\[System note:.*triage-ticket.*\]/s);
			expect(msg.content.text).toContain("Body of triage-ticket");
			expect(msg.content.text).toContain("处理工单 #12345");
		});

		test("user /skills → /skill <name> → next message: same outcome as direct invocation", async () => {
			const channel = makeStubChannel();
			const h = makeHarness(skillsDir, channel);

			// 1. User browses /skills → text list (no card)
			expect(await h.command.handle(makeInbound("/skills", E2E_CONV), "ops")).toBe(true);
			expect(h.getReply()).toContain("**triage-ticket**");

			// 2. User types /skill triage-ticket → direct invoke
			expect(await h.command.handle(makeInbound("/skill triage-ticket", E2E_CONV), "ops")).toBe(true);
			expect(h.getReply()).toContain("已选择");

			// 3. User types a real request → skill context prepended
			const msg = makeInbound("处理工单 #12345", E2E_CONV);
			await h.command.applyPendingSkillContext(msg, "ops", E2E_CONV);
			if (msg.content.type !== "text") throw new Error("expected text");
			expect(msg.content.text).toContain("Body of triage-ticket");
		});
	});

	// ───────────────────────────────────────────────────────────────
	// SkillCache integration
	// ───────────────────────────────────────────────────────────────

	describe("SkillCache", () => {
		const makeCache = (dir = skillsDir) =>
			new SkillCache({
				resolveCwd: () => dir,
				loader: async () => {
					const skills = await loadSkillsFromDir(dir);
					return { skills: skills as never, warnings: [] };
				},
			});

		test("getSkills returns skills from disk; subsequent calls hit cache", async () => {
			const cache = makeCache();
			const a = await cache.getSkills("ops");
			const b = await cache.getSkills("ops");
			expect(a).toBe(b); // same array reference → cache hit
			expect(a.map(s => s.name).sort()).toEqual(["debug-issue", "triage-ticket", "weekly-report"]);
		});

		test("getSkillContent reads the SKILL.md file", async () => {
			const cache = makeCache();
			const content = await cache.getSkillContent("triage-ticket", "ops");
			expect(content).toContain("Body of triage-ticket");
		});

		test("getSkillContent returns null for unknown skill", async () => {
			const cache = makeCache();
			expect(await cache.getSkillContent("does-not-exist", "ops")).toBeNull();
		});

		test("invalidate forces re-scan", async () => {
			const cache = makeCache();
			const a = await cache.getSkills("ops");
			cache.invalidate("ops");
			const b = await cache.getSkills("ops");
			expect(a).not.toBe(b);
			expect(a.length).toBe(b.length);
		});

		// ─────────────────────────────────────────────────────────────
		// disabledExtensions wiring (Q8: per-account filter)
		// ─────────────────────────────────────────────────────────────

		describe("disabledExtensions filtering", () => {
			const makeCacheWithDisabled = (disabled: string[] | (() => string[] | Promise<string[]>)) =>
				new SkillCache({
					resolveCwd: () => skillsDir,
					resolveDisabledExtensions: typeof disabled === "function" ? disabled : async () => disabled,
					loader: async ({ disabledExtensions } = {}) => {
						const skills = await loadSkillsFromDir(skillsDir);
						const blocked = new Set(
							(disabledExtensions ?? [])
								.filter(id => id.startsWith("skill:"))
								.map(id => id.slice("skill:".length)),
						);
						return {
							skills: skills.filter(s => !blocked.has(s.name)) as never,
							warnings: [],
						};
					},
				});

			test("passes disabledExtensions through to the loader", async () => {
				let seen: string[] | undefined;
				const cache = new SkillCache({
					resolveCwd: () => skillsDir,
					resolveDisabledExtensions: () => ["skill:weekly-report", "skill:debug-issue"],
					loader: async ({ disabledExtensions } = {}) => {
						seen = disabledExtensions;
						const skills = await loadSkillsFromDir(skillsDir);
						return { skills: skills as never, warnings: [] };
					},
				});
				await cache.getSkills("ops");
				expect(seen).toEqual(["skill:weekly-report", "skill:debug-issue"]);
			});

			test("filters out skills whose name appears in disabledExtensions (skill: prefix stripped)", async () => {
				const cache = makeCacheWithDisabled([
					"skill:weekly-report",
					"slash-command:foo:bar", // non-skill entry → ignored by filter
				]);
				const skills = await cache.getSkills("ops");
				const names = skills.map(s => s.name).sort();
				expect(names).toEqual(["debug-issue", "triage-ticket"]);
				expect(names).not.toContain("weekly-report");
			});

			test("empty disabledExtensions list returns all skills", async () => {
				const cache = makeCacheWithDisabled([]);
				const skills = await cache.getSkills("ops");
				expect(skills.map(s => s.name).sort()).toEqual(["debug-issue", "triage-ticket", "weekly-report"]);
			});

			test("omitted resolveDisabledExtensions → no filtering (all skills shown)", async () => {
				const cache = new SkillCache({
					resolveCwd: () => skillsDir,
					loader: async () => {
						const skills = await loadSkillsFromDir(skillsDir);
						return { skills: skills as never, warnings: [] };
					},
				});
				const skills = await cache.getSkills("ops");
				expect(skills.length).toBe(3);
			});

			test("async resolveDisabledExtensions is awaited before the loader runs", async () => {
				let loaderCalled = false;
				let resolved = false;
				const cache = new SkillCache({
					resolveCwd: () => skillsDir,
					resolveDisabledExtensions: async () => {
						await new Promise(r => setTimeout(r, 5));
						resolved = true;
						return ["skill:triage-ticket"];
					},
					loader: async () => {
						loaderCalled = true;
						expect(resolved).toBe(true); // resolver finished before loader ran
						return { skills: [], warnings: [] };
					},
				});
				await cache.getSkills("ops");
				expect(loaderCalled).toBe(true);
				expect(resolved).toBe(true);
			});

			test("end-to-end: /skills with disabledExtensions excludes the named skill from the list", async () => {
				const channel = makeStubChannel();
				const h = makeHarness(skillsDir, channel, {
					resolveDisabledExtensions: () => ["skill:weekly-report"],
				});
				const handled = await h.command.handle(makeInbound("/skills"), "ops");
				expect(handled).toBe(true);
				const reply = h.getReply();
				expect(reply).toContain("(2)"); // 3 seeded - 1 disabled = 2
				expect(reply).toContain("**triage-ticket**");
				expect(reply).toContain("**debug-issue**");
				expect(reply).not.toContain("**weekly-report**");
			});
		});
	});
});

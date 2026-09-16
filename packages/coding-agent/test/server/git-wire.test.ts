/**
 * T13：`git_changes` 投影的单元测试 —— 真 git 仓库 + 真 porcelain v1 -z 输出，不打桩。
 *
 * 覆盖三层事实：
 *   1. 真仓库里每种 git 状态字母翻成的两轴值（含 `MM`/`RM`/`UU`/` T` 这些容易翻错的）；
 *   2. 同路径两条记录（staged 删除 + 同路径未跟踪）合并成一条两轴真话；
 *   3. 读不到的三种出路：部分记录解析不了 → 正常返回 + `error`；条数超上限 → 截断 + `error`；
 *      一条都解析不了 → 抛（空清单只用来表示「工作区确实干净」）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_GIT_CHANGES, parseGitChangeEntries, projectGitChanges, readGitChanges } from "../../src/server/git-wire";

const cleanups: string[] = [];

afterEach(async () => {
	for (const dir of cleanups.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tmpDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	cleanups.push(dir);
	return dir;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(child.stdout as ReadableStream<Uint8Array>).text(),
		new Response(child.stderr as ReadableStream<Uint8Array>).text(),
	]);
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${(stderr || stdout).trim()}`);
	return stdout;
}

/** 空仓库（有 .git，还没有 commit）——多数用例只关心工作区状态。 */
async function initRepo(prefix: string): Promise<string> {
	const repo = await tmpDir(prefix);
	await runGit(repo, ["init", "-q", "-b", "main"]);
	await runGit(repo, ["config", "user.email", "test@example.com"]);
	await runGit(repo, ["config", "user.name", "Test"]);
	return repo;
}

/** 有 seed commit 的仓库（`a.txt` / `b.txt` 已入库）。 */
async function seededRepo(prefix: string): Promise<string> {
	const repo = await initRepo(prefix);
	await Bun.write(path.join(repo, "a.txt"), "alpha\n");
	await Bun.write(path.join(repo, "b.txt"), "beta\n");
	await runGit(repo, ["add", "-A"]);
	await runGit(repo, ["commit", "-qm", "seed"]);
	return repo;
}

describe("readGitChanges — 真仓库", () => {
	test("干净仓库：空清单且没有 error（空数组 = 读到了、确实没有改动）", async () => {
		const repo = await seededRepo("omp-git-changes-clean-");

		const dto = await readGitChanges(repo);

		expect(dto.changes).toEqual([]);
		expect(dto.error).toBeUndefined();
		expect(await fs.realpath(dto.repoRoot)).toBe(await fs.realpath(repo));
	});

	test("未暂存修改 vs 未跟踪：两轴各自报对，不互相冒充", async () => {
		const repo = await seededRepo("omp-git-changes-axes-");
		await Bun.write(path.join(repo, "a.txt"), "alpha changed\n");
		await Bun.write(path.join(repo, "untracked.txt"), "new\n");

		const dto = await readGitChanges(repo);

		expect(dto.changes).toEqual([
			{ path: "a.txt", index: null, worktree: "modified" },
			{ path: "untracked.txt", index: null, worktree: "untracked" },
		]);
		expect(dto.error).toBeUndefined();
	});

	test("已暂存新增 + 又改一版（AM）：两轴分别报 added / modified，不压成一个字段", async () => {
		const repo = await seededRepo("omp-git-changes-am-");
		await Bun.write(path.join(repo, "c.txt"), "one\n");
		await runGit(repo, ["add", "c.txt"]);
		await Bun.write(path.join(repo, "c.txt"), "two\n");

		const dto = await readGitChanges(repo);

		expect(dto.changes).toEqual([{ path: "c.txt", index: "added", worktree: "modified" }]);
	});

	test("rename + 又改一版（RM）：来源路径进 oldPath，index 报 renamed", async () => {
		const repo = await seededRepo("omp-git-changes-rename-");
		await runGit(repo, ["mv", "a.txt", "renamed.txt"]);
		await Bun.write(path.join(repo, "renamed.txt"), "alpha renamed\n");

		const dto = await readGitChanges(repo);

		expect(dto.changes).toEqual([{ path: "renamed.txt", oldPath: "a.txt", index: "renamed", worktree: "modified" }]);
	});

	test("type change（普通文件换成符号链接）", async () => {
		const repo = await seededRepo("omp-git-changes-typechange-");
		await fs.rm(path.join(repo, "a.txt"));
		await fs.symlink("b.txt", path.join(repo, "a.txt"));

		const dto = await readGitChanges(repo);

		expect(dto.changes).toEqual([{ path: "a.txt", index: null, worktree: "type-changed" }]);
	});

	test("冲突（UU）：两轴都报 conflicted，不替 git 编一个「哪边改的」拆分", async () => {
		const repo = await initRepo("omp-git-changes-conflict-");
		await Bun.write(path.join(repo, "c.txt"), "base\n");
		await runGit(repo, ["add", "-A"]);
		await runGit(repo, ["commit", "-qm", "base"]);
		await runGit(repo, ["checkout", "-q", "-b", "side"]);
		await Bun.write(path.join(repo, "c.txt"), "side\n");
		await runGit(repo, ["commit", "-qam", "side"]);
		await runGit(repo, ["checkout", "-q", "main"]);
		await Bun.write(path.join(repo, "c.txt"), "main\n");
		await runGit(repo, ["commit", "-qam", "main"]);
		// 冲突合并：git 以非零退出（预期），工作区留在 unmerged 状态。
		await runGit(repo, ["merge", "side"]).catch(() => "");

		const dto = await readGitChanges(repo);

		expect(dto.changes).toEqual([{ path: "c.txt", index: "conflicted", worktree: "conflicted" }]);
	});

	test("同路径两条记录（staged 删除 + 同路径未跟踪）合并成一条两轴真话", async () => {
		const repo = await seededRepo("omp-git-changes-dupe-");
		await runGit(repo, ["rm", "-q", "--cached", "a.txt"]);
		await Bun.write(path.join(repo, "a.txt"), "alpha again\n");

		const dto = await readGitChanges(repo);

		// 两条记录（`D  a.txt` + `?? a.txt`）合成一条：index 里被删掉了，工作区里是个未跟踪文件。
		// 分成两条的话，每条都会有一个轴假装「干净」——那是假话。
		expect(dto.changes).toEqual([{ path: "a.txt", index: "deleted", worktree: "untracked" }]);
	});

	test("清单按 path 升序（顺序稳定，客户端不再排序也不会跳）", async () => {
		const repo = await seededRepo("omp-git-changes-sort-");
		await Bun.write(path.join(repo, "z.txt"), "z\n");
		await Bun.write(path.join(repo, "a.txt"), "alpha changed\n");
		await Bun.write(path.join(repo, "m.txt"), "m\n");

		const dto = await readGitChanges(repo);

		expect(dto.changes.map(change => change.path)).toEqual(["a.txt", "m.txt", "z.txt"]);
	});

	test("超出上限：截断到上限并按升序保留，error 说清共几条", async () => {
		const repo = await initRepo("omp-git-changes-cap-");
		const total = MAX_GIT_CHANGES + 2;
		for (let index = 0; index < total; index += 1) {
			await Bun.write(path.join(repo, `f-${String(index).padStart(4, "0")}.txt`), "x\n");
		}

		const dto = await readGitChanges(repo);

		expect(dto.changes.length).toBe(MAX_GIT_CHANGES);
		expect(dto.changes[0]?.path).toBe("f-0000.txt");
		expect(dto.error).toContain(`共 ${total} 条`);
	});

	test("不是 git 仓库：抛（不当成空清单）", async () => {
		const plain = await tmpDir("omp-git-changes-nogit-");

		await expect(readGitChanges(plain)).rejects.toThrow("not a git repository");
	});
});

describe("parseGitChangeEntries — 记录级事实", () => {
	test("空输出 = 没有记录，不是「读不出来」", () => {
		expect(parseGitChangeEntries("")).toEqual({ changes: [], unreadableCount: 0 });
		expect(parseGitChangeEntries("\0")).toEqual({ changes: [], unreadableCount: 0 });
	});

	test("rename 的两段被正确消费（来源路径不会被当成下一条记录）", () => {
		const parsed = parseGitChangeEntries("R  b.txt\0a.txt\0?? c.txt\0");

		expect(parsed.unreadableCount).toBe(0);
		expect(parsed.changes).toEqual([
			{ path: "b.txt", oldPath: "a.txt", index: "renamed", worktree: null },
			{ path: "c.txt", index: null, worktree: "untracked" },
		]);
	});

	test("认不出来的字母 / 残缺记录：记为读不出来，不当成「这一轴干净」", () => {
		const parsed = parseGitChangeEntries(
			"XY weird.txt\0M\0M a.txt\0?M hybrid.txt\0!! ignored.txt\0R  only-new.txt\0",
		);

		expect(parsed.changes).toEqual([]);
		expect(parsed.unreadableCount).toBe(6);
		expect(parsed.unreadableSample).toBe("XY weird.txt");
	});

	test("同一轴出现两个不同的非空状态：那一条记为读不出来，已读到的保留", () => {
		const parsed = parseGitChangeEntries("M  f.txt\0D  f.txt\0");

		expect(parsed.changes).toEqual([{ path: "f.txt", index: "modified", worktree: null }]);
		expect(parsed.unreadableCount).toBe(1);
	});
});

describe("projectGitChanges — 读不出来与读到了的边界", () => {
	test("部分记录解析不了：清单照给，error 报出丢了几条", () => {
		const dto = projectGitChanges("/repo", "M  a.txt\0XY weird.txt\0");

		// `M ` = index 改了、工作区没再改（X 轴是 index，Y 轴是 worktree）
		expect(dto.changes).toEqual([{ path: "a.txt", index: "modified", worktree: null }]);
		expect(dto.error).toContain("1 条记录无法解析");
	});

	test("一条都解析不了：抛（「读不到」不能长成「工作区干净」）", () => {
		expect(() => projectGitChanges("/repo", "XY weird.txt\0!! ignored.txt\0")).toThrow("全部无法解析");
	});

	test("干净的工作区没有 error（error 只用来表示「这份清单不完整」）", () => {
		const dto = projectGitChanges("/repo", "");

		expect(dto).toEqual({ repoRoot: "/repo", changes: [] });
	});
});

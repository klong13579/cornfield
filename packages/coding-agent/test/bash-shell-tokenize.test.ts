import { describe, expect, it } from "bun:test";
import { extractFlatShellCommandSegments, extractLeadingCdTarget } from "@cornfield/coding-agent/tools/shell-tokenize";

const texts = (command: string): string[] => extractFlatShellCommandSegments(command).map(segment => segment.text);

describe("extractFlatShellCommandSegments", () => {
	describe("segment boundaries", () => {
		it("splits on ;, &&, ||, |, &, and newlines", () => {
			expect(texts("ls && cat a; grep b c | head -3\necho hi")).toEqual([
				"ls",
				"cat a",
				"grep b c",
				"head -3",
				"echo hi",
			]);
			expect(texts("ls || echo x & echo y")).toEqual(["ls", "echo x", "echo y"]);
		});

		it("keeps the original quoting and escaping of each segment", () => {
			expect(texts(`cat "my file.txt" && grep 'a b' f`)).toEqual([`cat "my file.txt"`, `grep 'a b' f`]);
			expect(texts("cat a\\ b && ls")).toEqual(["cat a\\ b", "ls"]);
		});

		it("does not split inside quotes", () => {
			expect(texts("echo 'a;b && c'")).toEqual(["echo 'a;b && c'"]);
			expect(texts('echo "a|b" | wc -l')).toEqual(['echo "a|b"', "wc -l"]);
		});

		it("drops a comment and keeps a pending pipe across a comment-only line", () => {
			const segments = extractFlatShellCommandSegments("printf x | # note\n grep x");
			expect(segments.map(segment => segment.text)).toEqual(["printf x", "grep x"]);
			expect(segments[1]?.pipedStdin).toBe(true);
		});
	});

	describe("stdin source", () => {
		it("marks the stage behind a pipe, and only that stage", () => {
			const segments = extractFlatShellCommandSegments("cat a.txt | grep x | wc -l");
			expect(segments.map(segment => [segment.text, segment.pipedStdin])).toEqual([
				["cat a.txt", false],
				["grep x", true],
				["wc -l", true],
			]);
		});

		it("treats `;`, `&&`, and `||` as independent commands, not pipes", () => {
			const segments = extractFlatShellCommandSegments("ls && cat a");
			expect(segments.every(segment => !segment.pipedStdin)).toBe(true);
		});

		it("marks a heredoc-fed segment and skips the body", () => {
			const segments = extractFlatShellCommandSegments("cat <<'EOF'\nhello\nworld\nEOF");
			expect(segments).toEqual([
				{ text: "cat <<'EOF'", pipedStdin: false, heredocStdin: true, redirectsOutput: false },
			]);
		});

		it("skips the body of every heredoc opened on one line, in opener order", () => {
			expect(texts("cat <<'A' <<B\none\nA\ntwo\nB\ncat foo.txt")).toEqual(["cat <<'A' <<B", "cat foo.txt"]);
		});

		it("strips leading tabs for <<- and resumes after the delimiter", () => {
			expect(texts("cat <<-'EOF'\n\tsee tab\n\tEOF\nls")).toEqual(["cat <<-'EOF'", "ls"]);
		});

		it("resumes at the delimiter line's end, tolerating CRLF bodies", () => {
			expect(texts("cat <<'EOF'\r\nbody\r\nEOF\r\nls")).toEqual(["cat <<'EOF'", "ls"]);
		});

		it("skips an unterminated body to the end of the command", () => {
			expect(texts("cat <<EOF\nno terminator here")).toEqual(["cat <<EOF"]);
		});

		it("marks a here-string without looking for a body", () => {
			const segments = extractFlatShellCommandSegments("cat <<< 'x' && ls");
			expect(segments.map(segment => [segment.text, segment.heredocStdin])).toEqual([
				["cat <<< 'x'", true],
				["ls", false],
			]);
		});
	});

	describe("output redirects", () => {
		it("marks a file redirect, including the heredoc form", () => {
			expect(extractFlatShellCommandSegments("cat > f <<'EOF'")[0]?.redirectsOutput).toBe(true);
			expect(extractFlatShellCommandSegments("echo x >> log")[0]?.redirectsOutput).toBe(true);
			expect(extractFlatShellCommandSegments("cmd &> log")[0]?.redirectsOutput).toBe(true);
		});

		it("does not read a descriptor duplication as a file write", () => {
			expect(extractFlatShellCommandSegments("cat a 2>&1")[0]?.redirectsOutput).toBe(false);
		});

		it("ignores a redirect inside a quoted literal", () => {
			const segments = extractFlatShellCommandSegments("echo 'a > b'");
			expect(segments[0]?.redirectsOutput).toBe(false);
		});
	});

	describe("input this scanner declines", () => {
		it("declines command substitution, grouping, and backticks", () => {
			expect(extractFlatShellCommandSegments("cat $(ls)")).toEqual([]);
			expect(extractFlatShellCommandSegments("cat $((1 + 2)) x")).toEqual([]);
			expect(extractFlatShellCommandSegments("cat `ls`")).toEqual([]);
			expect(extractFlatShellCommandSegments("(cat a)")).toEqual([]);
		});

		it("declines malformed quoting", () => {
			expect(extractFlatShellCommandSegments("cat 'unterminated")).toEqual([]);
			expect(extractFlatShellCommandSegments("cat trailing\\")).toEqual([]);
		});

		it("declines a heredoc whose delimiter needs expansion", () => {
			expect(extractFlatShellCommandSegments("cat <<$NAME\nbody\nx")).toEqual([]);
		});

		it("declines when the opener line continues past the next newline", () => {
			// `cat <<EOF |` + newline: the shell reads the body after the *complete*
			// line, which is one line further down than this scanner tracks.
			expect(extractFlatShellCommandSegments("cat <<EOF |\nwc -l\nbody\nEOF")).toEqual([]);
		});
	});
});

describe("extractLeadingCdTarget", () => {
	it("returns the target and the remainder after a top-level &&", () => {
		expect(extractLeadingCdTarget("cd packages/coding-agent && echo ok")).toEqual({
			path: "packages/coding-agent",
			rest: "echo ok",
		});
		expect(extractLeadingCdTarget("cd a && cd b && ls")).toEqual({ path: "a", rest: "cd b && ls" });
	});

	it("resolves quoting and escaping in the target", () => {
		expect(extractLeadingCdTarget(`cd "my dir" && ls`)?.path).toBe("my dir");
		expect(extractLeadingCdTarget("cd 'a b' && ls")?.path).toBe("a b");
		expect(extractLeadingCdTarget("cd a\\ b && ls")?.path).toBe("a b");
		expect(extractLeadingCdTarget(`cd "/a/b" && ls`)?.path).toBe("/a/b");
	});

	it("declines anything that is not exactly `cd <path> && …`", () => {
		expect(extractLeadingCdTarget("cd a; ls")).toBeNull();
		expect(extractLeadingCdTarget("cd a & ls")).toBeNull();
		expect(extractLeadingCdTarget("cd a\nls")).toBeNull();
		expect(extractLeadingCdTarget("cd a b && ls")).toBeNull();
		expect(extractLeadingCdTarget("cd && ls")).toBeNull();
		expect(extractLeadingCdTarget("echo cd a && ls")).toBeNull();
	});

	it("declines a prefix the shell would have to expand or redirect", () => {
		expect(extractLeadingCdTarget("cd $HOME && ls")).toBeNull();
		expect(extractLeadingCdTarget("cd $(pwd) && ls")).toBeNull();
		expect(extractLeadingCdTarget("cd /tmp 2>/dev/null && ls")).toBeNull();
	});
});

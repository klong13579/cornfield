import { beforeEach, describe, expect, it } from "bun:test";
import type { Message, SessionInfo } from "@cornfield/coding-agent/intercom-extension/types";
import { InlineMessageComponent } from "@cornfield/coding-agent/intercom-extension/ui/inline-message";
import { getThemeByName } from "@cornfield/coding-agent/modes/theme/theme";
import { visibleWidth } from "@cornfield/tui";
import stripAnsi from "strip-ansi";

function makeFrom(): SessionInfo {
	return { id: "sess-1", name: "worker", cwd: "/repo", model: "m", pid: 1, startedAt: 0, lastActivity: 0 };
}

function makeMessage(text: string): Message {
	return { id: "m1", timestamp: 0, content: { text } };
}

function renderCollapsed(bodyText: string, width = 40, messageText = bodyText): string[] {
	const comp = new InlineMessageComponent(makeFrom(), makeMessage(messageText), theme!, undefined, bodyText, true);
	return comp.render(width);
}

function renderExpanded(bodyText: string, width = 40): string[] {
	const comp = new InlineMessageComponent(makeFrom(), makeMessage(bodyText), theme!, undefined, bodyText, false);
	return comp.render(width);
}

let theme: NonNullable<Awaited<ReturnType<typeof getThemeByName>>>;

beforeEach(async () => {
	const loaded = await getThemeByName("dark");
	expect(loaded).toBeDefined();
	theme = loaded!;
});

describe("InlineMessageComponent collapsed preview", () => {
	it("shows the first 3 lines of a longer message", () => {
		const lines = renderCollapsed("line1\nline2\nline3\nline4\nline5");
		// header + 3 preview lines + meta + bottom border
		expect(lines.length).toBe(6);
		const text = lines.map(stripAnsi).join("\n");
		expect(text).toContain("line1");
		expect(text).toContain("line2");
		expect(text).toContain("line3");
		expect(text).not.toContain("line4");
		expect(text).not.toContain("line5");
	});

	it("keeps shorter messages fully visible without padding", () => {
		const lines = renderCollapsed("only one line");
		// header + 1 preview + meta + bottom border
		expect(lines.length).toBe(4);
		expect(lines.map(stripAnsi).join("\n")).toContain("only one line");
	});

	it("collapses whitespace and drops blank lines in the preview", () => {
		const lines = renderCollapsed("  a   b  \n\n\n   c   ");
		expect(lines.length).toBe(5); // header + 2 preview lines + meta + bottom border
		const text = lines.map(stripAnsi).join("\n");
		expect(text).toContain("a b");
		expect(text).toContain("c");
	});

	it("renders no preview lines for an empty message", () => {
		const lines = renderCollapsed("");
		expect(lines.length).toBe(3); // header + meta + bottom border
	});

	it("truncates preview lines to the frame width", () => {
		const lines = renderCollapsed("a".repeat(100), 10);
		const previewLines = lines.slice(1, -2).map(stripAnsi);
		for (const line of previewLines) {
			// Strip the left/right frame borders — content is capped at bodyWidth = width - 2
			expect(visibleWidth(line.slice(1, -1))).toBeLessThanOrEqual(8);
		}
	});

	it("keeps the expand hints in header and meta", () => {
		const lines = renderCollapsed("line1\nline2\nline3\nline4");
		const text = lines.map(stripAnsi).join("\n");
		expect(text).toContain("Ctrl+O expands");
		expect(text).toContain("Ctrl+O to expand");
	});

	it("prefers bodyText over message.content.text", () => {
		const comp = new InlineMessageComponent(
			makeFrom(),
			makeMessage("raw message text"),
			theme,
			undefined,
			"formatted body",
			true,
		);
		const text = comp.render(40).map(stripAnsi).join("\n");
		expect(text).toContain("formatted body");
		expect(text).not.toContain("raw message text");
	});

	it("is stable across repeated renders (cache does not duplicate lines)", () => {
		const comp = new InlineMessageComponent(makeFrom(), makeMessage("x"), theme, undefined, "a\nb\nc\nd", true);
		const first = comp.render(40).map(stripAnsi).join("\n");
		const second = comp.render(40).map(stripAnsi).join("\n");
		expect(first).toBe(second);
	});
});

describe("InlineMessageComponent expanded", () => {
	it("renders the full message without expand hints", () => {
		const lines = renderExpanded("l1\nl2\nl3\nl4\nl5\nl6");
		const text = lines.map(stripAnsi).join("\n");
		for (let i = 1; i <= 6; i++) expect(text).toContain(`l${i}`);
		expect(text).not.toContain("Ctrl+O expands");
		expect(text).not.toContain("Ctrl+O to expand");
	});
});

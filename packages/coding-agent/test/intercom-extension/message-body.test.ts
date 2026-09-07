import { beforeEach, describe, expect, it } from "bun:test";
import type { Theme } from "@cornfield/coding-agent";
import stripAnsi from "strip-ansi";
import {
	createMessageBodyComponent,
	INTERCOM_MESSAGE_PREVIEW_LINES,
} from "../../src/intercom-extension/ui/message-body";

/** Minimal theme stub: renderers only need fg() to pass text through. */
const theme: Theme = {
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

const HEADER = "intercom send → peer";

describe("createMessageBodyComponent", () => {
	let expanded: boolean;
	beforeEach(() => {
		expanded = false;
	});

	const renderCollapsed = (message: string, width = 80) => {
		const component = createMessageBodyComponent(HEADER, message, theme, () => expanded);
		return component.render(width).map(stripAnsi);
	};

	it("renders header only for empty and whitespace-only messages", () => {
		expect(renderCollapsed("")).toEqual([HEADER]);
		expect(renderCollapsed("   \n\t ")).toEqual([HEADER]);
	});

	it("shows short messages fully when collapsed (no expand hint)", () => {
		const lines = renderCollapsed("hello world");
		expect(lines).toEqual([HEADER, "hello world"]);
	});

	it("collapses long messages to the first N visual lines with an expand hint", () => {
		const message = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`).join("\n");
		const lines = renderCollapsed(message);
		expect(lines).toHaveLength(1 + INTERCOM_MESSAGE_PREVIEW_LINES + 1);
		expect(lines[0]).toBe(HEADER);
		expect(lines[1]).toBe("line-1");
		expect(lines[INTERCOM_MESSAGE_PREVIEW_LINES]).toBe(`line-${INTERCOM_MESSAGE_PREVIEW_LINES}`);
		expect(lines.at(-1)).toBe(`… (${25 - INTERCOM_MESSAGE_PREVIEW_LINES} more lines, Ctrl+O to expand)`);
	});

	it("shows the full message when expanded, with no expand hint", () => {
		expanded = true;
		const message = Array.from({ length: 25 }, (_, i) => `line-${i + 1}`).join("\n");
		const lines = renderCollapsed(message);
		expect(lines).toHaveLength(26);
		expect(lines[25]).toBe("line-25");
		expect(lines.some(line => line.includes("Ctrl+O"))).toBe(false);
	});

	it("wraps a single long line into multiple visual lines when collapsed", () => {
		const message = "x".repeat(200);
		const lines = renderCollapsed(message, 80);
		expect(lines.length).toBeGreaterThan(2);
		for (const line of lines.slice(1)) {
			expect(line.length).toBeLessThanOrEqual(80);
		}
	});

	it("expands to the untruncated content regardless of width", () => {
		expanded = true;
		const message = Array.from({ length: 30 }, (_, i) => `row-${i}`).join("\n");
		const lines = renderCollapsed(message, 40);
		expect(lines).toHaveLength(31);
		expect(lines[30]).toBe("row-29");
	});

	it("trims leading and trailing blank lines of the message body", () => {
		const lines = renderCollapsed("\n\n  hello  \n\n");
		expect(lines).toEqual([HEADER, "hello"]);
	});
});

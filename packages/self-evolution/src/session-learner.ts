/**
 * V3 SessionLearner — one LLM call per session to extract ≤3 learnings (Hermes-style write filter).
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { LEARNING_MAX_PER_SESSION, newLearningLifecycleState, validateLearningContent } from "./learning-admission";
import extractSessionLearningsSystemTemplate from "./prompts/extract-session-learnings.md" with { type: "text" };
import extractSessionLearningsInputTemplate from "./prompts/extract-session-learnings-input.md" with { type: "text" };
import type { Learning, LearningKind, SessionTrace } from "./types";
import { type BackgroundLlmAuth, callBackgroundLlm } from "./utils/llm";

interface LlmLearningItem {
	kind: string;
	content: string;
	confidence: number;
}

function learningId(content: string, kind: LearningKind): string {
	return `lrn_${Bun.hash(`${kind}:${content}`).toString(36)}`;
}

function collectUserInputs(trace: SessionTrace): string {
	const parts: string[] = [];
	const seen = new Set<string>();
	const add = (t: string) => {
		const trimmed = t.trim();
		if (!trimmed) return;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		parts.push(trimmed);
	};
	add(trace.userPrompt);
	for (const e of trace.entries) {
		if (e.type === "user_input" && e.content) add(e.content);
	}
	return parts.join("\n\n") || "(none)";
}

function collectAssistantMessages(trace: SessionTrace, maxChars = 6000): string {
	const chunks: string[] = [];
	let total = 0;
	for (const e of trace.entries) {
		if (e.type !== "assistant_message" || !e.content) continue;
		const slice = e.content.length > 800 ? `${e.content.slice(0, 800)}...` : e.content;
		if (total + slice.length > maxChars) break;
		chunks.push(slice);
		total += slice.length;
	}
	return chunks.join("\n\n") || "(none)";
}

function parseKind(raw: string): LearningKind | null {
	const k = raw.trim().toLowerCase();
	if (k === "preference" || k === "fact" || k === "procedure" || k === "skill_hint") return k;
	return null;
}

function parseResponse(response: string, trace: SessionTrace, episodeId: string): Learning[] {
	try {
		const jsonMatch = response.match(/\[[\s\S]*\]/);
		if (!jsonMatch) return [];
		const parsed = JSON.parse(jsonMatch[0]) as LlmLearningItem[];
		if (!Array.isArray(parsed)) return [];

		const now = Date.now();
		const results: Learning[] = [];
		const seen = new Set<string>();

		for (const item of parsed) {
			if (results.length >= LEARNING_MAX_PER_SESSION) break;
			const kind = parseKind(item.kind);
			if (!kind) continue;
			const content = String(item.content ?? "").trim();
			if (!validateLearningContent(content)) continue;
			const confidence = Math.min(5, Math.max(1, Number(item.confidence) || 3));
			if (confidence < 4) continue;

			const key = content.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);

			results.push({
				id: learningId(content, kind),
				cwd: trace.cwd,
				kind,
				content,
				source: "session_llm",
				confidence,
				lifecycle: newLearningLifecycleState("session_llm"),
				sessionId: episodeId,
				createdAt: now,
				updatedAt: now,
				timesInjected: 0,
				timesHelped: 0,
				timesIgnored: 0,
			});
		}
		return results;
	} catch {
		return [];
	}
}

export async function extractSessionLearnings(
	trace: SessionTrace,
	episodeId: string,
	model?: Model,
	auth?: BackgroundLlmAuth,
): Promise<Learning[]> {
	if (!model) {
		logger.debug("SessionLearner skipped: no model");
		return [];
	}

	const userPrompt = prompt.render(extractSessionLearningsInputTemplate, {
		user_inputs: collectUserInputs(trace),
		assistant_messages: collectAssistantMessages(trace),
	});

	const response = await callBackgroundLlm(model, extractSessionLearningsSystemTemplate, userPrompt, {
		auth,
		maxTokens: 1200,
	});
	if (!response) return [];

	const learnings = parseResponse(response, trace, episodeId);
	logger.debug("SessionLearner extracted", { count: learnings.length });
	return learnings;
}

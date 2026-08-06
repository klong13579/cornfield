/**
 * Voice-start greeting helpers (P1 acceptance request: the assistant says
 * hello with the user's name when voice mode connects).
 */

/** Extract the user's display name from the declarative persona (`- name: X`). */
export function extractUserName(profile: string | null | undefined): string | undefined {
	if (!profile) return undefined;
	const match = profile.match(/^-\s*name:\s*(.+)$/m);
	const name = match?.[1]?.trim();
	return name || undefined;
}

/** Voice-start greeting note; the model addresses the user by name when known. */
export function buildGreetingNote(userName: string | undefined): string {
	return userName
		? `（系统：语音模式刚启动。请立即用一句话向用户问好——用户叫${userName}，自然地称呼他——并简短问他想做什么。）`
		: "（系统：语音模式刚启动。请立即用一句话向用户问好，并简短问他想做什么。）";
}

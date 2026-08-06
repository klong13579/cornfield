/**
 * Voice-start greeting helpers (P1 acceptance request: the assistant says
 * hello like an old friend, addressing the user by given name).
 */

/** Extract the user's display name from the declarative persona (`- name: X`). */
export function extractUserName(profile: string | null | undefined): string | undefined {
	if (!profile) return undefined;
	const match = profile.match(/^-\s*name:\s*(.+)$/m);
	const name = match?.[1]?.trim();
	return name || undefined;
}

/**
 * Derive the spoken address form from a full name. Common 3-char Chinese
 * names are surname(1) + given(2): address by the given name (彭梦龙 → 梦龙).
 * Everything else is used as-is.
 */
export function deriveAddressName(fullName: string): string {
	const name = fullName.trim();
	if (/^[\u4e00-\u9fff]{3}$/.test(name)) return name.slice(1);
	return name;
}

/** Voice-start greeting note; the model greets like a familiar old friend. */
export function buildGreetingNote(userName: string | undefined): string {
	if (!userName)
		return "（系统：语音模式刚启动。请像一位熟悉的老朋友那样，热情自然地用一句话向用户问好，并简短问他想做什么。）";
	return `（系统：语音模式刚启动。请像一位熟悉的老朋友那样，热情自然地用一句话向用户问好——称呼「${userName}」（先说「你好」，再叫名字，不要连姓带名）——并简短问他想做什么。）`;
}

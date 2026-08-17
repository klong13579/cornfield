import { useSyncExternalStore } from "react";
import type { SessionView } from "./session-store";
import { useSessionStore } from "./session-store";

/** 订阅会话渲染视图（快照权威 + progress 瞬态）。 */
export function useSession(): SessionView {
	const store = useSessionStore();
	return useSyncExternalStore(
		cb => store.subscribe(cb),
		() => store.getSnapshot(),
	);
}

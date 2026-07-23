/**
 * Once-right B (input-collect) is low value for product/tool comparisons:
 * the decision gaps are dimensions/audience/depth, not per-role checklists.
 */
import type { TaskContextObject } from "./tco";

const COMPARE_TEXT =
	/区别|对比|vs\.?|versus|比起|相比较|竞品/i;

export function shouldSkipInputCollect(tco: TaskContextObject): boolean {
	if (tco.task_intent === "compare") return true;
	if (tco.task_intent === "design" || tco.task_intent === "local-impl") return false;
	const text = `${tco.task_understanding ?? ""}`;
	return COMPARE_TEXT.test(text);
}

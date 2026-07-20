/**
 * Filter missing_inputs so Ask / grill never asks "what is X" for publicly
 * searchable entities — those belong to Research.
 */

import type { TcoMissingInput } from "./tco";

/** Definition / local-identity style questions that Research or tools should answer. */
const DEFINITION_STYLE =
	/(?:具体指什么|具体指哪|具体是哪个|是什么[？?]?|分别是什么|什么意思|提供\s*(?:URL|链接|全称)|能提供\s*(?:URL|准确名称)|how\s+(?:is|are)\s+.+\s+defined|what\s+(?:is|are)\s+\w+|in\s+this\s+(?:repo|project|codebase)|本项目|代码中没有找到|找不到这个名称|包或模块|指代什么)/i;

export function isDefinitionStyleQuestion(question: string): boolean {
	return DEFINITION_STYLE.test(question.trim());
}

/** Keep only decision-shaping missing inputs (dimensions, depth, audience, …). */
export function filterDecisionMissing(items: readonly TcoMissingInput[]): TcoMissingInput[] {
	return items.filter(item => !isDefinitionStyleQuestion(item.question) && !isDefinitionStyleKey(item.key));
}

function isDefinitionStyleKey(key: string): boolean {
	return /(?:_definition|_reference|_identity|what_is_|what_are_|is_what|project_names)/i.test(key);
}

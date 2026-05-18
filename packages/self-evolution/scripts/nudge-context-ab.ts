#!/usr/bin/env bun
/**
 * Run nudge context injection A/B harness and print markdown report.
 *
 * Usage: bun packages/self-evolution/scripts/nudge-context-ab.ts
 */
import { formatNudgeAbReportMarkdown, runNudgeContextAbReport } from "../src/nudge-context-ab";

const report = runNudgeContextAbReport();
console.log(formatNudgeAbReportMarkdown(report));

if (report.summary.injectionDeliveryRate < 1 || report.summary.mockBehaviorWinRate < 1) {
	process.exit(1);
}

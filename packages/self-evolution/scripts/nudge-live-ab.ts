#!/usr/bin/env bun
/**
 * Synthetic A/B + live OMP instructions for nudge context injection.
 *
 * Usage:
 *   bun packages/self-evolution/scripts/nudge-context-ab.ts   # synthetic only
 *   bun packages/self-evolution/scripts/nudge-live-ab.ts      # synthetic + live steps
 */
import { formatNudgeAbReportMarkdown, runNudgeContextAbReport } from "../src/nudge-context-ab";

const synthetic = runNudgeContextAbReport();

console.log(formatNudgeAbReportMarkdown(synthetic));
console.log("");
console.log("## Live OMP A/B (manual)");
console.log("");
console.log("1. **Treatment** (default): run interactive OMP in a repo with failing reads/edits.");
console.log("   ```bash");
console.log("   bun packages/coding-agent/src/cli.ts");
console.log("   ```");
console.log("2. **Control**: same task with context injection disabled:");
console.log("   ```bash");
console.log("   bun packages/coding-agent/src/cli.ts --no-self-evolution-enable-nudge-context-injection");
console.log("   ```");
console.log("3. Compare `~/.omp/logs/omp.*.log` for `Nudge context injected` (treatment only).");
console.log("4. Run `/evolution audit` — check **Nudges** section (help rate, repeat rate).");
console.log("5. Run `/evolution nudges` — ack useful types, dismiss noisy ones.");
console.log("");

if (synthetic.summary.injectionDeliveryRate < 1 || synthetic.summary.mockBehaviorWinRate < 1) {
	process.exit(1);
}

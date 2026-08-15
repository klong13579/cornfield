#!/usr/bin/env bun
/**
 * Build the standalone `omp-gateway` binary (packages/pi-gateway/dist/omp-gateway).
 *
 * This is the daemon-host counterpart of the `omp` coding-agent binary — see
 * docs/gateway-binary-split-plan.md. Deliberately slimmer than the coding-agent
 * build:
 * No native addons (natives are embedded in `omp` and provided to the
 *     agent runtime via `omp --mode rpc`; the gateway never calls them).
 *   - `--external mupdf` mirrors the coding-agent build: the static import
 *     graph (through pi-coding-agent/skeleton → markit-ai) reaches mupdf's
 *     wasm bundle whose top-level await breaks bundling. The gateway never
 *     extracts PDFs (that's agent-side work), so the require is left for
 *     runtime resolution only if it is ever reached.
 *   - No stats client bundle.
 * Both binaries share the darwin adhoc-sign + smoke-exec verification so a
 * kernel-rejected signature fails the build instead of surfacing at
 * `omp-gateway service start`.
 */

import * as path from "node:path";

const packageDir = path.join(import.meta.dir, "..");
const outputPath = path.join(packageDir, "dist", "omp-gateway");

function shouldAdhocSignDarwinBinary(): boolean {
	return process.platform === "darwin";
}

async function runCommand(command: string[], env: NodeJS.ProcessEnv = Bun.env): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd: packageDir,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function main(): Promise<void> {
	await runCommand([
		"bun",
		"build",
		"--compile",
		"--define",
		'process.env.PI_COMPILED="true"',
		"--external",
		"mupdf",
		"--root",
		"../..",
		"./src/cli.ts",
		"--outfile",
		"dist/omp-gateway",
	]);

	// Bun 1.3.12 emits a truncated Mach-O signature on darwin builds — same
	// remediation as the coding-agent binary: force an adhoc signature and
	// smoke-exec the product here so AMFI load-time rejection becomes a build
	// failure instead of a silent daemon death at `service start`.
	if (shouldAdhocSignDarwinBinary()) {
		await runCommand(["codesign", "--force", "--sign", "-", outputPath]);
		const smoke = Bun.spawn([outputPath, "--version"], {
			stdout: "inherit",
			stderr: "inherit",
		});
		const smokeExit = await smoke.exited;
		if (smokeExit !== 0) {
			throw new Error(
				`Signed binary failed smoke exec (exit ${smokeExit}). The kernel rejected the adhoc ` +
					`signature at load time. Re-run: codesign --force -s - ${outputPath} and verify with ` +
					`${outputPath} --version, then redeploy.`,
			);
		}
	}
}

await main();

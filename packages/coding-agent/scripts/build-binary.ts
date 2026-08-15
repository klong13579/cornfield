#!/usr/bin/env bun
/**
 * Build the `omp` coding-agent binary (packages/coding-agent/dist/omp).
 *
 * This is the agent runtime half of the gateway binary split — the gateway
 * daemon is built separately as `omp-gateway` by
 * `packages/omp-gateway/scripts/build-binary.ts` (see
 * docs/gateway-binary-split-plan.md). Agent execution stays here and is
 * spawned by the gateway via `omp --mode rpc`.
 */

import * as path from "node:path";

const packageDir = path.join(import.meta.dir, "..");
const outputPath = path.join(packageDir, "dist", "omp");

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
	await runCommand(["bun", "--cwd=../stats", "scripts/generate-client-bundle.ts", "--generate"]);
	try {
		// Rebuild native addon first — ensures AudioCapture and other new
		// exports are available even when workspace builds run in parallel.
		await runCommand(["bun", "--cwd=../natives", "run", "build"]);
		await runCommand(["bun", "--cwd=../natives", "run", "embed:native"]);
		try {
			const buildEnv = shouldAdhocSignDarwinBinary() ? { ...Bun.env, BUN_NO_CODESIGN_MACHO_BINARY: "1" } : Bun.env;
			await runCommand(
				[
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
					"dist/omp",
				],
				buildEnv,
			);

			// Bun 1.3.12 emits a truncated Mach-O signature on darwin builds.
			if (shouldAdhocSignDarwinBinary()) {
				await runCommand(["codesign", "--force", "--sign", "-", outputPath]);
				// Verify the signed binary actually executes. A signature that
				// passes `codesign --verify` can still be rejected by the kernel
				// at load time (AMFI "load code signature error 2" → SIGKILL on
				// exec), which would otherwise surface much later at `omp gateway
				// service start` with no trace in the build. Executing the
				// product here turns a broken signature into a failed build.
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
		} finally {
			await runCommand(["bun", "--cwd=../natives", "run", "embed:native", "--reset"]);
		}
	} finally {
		await runCommand(["bun", "--cwd=../stats", "scripts/generate-client-bundle.ts", "--reset"]);
	}
}

await main();

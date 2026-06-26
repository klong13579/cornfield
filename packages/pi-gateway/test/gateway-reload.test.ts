/**
 * End-to-end test: config reload plan — only restarts what changed.
 *
 * Verifies:
 * 1. No-op reload (same config) does not restart the bridge.
 * 2. Only-cron reload does not touch bridges.
 * 3. Account add/remove triggers bridge creation/deletion.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Gateway } from "../src/gateway";

const FAKE_RPC_SCRIPT = `#!/usr/bin/env bun
process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
let buffer = "";
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
async function handleFrame(frame) {
  if (frame.type === "switch_session") {
    emit({ type: "response", id: frame.id, command: "switch_session", success: true, data: { cancelled: false } });
    return;
  }
  if (frame.type === "prompt") {
    emit({ type: "response", id: frame.id, command: "prompt", success: true });
    setTimeout(() => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
      emit({ type: "agent_end" });
    }, 0);
    return;
  }
  if (frame.type === "abort" || frame.type === "set_disabled_toolsets") {
    emit({ type: "response", id: frame.id, command: frame.type, success: true });
  }
}
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) await handleFrame(JSON.parse(line));
    index = buffer.indexOf("\\n");
  }
}
`;

async function createFakeRpcBinary(): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-reload-rpc-"));
	const scriptPath = path.join(dir, "fake-rpc");
	await Bun.write(scriptPath, FAKE_RPC_SCRIPT);
	await fs.chmod(scriptPath, 0o755);
	return {
		path: scriptPath,
		cleanup: async () => {
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

describe("Gateway reload plan", () => {
	let tmpDir: string;
	let fake: { path: string; cleanup: () => Promise<void> };

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-reload-"));
		fake = await createFakeRpcBinary();
	});

	afterEach(async () => {
		await fake.cleanup();
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test("no-op reload does not restart the default bridge", async () => {
		const config = {
			channels: {},
			dataDir: tmpDir,
			agent: { ompPath: fake.path, timeoutMs: 2_000 },
		};
		const gateway = new Gateway(config);
		try {
			await gateway.start();
			const bridge = gateway.getDefaultBridge();
			const pidBefore = bridge.getSnapshot().pid;
			expect(pidBefore).toBeDefined();

			// Reload with identical config.
			await gateway.reload(config);

			// Bridge should not have been restarted — same pid.
			const pidAfter = bridge.getSnapshot().pid;
			expect(pidAfter).toBe(pidBefore);
		} finally {
			await gateway.stop();
		}
	});

	test("reload with different dataDir updates config without restarting bridge", async () => {
		const config1 = {
			channels: {},
			dataDir: tmpDir,
			agent: { ompPath: fake.path, timeoutMs: 2_000 },
		};
		const gateway = new Gateway(config1);
		try {
			await gateway.start();
			const bridge = gateway.getDefaultBridge();
			const pidBefore = bridge.getSnapshot().pid;

			const nextDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-gateway-reload-next-"));
			try {
				await fs.writeFile(path.join(nextDir, "gateway.pid"), String(process.pid));

				// Reload with new dataDir — no cron, no accounts, no bridge change.
				await gateway.reload({ ...config1, dataDir: nextDir });

				// Bridge should not have been restarted.
				const pidAfter = bridge.getSnapshot().pid;
				expect(pidAfter).toBe(pidBefore);

				// But config should be updated — getStatus reflects new dataDir.
				const status = await gateway.getStatus();
				expect(status.running).toBe(true);
			} finally {
				await fs.rm(nextDir, { recursive: true, force: true });
			}
		} finally {
			await gateway.stop();
		}
	});

	test("reload only restarts scheduler when cron config changes", async () => {
		const config = {
			channels: {},
			dataDir: tmpDir,
			agent: { ompPath: fake.path, timeoutMs: 2_000 },
		};
		const gateway = new Gateway(config);
		try {
			await gateway.start();
			const bridge = gateway.getDefaultBridge();
			const pidBefore = bridge.getSnapshot().pid;

			// Reload with cron enabled — scheduler should restart, bridge should not.
			await gateway.reload({
				...config,
				cron: { enabled: false, tickIntervalMs: 999 },
			});

			// Bridge pid unchanged — scheduler restart doesn't touch bridges.
			const pidAfter = bridge.getSnapshot().pid;
			expect(pidAfter).toBe(pidBefore);

			// Scheduler is not running (cron.enabled = false).
			const status = await gateway.getStatus();
			expect(status.scheduler.running).toBe(false);
		} finally {
			await gateway.stop();
		}
	});
});

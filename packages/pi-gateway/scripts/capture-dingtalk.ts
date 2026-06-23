/**
 * Capture real DingTalk robot messages.
 *
 * Connects to the **real** DingTalk Stream SDK using the credentials in
 * `~/.omp/gateway.json` and appends every incoming `DingTalkRawMessage` to
 * a JSONL capture file. Used to:
 *   1. See the actual wire format DingTalk sends (confirm our templates).
 *   2. Get real `downloadCode` values to feed into the replay harness.
 *   3. Verify the `content` JSON shape for picture / audio / video / file /
 *      richText messages from a live source.
 *
 * Usage:
 *   bun run scripts/capture-dingtalk.ts --account hr
 *   bun run scripts/capture-dingtalk.ts --account hr --out /tmp/cap.jsonl
 *   bun run scripts/capture-dingtalk.ts --account hr --timeout 60000
 *   bun run scripts/capture-dingtalk.ts --account hr --msgtypes picture,video,file
 *
 * While the script is running, send messages from your DingTalk client to
 * the bot. Each captured message is printed to stdout (pretty JSON) and
 * appended to the capture file. Use Ctrl-C to stop.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DWClient, type DWClientDownStream, TOPIC_ROBOT } from "dingtalk-stream";
import { getDingTalkConfig, loadConfig } from "../src/config";
import type { DingTalkConfig, DingTalkRawMessage } from "../src/types";

interface CliArgs {
	accountId: string;
	out: string;
	timeoutMs: number;
	msgtypes: Set<string> | null;
	verbose: boolean;
}

function parseArgs(): CliArgs {
	const argv = process.argv.slice(2);
	let accountId = "";
	let out = path.join(os.tmpdir(), "dingtalk-capture.jsonl");
	let timeoutMs = 0;
	let msgtypes: Set<string> | null = null;
	let verbose = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--account") {
			accountId = argv[++i] ?? "";
			continue;
		}
		if (a === "--out") {
			out = argv[++i] ?? out;
			continue;
		}
		if (a === "--timeout") {
			timeoutMs = Number(argv[++i] ?? 0);
			continue;
		}
		if (a === "--msgtypes") {
			msgtypes = new Set(
				(argv[++i] ?? "")
					.split(",")
					.map(s => s.trim())
					.filter(Boolean),
			);
			continue;
		}
		if (a === "--verbose" || a === "-v") {
			verbose = true;
			continue;
		}
		if (a === "--help" || a === "-h") {
			console.log(
				"Usage: bun run scripts/capture-dingtalk.ts --account <id> [--out <file>] [--timeout <ms>] [--msgtypes a,b,c] [-v]",
			);
			process.exit(0);
		}
	}
	if (!accountId) {
		console.error("error: --account <accountId> is required (must match a key in channels.dingtalk.accounts)");
		process.exit(1);
	}
	return { accountId, out, timeoutMs, msgtypes, verbose };
}

async function main() {
	const args = parseArgs();
	const cfg = await loadConfig();
	const dt = getDingTalkConfig(cfg);
	if (!dt) {
		console.error("error: no dingtalk config in gateway.json");
		process.exit(1);
	}
	const account = dt.accounts?.[args.accountId];
	if (!account) {
		console.error(
			`error: account "${args.accountId}" not found. Available: ${Object.keys(dt.accounts ?? {}).join(", ")}`,
		);
		process.exit(1);
	}

	const client = new DWClient({
		clientId: account.appKey!,
		clientSecret: account.appSecret!,
		ua: "pi-gateway/0.1.0",
		debug: args.verbose,
		autoReconnect: true,
	});

	const seenMsgIds = new Set<string>();
	let captureCount = 0;
	let lastCaptureAt = Date.now();

	const append = async (raw: DingTalkRawMessage) => {
		const line = `${JSON.stringify(raw)}\n`;
		try {
			await fs.appendFile(args.out, line, "utf8");
		} catch (err) {
			console.error(`failed to write to ${args.out}:`, err);
		}
		console.log(`\n${"─".repeat(72)}`);
		console.log(`# captured at ${new Date().toISOString()}`);
		console.log(`# msgtype=${raw.msgtype} msgId=${raw.msgId} sender=${raw.senderNick} (${raw.senderStaffId})`);
		console.log(`# conversationType=${raw.conversationType} conversationId=${raw.conversationId}`);
		console.log("─".repeat(72));
		console.log(JSON.stringify(raw, null, 2));
	};

	client.on("connect", () => {
		console.log(`[capture] connected as account="${args.accountId}" robotCode=${account.robotCode}`);
	});
	client.on("disconnect", () => console.warn("[capture] disconnected — SDK will auto-reconnect"));
	client.on("reconnecting", () => console.warn("[capture] reconnecting..."));

	client.registerCallbackListener(TOPIC_ROBOT, async (downstream: DWClientDownStream) => {
		let raw: DingTalkRawMessage;
		try {
			raw = JSON.parse(downstream.data) as DingTalkRawMessage;
		} catch (err) {
			console.error("[capture] parse error:", err, "raw.data=", downstream.data);
			return;
		}
		if (args.msgtypes && !args.msgtypes.has(raw.msgtype ?? "")) {
			if (args.verbose) console.log(`[capture] skip msgtype=${raw.msgtype}`);
			return;
		}
		if (raw.msgId && seenMsgIds.has(raw.msgId)) {
			if (args.verbose) console.log(`[capture] dedup skip msgId=${raw.msgId}`);
			return;
		}
		if (raw.msgId) seenMsgIds.add(raw.msgId);
		captureCount++;
		lastCaptureAt = Date.now();
		await append(raw);
	});

	await client.connect();
	console.log(`[capture] listening — appending to ${args.out}`);
	console.log(`[capture] send a message to your bot. Ctrl-C to stop.`);
	if (args.timeoutMs > 0) {
		setTimeout(() => {
			console.log(`[capture] hard timeout ${args.timeoutMs}ms reached, exiting. Captured ${captureCount}.`);
			client.disconnect();
			process.exit(0);
		}, args.timeoutMs);
	}

	// Idle watchdog: if no capture for 30s, exit.
	const idle = setInterval(() => {
		if (captureCount > 0 && Date.now() - lastCaptureAt > 30_000) {
			console.log(`[capture] 30s idle, exiting. Captured ${captureCount}.`);
			clearInterval(idle);
			client.disconnect();
			process.exit(0);
		}
	}, 5_000);

	const shutdown = () => {
		console.log(`\n[capture] shutting down. Captured ${captureCount} to ${args.out}`);
		clearInterval(idle);
		client.disconnect();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	// Keep alive
	await new Promise<void>(() => {});
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});

// Unused: `fullConfig` is built for callers that want to feed the same
// credentials into DingTalkChannel via the dump harness; capture-only mode
// doesn't need it, but we keep the import to make the dependency explicit
// for follow-up tooling.
void (null as unknown as DingTalkConfig);

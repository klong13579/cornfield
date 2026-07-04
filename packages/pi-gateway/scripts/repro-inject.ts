/**
 * repro-inject — 复现钉钉问题时,从终端注入消息,真发回钉钉用户
 *
 * 用法
 * ────
 * 1. 一次性抓 webhook (在钉钉给 bot 发一条消息,30s 内会抓到一个 sessionWebhook):
 *      bun run scripts/repro-inject.ts --account hr --grab-webhook
 *
 * 2. 注入测试消息 (用抓到的 webhook,网关真处理,回复真发回钉钉):
 *      bun run scripts/repro-inject.ts --account hr --text "帮我看下这个工单"
 *
 * 3. 一步到位 (抓 + 注入):
 *      bun run scripts/repro-inject.ts --account hr --text "..." --grab-webhook
 *
 * 4. 临时用一个 webhook (不写缓存):
 *      bun run scripts/repro-inject.ts --account hr --text "..." \
 *          --webhook "https://oapi.dingtalk.com/robot/sendBySession?session=xxx"
 *
 * 工作原理
 * ────────
 * 走 Gateway.#startTestServer 的 POST /test/inject 端点,但**不传 captureOutbound**,
 * 所以 channel.sendMessage 是真 DingTalkChannel.sendMessage —— POST 到 sessionWebhook,
 * 钉钉用户那边直接看到 bot 回复。和 dm-inject-cron-e2e.test.ts 那个 FakeDingTalkChannel
 * (把 sendMessage override 成 push 数组) 是反过来的:那个完全不出网关,这个真出。
 *
 * 缓存的 sessionWebhook 按 accountId:conversationId 分组,放在 ~/.omp/repro-state.json。
 * 5 分钟左右过期,过期后 DingTalkChannel.sendMessage 自动 fall back 到 OAuth 主动 DM
 * (前提是 raw.senderStaffId 填了,会被透传成 outbound.toUserId)。
 *
 * 前置条件
 * ────────
 * - 网关跑着且 OMP_GATEWAY_TEST_MODE=1 (看 `lsof -iTCP:7890 -sTCP:LISTEN` 或
 *   `curl http://127.0.0.1:7890/test/health` 应该回 {"ok":true,"mode":"test-injection"})
 * - 目标账号在 gateway.json 里 enabled
 * - 抓 webhook 时,网关和这个脚本各自连一个 DingTalk WebSocket。DingTalk 把消息
 *   路由到其中一个连接。运气不好时网关先抢到,脚本就等下一次。最差多发几次就行。
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DWClient, type DWClientDownStream, TOPIC_ROBOT } from "dingtalk-stream";
import { getDingTalkConfig, loadConfig } from "../src/config";
import type { DingTalkRawMessage } from "../src/types";

const STATE_PATH = path.join(os.homedir(), ".omp", "repro-state.json");
const DEFAULT_GATEWAY = "http://127.0.0.1:7890";
const WEBHOOK_TTL_MS = 5 * 60_000;

interface WebhookEntry {
	sessionWebhook: string;
	conversationId: string;
	senderStaffId: string;
	senderNick: string;
	expiresAt: number;
	capturedAt: number;
	accountId: string;
}

interface State {
	webhooks: Record<string, WebhookEntry>;
}

interface CliArgs {
	account: string;
	text: string | undefined;
	webhook: string | undefined;
	grab: boolean;
	sender: string | undefined;
	senderNick: string | undefined;
	conversation: string | undefined;
	port: number;
	gateway: string;
	configPath: string | undefined;
	listOnly: boolean;
	clear: boolean;
	timeout: number;
	json: boolean;
	verify: boolean;
	verifyTimeoutMs: number;
	agentDir: string | undefined;
}

function parseArgs(): CliArgs {
	const argv = process.argv.slice(2);
	const args: CliArgs = {
		account: "",
		text: undefined,
		webhook: undefined,
		grab: false,
		sender: undefined,
		senderNick: undefined,
		conversation: undefined,
		port: 7890,
		gateway: process.env.GATEWAY_URL ?? DEFAULT_GATEWAY,
		configPath: undefined,
		listOnly: false,
		clear: false,
		timeout: 60_000,
		json: false,
		verify: false,
		verifyTimeoutMs: 90_000,
		agentDir: undefined,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		const next = (): string => {
			const v = argv[++i];
			if (v === undefined) {
				console.error(`error: ${a} requires a value`);
				process.exit(2);
			}
			return v;
		};
		switch (a) {
			case "-h":
			case "--help":
				printHelp();
				process.exit(0);
				break;
			case "--account":
				args.account = next();
				break;
			case "--text":
				args.text = next();
				break;
			case "--webhook":
				args.webhook = next();
				break;
			case "--grab-webhook":
				args.grab = true;
				break;
			case "--sender":
				args.sender = next();
				break;
			case "--sender-nick":
				args.senderNick = next();
				break;
			case "--conversation":
				args.conversation = next();
				break;
			case "--port":
				args.port = Number(next());
				args.gateway = `http://127.0.0.1:${args.port}`;
				break;
			case "--gateway":
				args.gateway = next();
				break;
			case "--config":
				args.configPath = next();
				break;
			case "--list":
				args.listOnly = true;
				break;
			case "--clear":
				args.clear = true;
				break;
			case "--timeout":
				args.timeout = Number(next());
				break;
			case "--json":
				args.json = true;
				break;
			case "--verify":
				args.verify = true;
				break;
			case "--verify-timeout":
				args.verifyTimeoutMs = Number(next());
				break;
			case "--agent-dir":
				args.agentDir = next();
				break;
			default:
				console.error(`error: unknown arg ${a}`);
				process.exit(2);
		}
	}
	if (!args.account && !args.listOnly && !args.clear) {
		console.error("error: --account <id> required (or use --list / --clear)");
		process.exit(2);
	}
	if (!args.text && !args.grab && !args.listOnly && !args.clear) {
		console.error("error: --text <msg> required (or use --grab-webhook / --list / --clear)");
		process.exit(2);
	}
	return args;
}

function printHelp() {
	console.log(`repro-inject — 复现钉钉问题时的消息注入工具

用法:
  bun run scripts/repro-inject.ts --account <id> --text "<msg>" [选项]

必需:
  --account <id>             gateway.json 里的钉钉账号 (如 hr / algorithm)

二选一:
  --text "<msg>"             要发给 bot 的消息文本
  --grab-webhook             不注入,只从真实 DingTalk 流量抓一个 sessionWebhook

注入相关:
  --webhook <url>            显式指定 sessionWebhook (一次性,不写缓存)
  --sender <staffId>         覆盖 raw.senderStaffId (默认用抓到的)
  --sender-nick <name>       覆盖 raw.senderNick
  --conversation <id>        覆盖 raw.conversationId (默认用抓到的)
  --grab-webhook             注入前先抓一个新 webhook (盖过缓存)

网关:
  --port <n>                 /test/inject 端口 (默认 7890)
  --gateway <url>            网关根 URL (默认 http://127.0.0.1:7890)

杂项:
  --config <path>            自定义 gateway.json 路径
  --timeout <ms>             --grab-webhook 等多久 (默认 60000)
  --list                     列出缓存的 webhooks 然后退出
  --clear                    清空缓存然后退出
  --json                     输出 JSON 而不是人类可读文本
  --verify                   注入后等 agent 回复, 从 session JSONL 读出来打印
  --verify-timeout <ms>      --verify 等多久 (默认 90000)
  --agent-dir <path>         override gateway.json 里的 agentDir (--verify 需要)

示例:
  # 1. 抓 webhook (在钉钉给 bot 发消息,30s 内会被抓走)
  bun run scripts/repro-inject.ts --account hr --grab-webhook

  # 2. 用缓存的 webhook 注入消息
  bun run scripts/repro-inject.ts --account hr --text "帮我查这个工单"

  # 3. 一步: 抓 + 注入
  bun run scripts/repro-inject.ts --account hr --text "复现这个 bug" --grab-webhook

  # 4. 临时用一个 webhook (不写缓存)
  bun run scripts/repro-inject.ts --account hr --text "..." \\
      --webhook "https://oapi.dingtalk.com/robot/sendBySession?session=xxx"

  # 5. 注入 + 验证 (等 agent 回复, 从 session JSONL 读出响应)
  bun run scripts/repro-inject.ts --account hr --text "ping" \\
      --webhook "http://127.0.0.1:7892/..." --verify

注意: DM 走 AI Card 流式路径, 用户的 DingTalk 客户端直接看到 bot 的卡片回复。
sessionWebhook (webhook POST) 只是 V1 markdown 降级路径, 默认不触发。要确认 agent
真的回了, 用 --verify 或者直接看 <agentDir>/sessions/<conversationId>.jsonl。
`);
}

async function loadState(): Promise<State> {
	try {
		const text = await Bun.file(STATE_PATH).text();
		return JSON.parse(text) as State;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { webhooks: {} };
		console.warn(`warn: failed to read ${STATE_PATH}: ${err}. Starting with empty state.`);
		return { webhooks: {} };
	}
}

async function saveState(state: State): Promise<void> {
	await fs.mkdir(path.dirname(STATE_PATH), { recursive: true, mode: 0o700 });
	await Bun.write(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function webhookKey(accountId: string, conversationId: string): string {
	return `${accountId}:${conversationId}`;
}

function fmtExpiry(entry: WebhookEntry): string {
	const remaining = entry.expiresAt - Date.now();
	if (remaining <= 0) return `EXPIRED ${new Date(entry.expiresAt).toISOString()}`;
	const mins = Math.floor(remaining / 60_000);
	const secs = Math.floor((remaining % 60_000) / 1000);
	return `expires in ${mins}m${secs}s (${new Date(entry.expiresAt).toISOString()})`;
}

async function listWebhooks(args: CliArgs): Promise<void> {
	const state = await loadState();
	const keys = Object.keys(state.webhooks);
	if (args.json) {
		console.log(JSON.stringify(state, null, 2));
		return;
	}
	if (keys.length === 0) {
		console.log(`(empty — no cached webhooks in ${STATE_PATH})`);
		return;
	}
	console.log(`Cached webhooks (${keys.length}):`);
	for (const [k, e] of Object.entries(state.webhooks)) {
		console.log(`  ${k}`);
		console.log(`    sender:    ${e.senderNick} (${e.senderStaffId})`);
		console.log(`    webhook:   ${e.sessionWebhook.slice(0, 80)}...`);
		console.log(`    captured:  ${new Date(e.capturedAt).toISOString()}`);
		console.log(`    ${fmtExpiry(e)}`);
	}
}

async function clearWebhooks(): Promise<void> {
	try {
		await fs.unlink(STATE_PATH);
		console.log(`cleared ${STATE_PATH}`);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") console.log("(nothing to clear)");
		else throw err;
	}
}

async function getAccountConfig(args: CliArgs) {
	const cfg = await loadConfig(args.configPath);
	const dt = getDingTalkConfig(cfg);
	if (!dt) throw new Error("no dingtalk config in gateway.json");
	const acct = dt.accounts?.[args.account];
	if (!acct) {
		const available = Object.keys(dt.accounts ?? {}).join(", ");
		throw new Error(`account "${args.account}" not in gateway.json. Available: ${available}`);
	}
	if (!acct.appKey || !acct.appSecret) {
		throw new Error(`account "${args.account}" missing appKey/appSecret`);
	}
	return { cfg, acct, dt };
}

async function grabWebhook(args: CliArgs): Promise<WebhookEntry> {
	const { acct } = await getAccountConfig(args);
	const log = (m: string): void => {
		if (!args.json) console.log(m);
	};

	log(`[grab] connecting to DingTalk as account="${args.account}"...`);
	const client = new DWClient({
		clientId: acct.appKey!,
		clientSecret: acct.appSecret!,
		ua: "pi-gateway-repro-inject/0.1",
		debug: false,
		autoReconnect: false,
	});

	return new Promise<WebhookEntry>((resolve, reject) => {
		const timer = setTimeout(() => {
			client.disconnect().catch(() => {});
			reject(
				new Error(
					`timeout: no DingTalk message received in ${args.timeout}ms. ` +
						`Open DingTalk, find the bot, send any message.`,
				),
			);
		}, args.timeout);

		const onReady = (): void => {
			log(`[grab] connected. Send a message to your bot NOW (you have ${Math.floor(args.timeout / 1000)}s).`);
		};
		client.once("connect", onReady);

		client.registerCallbackListener(TOPIC_ROBOT, (downstream: DWClientDownStream) => {
			clearTimeout(timer);
			client.removeListener("connect", onReady);
			try {
				const raw = JSON.parse(downstream.data) as DingTalkRawMessage;
				const entry: WebhookEntry = {
					sessionWebhook: raw.sessionWebhook,
					conversationId: raw.conversationId,
					senderStaffId: raw.senderStaffId ?? raw.senderId ?? "",
					senderNick: raw.senderNick ?? "User",
					expiresAt: raw.sessionWebhookExpiredTime ?? Date.now() + WEBHOOK_TTL_MS,
					capturedAt: Date.now(),
					accountId: args.account,
				};
				client.disconnect().catch(() => {});
				resolve(entry);
			} catch (err) {
				client.disconnect().catch(() => {});
				reject(new Error(`failed to parse DingTalk frame: ${err}`));
			}
		});

		client.connect().catch(err => {
			clearTimeout(timer);
			reject(new Error(`DingTalk connect failed: ${err}`));
		});
	});
}

async function pingGateway(args: CliArgs): Promise<boolean> {
	try {
		const r = await fetch(`${args.gateway}/test/health`, { signal: AbortSignal.timeout(2000) });
		if (!r.ok) return false;
		const body = (await r.json()) as { ok: boolean; mode: string };
		return body.ok && body.mode === "test-injection";
	} catch {
		return false;
	}
}

function buildRawMessage(args: CliArgs, entry: WebhookEntry): DingTalkRawMessage {
	const messageId = `repro-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const conversationId = args.conversation ?? entry.conversationId;
	const senderStaffId = args.sender ?? entry.senderStaffId;
	const senderNick = args.senderNick ?? entry.senderNick;
	return {
		conversationId,
		conversationType: "1",
		chatbotCorpId: "repro",
		chatbotUserId: "repro",
		isAdmin: false,
		senderCorpId: "repro",
		robotCode: "repro",
		isInAtList: false,
		atUsers: [],
		conversationTitle: "Repro",
		sessionWebhookExpiredTime: entry.expiresAt,
		createAt: Date.now(),
		msgtype: "text",
		senderNick,
		senderStaffId,
		sessionWebhook: entry.sessionWebhook,
		senderId: senderStaffId,
		msgId: messageId,
		text: { content: args.text ?? "" },
	};
}

async function inject(
	args: CliArgs,
	entry: WebhookEntry,
): Promise<{ ok: boolean; conversationId?: string; messageId?: string }> {
	const raw = buildRawMessage(args, entry);
	if (entry.expiresAt < Date.now()) {
		console.warn(`[inject] WARN: sessionWebhook expired at ${new Date(entry.expiresAt).toISOString()}`);
		console.warn(
			"[inject] Will still POST; channel.sendMessage will fall back to OAuth DM (Route 2/3) if Route 1 (webhook) returns errcode 300001.",
		);
	}
	const resp = await fetch(`${args.gateway}/test/inject`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			accountId: args.account,
			// NOT setting captureOutbound → real channel.sendMessage fires
			raw,
		}),
	});
	const body = (await resp.json()) as Record<string, unknown>;
	if (args.json) {
		console.log(JSON.stringify({ request: { accountId: args.account, raw }, response: body }, null, 2));
	} else {
		console.log(`[inject] POST /test/inject → HTTP ${resp.status}`);
		console.log(JSON.stringify(body, null, 2));
		if (body.ok) {
			console.log(
				`[inject] ✓ message routed through ${args.account} → AgentBridge. Reply will arrive in the user's DingTalk.`,
			);
		} else {
			console.error(`[inject] ✗ failed: ${body.reason ?? "unknown"}`);
		}
	}
	return {
		ok: body.ok === true,
		conversationId: typeof body.conversationId === "string" ? body.conversationId : undefined,
		messageId: typeof body.messageId === "string" ? body.messageId : undefined,
	};
}

interface SessionMessage {
	role: string;
	content: Array<{ type: string; text?: string; thinking?: string }>;
}

async function readSessionResponse(
	agentDir: string,
	conversationId: string,
): Promise<{ ok: true; messages: SessionMessage[]; path: string } | { ok: false; reason: string; path: string }> {
	const safe = conversationId.replace(/[^A-Za-z0-9_.-]/g, "_");
	const path = `${agentDir.replace(/\/$/, "")}/sessions/${safe}.jsonl`;
	let text: string;
	try {
		text = await Bun.file(path).text();
	} catch (err) {
		return { ok: false, reason: `cannot read session file: ${err}`, path };
	}
	const messages: SessionMessage[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const e = JSON.parse(trimmed) as { type?: string; message?: SessionMessage };
			if (e.type === "message" && e.message) messages.push(e.message);
		} catch {
			// skip malformed lines
		}
	}
	return { ok: true, messages, path };
}

async function verifySessionResponse(
	args: CliArgs,
	injectResult: { ok: boolean; conversationId?: string },
): Promise<void> {
	if (!args.verify) return;
	if (!args.agentDir) {
		console.error("[verify] --verify requires --agent-dir <path> (or read it from gateway.json)");
		return;
	}
	const convId = injectResult.conversationId ?? args.conversation;
	if (!convId) {
		console.error("[verify] no conversationId to look up (inject result missing it)");
		return;
	}
	const start = Date.now();
	let lastLen = 0;
	let lastMessages: SessionMessage[] = [];
	while (Date.now() - start < args.verifyTimeoutMs) {
		const result = await readSessionResponse(args.agentDir, convId);
		if (result.ok) {
			const assistants = result.messages.filter(m => m.role === "assistant");
			if (assistants.length > 0 && result.messages.length > lastLen) {
				lastLen = result.messages.length;
				lastMessages = result.messages;
				// 找到一个 assistant text block 且不再增长 = 响应完成
				const lastAssistant = assistants[assistants.length - 1]!;
				const hasText = lastAssistant.content.some(c => c.type === "text" && c.text?.trim());
				if (hasText) {
					// 等 1s 确认不再有新消息
					await Bun.sleep(1000);
					const r2 = await readSessionResponse(args.agentDir, convId);
					if (r2.ok && r2.messages.length === lastLen) {
						printSessionResult(args, r2.path, r2.messages);
						return;
					}
				}
			}
		}
		await Bun.sleep(500);
	}
	console.error(`[verify] timeout after ${args.verifyTimeoutMs}ms`);
	if (lastMessages.length > 0) {
		console.error("[verify] last seen state (incomplete):");
		printSessionResult(args, "<partial>", lastMessages);
	} else {
		console.error(`[verify] no assistant message appeared. Check ${args.agentDir}/sessions/${convId}.jsonl`);
	}
}

function printSessionResult(args: CliArgs, path: string, messages: SessionMessage[]): void {
	if (args.json) {
		console.log(
			JSON.stringify(
				{
					sessionPath: path,
					messages: messages.map(m => ({
						role: m.role,
						content: m.content.map(c => ({ type: c.type, text: c.text, thinking: c.thinking })),
					})),
				},
				null,
				2,
			),
		);
		return;
	}
	console.log(`\n[verify] session: ${path}`);
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const c of m.content) {
			if (c.type === "thinking" && c.thinking) {
				console.log(`\n  💭 thinking:`);
				console.log(`     ${c.thinking.split("\n").join("\n     ")}`);
			} else if (c.type === "text" && c.text) {
				console.log(`\n  ✉️  text:`);
				console.log(`     ${c.text.split("\n").join("\n     ")}`);
			}
		}
	}
}

async function main(): Promise<void> {
	const args = parseArgs();
	const log = (m: string): void => {
		if (!args.json) console.log(m);
	};

	if (args.listOnly) {
		await listWebhooks(args);
		return;
	}
	if (args.clear) {
		await clearWebhooks();
		return;
	}

	const state = await loadState();

	// 健康检查
	if (!(await pingGateway(args))) {
		console.error(
			`[repro] gateway test endpoint not reachable at ${args.gateway}. ` +
				`Is OMP_GATEWAY_TEST_MODE=1 set on the running gateway? ` +
				`Try: curl ${args.gateway}/test/health`,
		);
		process.exit(3);
	}
	log(`[repro] gateway OK at ${args.gateway}`);

	let entry: WebhookEntry | undefined;

	if (args.webhook) {
		// 显式 webhook (一次性, 不写缓存)
		entry = {
			sessionWebhook: args.webhook,
			conversationId: args.conversation ?? "ad-hoc",
			senderStaffId: args.sender ?? "ad-hoc-user",
			senderNick: args.senderNick ?? "Ad-hoc",
			expiresAt: Date.now() + WEBHOOK_TTL_MS,
			capturedAt: Date.now(),
			accountId: args.account,
		};
		log(`[repro] using explicit webhook (ad-hoc, not cached)`);
	} else if (args.grab) {
		log(`[repro] grabbing fresh webhook from real DingTalk traffic...`);
		entry = await grabWebhook(args);
		log(
			`[repro] ✓ captured webhook for ${entry.accountId}:${entry.conversationId} (sender=${entry.senderNick}/${entry.senderStaffId}, ${fmtExpiry(entry)})`,
		);
	} else {
		// 尝试缓存
		const targetConv = args.conversation;
		const candidates = Object.values(state.webhooks).filter(e => e.accountId === args.account);
		const cached = targetConv
			? candidates.find(e => e.conversationId === targetConv)
			: candidates.sort((a, b) => b.capturedAt - a.capturedAt)[0];
		if (!cached) {
			console.error(
				`[repro] no cached webhook for account "${args.account}". ` +
					`Run with --grab-webhook (you'll send one real DingTalk message to populate the cache).`,
			);
			process.exit(4);
		}
		if (cached.expiresAt < Date.now()) {
			console.warn(`[repro] cached webhook is expired. Will try anyway; OAuth DM fallback may kick in.`);
		}
		entry = cached;
		log(`[repro] using cached webhook (${webhookKey(entry.accountId, entry.conversationId)}, ${fmtExpiry(entry)})`);
	}

	// 写缓存 (除非 --webhook 临时)
	if (!args.webhook) {
		state.webhooks[webhookKey(entry.accountId, entry.conversationId)] = entry;
		await saveState(state);
	}

	// --verify 需要 agentDir; 如果用户没传, 从 gateway.json 里的 account 读
	if (args.verify && !args.agentDir) {
		try {
			const { acct } = await getAccountConfig(args);
			if (acct.agentDir) {
				args.agentDir = acct.agentDir;
				log(`[repro] --agent-dir auto-filled from gateway.json: ${args.agentDir}`);
			} else {
				console.error(
					`[repro] --verify requires --agent-dir, and account "${args.account}" has no agentDir in gateway.json.`,
				);
				process.exit(5);
			}
		} catch (err) {
			console.error(
				`[repro] --verify requires --agent-dir, and couldn't read gateway.json: ${err instanceof Error ? err.message : String(err)}`,
			);
			process.exit(5);
		}
	}

	// 注入
	if (args.text) {
		const result = await inject(args, entry);
		if (args.verify && result.ok) {
			await verifySessionResponse(args, result);
		}
	} else if (args.grab) {
		if (!args.json) {
			console.log("\n[repro] (no --text given; webhook saved, not injecting)");
			console.log(JSON.stringify(entry, null, 2));
		} else {
			console.log(JSON.stringify(entry, null, 2));
		}
	}
}

main().catch(err => {
	console.error(`[repro] fatal: ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});

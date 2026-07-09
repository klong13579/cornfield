/**
 * repro-inject — 复现钉钉问题时,从终端注入消息,真发回钉钉用户
 *
 * 用法
 * ────
 * 1. 默认从 gateway 的 sessions.db 读最近一次活跃会话的 webhook,直接注入
 *    (不需要预先发消息,只要用户之前跟 bot 聊过,gateway 自动把 webhook 写进 db):
 *      bun run .omp/skills/repro-inject/repro-inject.ts --account hr --text "帮我看下这个工单"
 *
 * 2. 注入 + 验证 (等 agent 回复, 从 session JSONL 读出响应):
 *      bun run .omp/skills/repro-inject/repro-inject.ts --account hr --text "ping" --verify
 *
 * 3. 冷启动: db 里没有该账号的会话,自动转 grab (让你在钉钉给 bot 发一条消息):
 *      bun run .omp/skills/repro-inject/repro-inject.ts --account hr --text "..." --grab-webhook
 *
 * 4. CI / 纯复现场景: db 没有就直接报错,不要抓:
 *      bun run .omp/skills/repro-inject/repro-inject.ts --account hr --text "..." --no-grab-fallback
 *
 * 5. 临时用一个 webhook (不写缓存,不查 db):
 *      bun run .omp/skills/repro-inject/repro-inject.ts --account hr --text "..." \
 *          --webhook "https://oapi.dingtalk.com/robot/sendBySession?session=xxx"
 *
 * 工作原理
 * ────────
 * 走 Gateway.#startTestServer 的 POST /test/inject 端点,但**不传 captureOutbound**,
 * 所以 channel.sendMessage 是真 DingTalkChannel.sendMessage —— POST 到 sessionWebhook,
 * 钉钉用户那边直接看到 bot 回复。和 dm-inject-cron-e2e.test.ts 那个 FakeDingTalkChannel
 * (把 sendMessage override 成 push 数组) 是反过来的:那个完全不出网关,这个真出。
 *
 * Webhook 来源 (优先级)
 * ───────────────────
 *   1. --webhook 显式 URL (一次性,不写缓存,不查 db)
 *   2. --grab-webhook 实时抓 (另起 DWClient 连钉Talk WS)
 *   3. ~/.omp/gateway-data/sessions.db 里该 account_id 的最近一条 active 会话
 *      (过滤掉 repro-/-test-/-regress-/e2e- 这类自动化测试残留会话,
 *       优先取 webhook 域名是 oapi.dingtalk.com 的)
 *   4. 上面都没有 → 自动 fallback 到 grab (除非 --no-grab-fallback)
 *
 * 关于"过期": db 里没存 sessionWebhookExpiredTime,我们用 updated_at 推断。
 * 实测钉Talk 服务端对 token 失效判定比 5min 文档更宽松,21 分钟前的 webhook
 * 仍能 200 OK 发消息。所以 db 路径不过滤"过期",让 sendMessage 走 OAuth DM 兜底。
 *
 * 前置条件
 * ────────
 * - 网关跑着且 OMP_GATEWAY_TEST_MODE=1 (看 `lsof -iTCP:7890 -sTCP:LISTEN` 或
 *   `curl http://127.0.0.1:7890/test/health` 应该回 {"ok":true,"mode":"test-injection"})
 * - 目标账号在 gateway.json 里 enabled
 * - 走 db 路径: 该账号之前在钉钉跟 bot 聊过, gateway 写入了 session_webhook
 * - 走 grab 路径: 你 (脚本 + 网关) 各连一个 DingTalk WebSocket。钉Talk 把消息
 *   路由到其中一个连接。运气不好时网关先抢到,脚本就等下一次。最差多发几次就行。
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DWClient, type DWClientDownStream, TOPIC_ROBOT } from "dingtalk-stream";
// Relative path goes 3 levels up (.omp/skills/repro-inject -> oh-my-pi) to reach the pi-gateway package.
// 脚本与 skill 同住 于 .omp/skills/repro-inject/,保留原始 package 依赖而非复制。
import { getDingTalkConfig, loadConfig } from "../../../packages/pi-gateway/src/config";
import type { DingTalkRawMessage } from "../../../packages/pi-gateway/src/types";

const STATE_PATH = path.join(os.homedir(), ".omp", "repro-state.json");
const DEFAULT_GATEWAY = "http://127.0.0.1:7890";
const DEFAULT_GATEWAY_DATA_DIR = path.join(os.homedir(), ".omp", "gateway-data");
const WEBHOOK_TTL_MS = 5 * 60_000;

/**
 * conversationId 包含这些子串的视为自动化测试残留,不作为 db 路径的候选。
 * 真实用户 DM 的 convId 通常是 `cidH...` 这种 base64 风格(无连字符/无 test 词)。
 */
const TEST_CONVERSATION_PATTERNS = ["repro-", "-test-", "-regress", "e2e-", "ci-test"];

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
	noGrabFallback: boolean;
	sender: string | undefined;
	senderNick: string | undefined;
	conversation: string | undefined;
	port: number;
	gateway: string;
	configPath: string | undefined;
	gatewayDataDir: string;
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
		noGrabFallback: false,
		sender: undefined,
		senderNick: undefined,
		conversation: undefined,
		port: 7890,
		gateway: process.env.GATEWAY_URL ?? DEFAULT_GATEWAY,
		configPath: undefined,
		gatewayDataDir: process.env.GATEWAY_DATA_DIR ?? DEFAULT_GATEWAY_DATA_DIR,
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
			case "--no-grab-fallback":
				args.noGrabFallback = true;
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
			case "--gateway-data-dir":
				args.gatewayDataDir = next();
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
  bun run .omp/skills/repro-inject/repro-inject.ts --account <id> --text "<msg>" [选项]

必需:
  --account <id>             gateway.json 里的钉钉账号 (如 hr / algorithm)
  --text "<msg>"             要发给 bot 的消息文本

Webhook 来源 (按优先级):
  1. --webhook  <url>        显式指定 sessionWebhook (一次性, 不写缓存, 不查 db)
  2. --grab-webhook          连钉Talk WS 实时抓一个新 webhook
  3. (默认) 读 sessions.db  sessions.db 里该账号最近一条 active 会话的 webhook
                             (过滤掉 repro-/-test-/-regress-/e2e-/ci-test 残留)
  4. (默认) grab fallback    上面 3 拿不到时, 自动转 grab (发一条真消息)
                             --no-grab-fallback 可禁用此 fallback, 拿不到直接报错

字段覆盖:
  --sender <staffId>         覆盖 raw.senderStaffId (默认用 db 里的 user_id)
  --sender-nick <name>       覆盖 raw.senderNick (默认用 user_id 填充)
  --conversation <id>        覆盖 raw.conversationId (默认用 db 里查到的)

网关:
  --port <n>                 /test/inject 端口 (默认 7890)
  --gateway <url>            网关根 URL (默认 http://127.0.0.1:7890)
  --gateway-data-dir <path>  gateway 数据目录 (默认 ~/.omp/gateway-data)

杂项:
  --config <path>            自定义 gateway.json 路径
  --timeout <ms>             --grab-webhook 等多久 (默认 60000)
  --list                     列出 ~/.omp/repro-state.json 里的缓存 webhooks
  --clear                    清空 ~/.omp/repro-state.json
  --json                     输出 JSON 而不是人类可读文本
  --verify                   注入后等 agent 回复, 从 session JSONL 读出来打印
  --verify-timeout <ms>      --verify 等多久 (默认 90000)
  --agent-dir <path>         override gateway.json 里的 agentDir (--verify 需要)

示例:
  # 1. 最常用: 默认从 sessions.db 读最近活跃 webhook
  bun run .omp/skills/repro-inject/repro-inject.ts --account hr --text "帮我看下这个工单"

  # 2. + 验证 agent 回复
  bun run .omp/skills/repro-inject/repro-inject.ts --account hr --text "ping" --verify

  # 3. 冷启动: db 没有该账号会话时, 显式要求 grab (在钉钉给 bot 发一条)
  bun run .omp/skills/repro-inject/repro-inject.ts --account hr --text "..." --grab-webhook

  # 4. CI/纯复现: db 没有就报错退出, 不要触发抓包
  bun run .omp/skills/repro-inject/repro-inject.ts --account hr --text "..." --no-grab-fallback

  # 5. 临时用一个 webhook (不写缓存, 不查 db)
  bun run .omp/skills/repro-inject/repro-inject.ts --account hr --text "..." \\
      --webhook "https://oapi.dingtalk.com/robot/sendBySession?session=xxx"

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

/**
 * 从 gateway 的 sessions.db 读该账号最近一条 active 会话的 webhook。
 *
 * Returns null if:
 *   - db 文件不存在 (网关从未启动, 或 dataDir 路径不对)
 *   - 该账号无 active 会话
 *   - 所有 active 会话的 conversationId 都是测试残留 (repro-/-test-/-regress-/e2e-/ci-test)
 *   - 所有 active 会话的 session_webhook 都不是 oapi.dingtalk.com 域名
 *
 * 注: db 是 WAL 模式, gateway 进程持锁时仍可读; 不需要锁。
 */
async function tryReadWebhookFromDb(args: CliArgs): Promise<WebhookEntry | null> {
	const dbPath = path.join(args.gatewayDataDir, "sessions.db");
	// 快速预检: bun:sqlite 在 db 不存在 + readonly=true 时会抱 "unable to open database file",
	// 不是 ENOENT, 不如在脚本层先 stat 一下, 冷启动场景静默返 null。
	try {
		await fs.access(dbPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	let db: Database;
	try {
		db = new Database(dbPath, { readonly: true });
	} catch (err) {
		// readonly 失败但文件存在一般是权限问题, 不静默吞。
		throw new Error(`failed to open ${dbPath} readonly: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		// 过滤掉 conversationId 是自动化测试名的会话 (algo-prod-test-... 这类),
		// 以及 session_webhook 不是钉Talk 官方域名的会话 (例如测试占位 example.com)。
		// webhook 域名过滤必须与 conversationId 过滤同时应用, 避免 "只有测试残留 + 一条
		// 未知域名 webhook" 的边角情况下选到坏值。
		const patternClause = TEST_CONVERSATION_PATTERNS.map(() => "conversation_id NOT LIKE ?").join(" AND ");
		const patternArgs = TEST_CONVERSATION_PATTERNS.map(p => `%${p}%`);
		const rows = db
			.query<
				{
					account_id: string;
					conversation_id: string;
					user_id: string;
					session_webhook: string;
					updated_at: number;
				},
				[string, ...string[]]
			>(
				`SELECT account_id, conversation_id, user_id, session_webhook, updated_at
				 FROM sessions
				 WHERE account_id = ?
				   AND status = 'active'
				   AND session_webhook IS NOT NULL
				   AND session_webhook != ''
				   AND session_webhook LIKE 'https://oapi.dingtalk.com/%'
				   AND ${patternClause}
				 ORDER BY updated_at DESC
				 LIMIT 1`,
			)
			.all(args.account, ...patternArgs);
		const row = rows[0];
		if (!row) return null;
		// senderNick db 里没存, 用 user_id 占位。Agent 侧日志看到的发送人是 staffId。
		return {
			sessionWebhook: row.session_webhook,
			conversationId: row.conversation_id,
			senderStaffId: row.user_id,
			senderNick: row.user_id,
			// db 没存 sessionWebhookExpiredTime; 用 updated_at + 5min 估算, 仅作提示。
			// 实际 POST 过去时 DingTalkChannel.sendMessage 走 OAuth DM 兜底, 不受这个值影响。
			expiresAt: row.updated_at + WEBHOOK_TTL_MS,
			capturedAt: row.updated_at,
			accountId: row.account_id,
		};
	} finally {
		db.close();
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
		// DWClient.disconnect() returns void, not a Promise — wrap to swallow any throw.
		const safeDisconnect = (): void => {
			try {
				client.disconnect();
			} catch {
				// noop
			}
		};
		const timer = setTimeout(() => {
			safeDisconnect();
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
				safeDisconnect();
				resolve(entry);
			} catch (err) {
				safeDisconnect();
				reject(new Error(`failed to parse DingTalk frame: ${err}`));
			}
		});

		client.connect().catch(err => {
			clearTimeout(timer);
			reject(new Error(`DingTalk connect failed: ${err}`));
		});
	});
}

/**
 * 判断 conversationId 是否是自动化测试残留。
 * 复用读 db 路径里的同一个过滤名单，保证 db 读、cleanup 两边认知一致。
 */
function isTestResidueConversation(conversationId: string): boolean {
	return TEST_CONVERSATION_PATTERNS.some(p => conversationId.includes(p));
}

/**
 * 注入成功后调：清掉 db 里刚产生的测试残留 session 行。
 *
 * 为什么要清：--conversation repro-... 之类调用会在 db 里 createSession 出一条假会话
 * (因为 /test/inject 走 MessageHandler 全流程)，不走清的话 db 会越积越多 prod-test 残留。
 * 真实用户会话 (cidH... 风格) 不会被匹配到。
 *
 * 局限：agent 端 <safeConvId>.jsonl 不会被删 —— 那边是 agent 运行时写，repro-inject 注入完
 * 成时 agent 可能还在跑，jsonl 还没落盘。jsonl 残留需用户手动 rm (或后续加 --cleanup flag)。
 */
async function cleanupTestResidueSession(
	args: CliArgs,
	conversationId: string,
): Promise<{ deleted: boolean; reason?: string }> {
	const dbPath = path.join(args.gatewayDataDir, "sessions.db");
	try {
		await fs.access(dbPath);
	} catch {
		return { deleted: false, reason: "db not present" };
	}
	const db = new Database(dbPath);
	try {
		const result = db
			.query<{ id: string; status: string }, [string]>("SELECT id, status FROM sessions WHERE conversation_id = ?")
			.get(conversationId);
		if (!result) return { deleted: false, reason: "no row (already gone)" };
		db.run("DELETE FROM sessions WHERE id = ?", result.id);
		return { deleted: true };
	} finally {
		db.close();
	}
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
	let entrySource: "webhook" | "grab" | "db" | undefined;

	if (args.webhook) {
		// 1. 显式 webhook (一次性, 不写缓存, 不查 db)
		entry = {
			sessionWebhook: args.webhook,
			conversationId: args.conversation ?? "ad-hoc",
			senderStaffId: args.sender ?? "ad-hoc-user",
			senderNick: args.senderNick ?? "Ad-hoc",
			expiresAt: Date.now() + WEBHOOK_TTL_MS,
			capturedAt: Date.now(),
			accountId: args.account,
		};
		entrySource = "webhook";
		log(`[repro] using explicit webhook (ad-hoc, not cached)`);
	} else if (args.grab) {
		// 2. 显式要求实时抓
		log(`[repro] grabbing fresh webhook from real DingTalk traffic...`);
		entry = await grabWebhook(args);
		entrySource = "grab";
		log(
			`[repro] ✓ captured webhook for ${entry.accountId}:${entry.conversationId} (sender=${entry.senderNick}/${entry.senderStaffId}, ${fmtExpiry(entry)})`,
		);
	} else {
		// 3. 默认: 查 sessions.db
		const dbEntry = await tryReadWebhookFromDb(args);
		if (dbEntry) {
			entry = dbEntry;
			entrySource = "db";
			const ageMin = Math.max(0, Math.floor((Date.now() - entry.capturedAt) / 60_000));
			log(
				`[repro] ✓ using db webhook for ${entry.accountId}:${entry.conversationId} (sender=${entry.senderNick}, updated ${ageMin}m ago)`,
			);
		} else if (args.noGrabFallback) {
			console.error(
				`[repro] no webhook in sessions.db for account "${args.account}". ` +
					`--no-grab-fallback is set, refusing to grab. Re-run without --no-grab-fallback ` +
					`(or pass --grab-webhook / --webhook explicitly).`,
			);
			process.exit(4);
		} else {
			// 4. fallback: db 拿不到, 转 grab
			log(
				`[repro] no webhook in sessions.db for account "${args.account}" (cold start?); falling back to live grab...`,
			);
			entry = await grabWebhook(args);
			entrySource = "grab";
			log(
				`[repro] ✓ captured webhook for ${entry.accountId}:${entry.conversationId} (sender=${entry.senderNick}/${entry.senderStaffId}, ${fmtExpiry(entry)})`,
			);
		}
	}

	// 写 ~/.omp/repro-state.json 缓存: 只有 grab 路径需要 (5min 复用)。
	// db 路径已经有持久化, --webhook 是临时一次性。
	if (entrySource === "grab") {
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
		if (result.ok) {
			// 如果注入的是测试 convId, 清理 db 里刚 createSession 的那条假会话,
			// 避免 db 越积越多 prod-test 残留。
			if (result.conversationId && isTestResidueConversation(result.conversationId)) {
				const cleanup = await cleanupTestResidueSession(args, result.conversationId);
				if (cleanup.deleted) {
					log(`[repro] ✓ cleaned up test-residue session ${result.conversationId} from sessions.db`);
				} else if (!args.json && cleanup.reason) {
					log(`[repro] (cleanup skipped: ${cleanup.reason})`);
				}
			}
			if (args.verify) {
				await verifySessionResponse(args, result);
			}
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

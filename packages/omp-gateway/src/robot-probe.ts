/**
 * Robot group membership probe.
 *
 * Passive discovery (write-through on inbound @-mentions) only learns about
 * groups where the robot has already been mentioned. This module actively
 * probes the full robot×group matrix:
 *
 *   1. Enumerate the user's conversations via the `dws` CLI
 *      (`dws chat list-all-conversations`) — the human account is the only
 *      identity that can enumerate groups.
 *   2. For each group, call DingTalk's robot-side API
 *      `/v1.0/robot/groups/robots/query` with any gateway account token that
 *      has the `qyapi_chat_manage` permission — the API answers for ALL
 *      robots in the group, not just the token's own robot.
 *   3. Upsert discovered (robot, group) pairs into the sessions table and
 *      refresh each affected account's robot-context.md.
 *
 * Exposed as `omp-gateway robot-context probe [--dry-run]`.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { RobotContextWriter } from "./robot-context";
import type { SQLiteSessionStore } from "./session-store";

/** One robot's membership row as returned by the probe. */
export interface ProbeGroup {
	title: string;
	conversationId: string;
}

export interface ProbeResult {
	/** robotCode → discovered groups */
	byRobot: Map<string, ProbeGroup[]>;
	/** Groups scanned */
	scanned: number;
	/** Groups where the query failed */
	failures: number;
	/** Account whose token was used (first with permission) */
	tokenAccount: string | null;
}

const DINGTALK_API = "https://api.dingtalk.com";

interface AccountCreds {
	appKey: string;
	appSecret: string;
}

/** Fetch an enterprise-internal-app access token. */
async function getAccessToken(creds: AccountCreds): Promise<string> {
	const resp = await fetch(`${DINGTALK_API}/v1.0/oauth2/accessToken`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ appKey: creds.appKey, appSecret: creds.appSecret }),
	});
	if (!resp.ok) {
		throw new Error(`accessToken HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
	}
	const data = (await resp.json()) as { accessToken?: string };
	if (!data.accessToken) throw new Error("accessToken missing in response");
	return data.accessToken;
}

/** Query which robots are members of one group. Throws on HTTP error. */
async function queryGroupRobots(
	token: string,
	openConversationId: string,
): Promise<Array<{ robotCode?: string; name?: string }>> {
	const resp = await fetch(`${DINGTALK_API}/v1.0/robot/groups/robots/query`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
		body: JSON.stringify({ openConversationId }),
	});
	if (!resp.ok) {
		throw new Error(`robots/query HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
	}
	const data = (await resp.json()) as { chatbotInstanceVOList?: Array<{ robotCode?: string; name?: string }> };
	return data.chatbotInstanceVOList ?? [];
}

/** Enumerate the user's conversations via the dws CLI (groups only). */
async function listUserGroups(): Promise<ProbeGroup[]> {
	const proc = Bun.spawn(["dws", "chat", "list-all-conversations", "--format", "json"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`dws chat list-all-conversations exited ${exitCode}: ${stderr.slice(0, 200)}`);
	}
	const parsed = JSON.parse(stdout) as {
		result?: {
			conversations?: Array<{
				openConversationId?: string;
				title?: string;
				singleChat?: boolean;
				groupType?: string;
			}>;
		};
	};
	const convs = parsed.result?.conversations ?? [];
	return convs
		.filter(c => !c.singleChat && c.groupType !== "SINGLE_CHAT" && c.openConversationId && c.title)
		.map(c => ({ title: c.title!, conversationId: c.openConversationId! }));
}

/**
 * Probe the full robot×group matrix.
 *
 * @param accounts accountId → app credentials (from gateway.json)
 * @param knownRobotCodes robotCode → accountId; only these robots are recorded
 */
export async function probeRobotGroups(
	accounts: Map<string, AccountCreds>,
	knownRobotCodes: Map<string, string>,
): Promise<ProbeResult> {
	const groups = await listUserGroups();
	logger.debug("[robot-probe] enumerating groups", { count: groups.length });

	// Pick the first account token that passes the permission check.
	let token: string | null = null;
	let tokenAccount: string | null = null;
	for (const [id, creds] of accounts) {
		try {
			const t = await getAccessToken(creds);
			// Permission smoke test against the first group (or a dummy call —
			// a 403 here means this app lacks qyapi_chat_manage).
			await queryGroupRobots(t, groups[0]?.conversationId ?? "cidProbePermissionCheck");
			token = t;
			tokenAccount = id;
			break;
		} catch {}
	}
	if (!token || !tokenAccount) {
		throw new Error("No gateway account has the qyapi_chat_manage permission required by /robot/groups/robots/query");
	}

	const byRobot = new Map<string, ProbeGroup[]>();
	let failures = 0;
	for (const g of groups) {
		try {
			const robots = await queryGroupRobots(token, g.conversationId);
			for (const bot of robots) {
				if (bot.robotCode && knownRobotCodes.has(bot.robotCode)) {
					const list = byRobot.get(bot.robotCode) ?? [];
					list.push(g);
					byRobot.set(bot.robotCode, list);
				}
			}
		} catch (err) {
			failures++;
			logger.debug("[robot-probe] group query failed", { group: g.title, error: String(err).slice(0, 120) });
		}
	}
	return { byRobot, scanned: groups.length, failures, tokenAccount };
}

/**
 * Upsert probe results into the sessions table so each robot's robot-context.md
 * picks the groups up, then refresh the affected accounts.
 */
export async function ingestProbeResult(
	store: SQLiteSessionStore,
	writer: RobotContextWriter,
	result: ProbeResult,
	robotCodeToAccount: Map<string, string>,
	channelId = "dingtalk",
): Promise<Map<string, number>> {
	const written = new Map<string, number>();
	for (const [robotCode, groups] of result.byRobot) {
		const accountId = robotCodeToAccount.get(robotCode);
		if (!accountId) continue;
		const existing = await store.getActiveSessions();
		const known = new Map(existing.filter(s => s.accountId === accountId).map(s => [s.conversationId, s]));
		let count = 0;
		for (const g of groups) {
			const prior = known.get(g.conversationId);
			if (prior) {
				if (prior.conversationTitle !== g.title || !prior.isGroup) {
					await store.updateSession(prior.id, { conversationTitle: g.title, isGroup: true });
					count++;
				}
				continue;
			}
			const now = Date.now();
			await store.createSession({
				channelId,
				accountId,
				userId: "probe",
				conversationId: g.conversationId,
				conversationTitle: g.title,
				isGroup: true,
				createdAt: now,
				updatedAt: now,
				status: "active",
			});
			count++;
		}
		if (count > 0) {
			written.set(accountId, count);
			await writer.refresh(accountId);
		}
	}
	return written;
}

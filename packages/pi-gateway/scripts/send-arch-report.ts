/**
 * One-shot script: upload the architecture review HTML and send it to a user
 * via DingTalk's oToMessages/batchSend endpoint.
 *
 * Usage:
 *   bun scripts/send-arch-report.ts <staffId> <htmlPath>
 */
import * as path from "node:path";
import { uploadMedia } from "../src/channels/dingtalk-media";

const HR_ACCOUNT = {
	appKey: "ding8yvoithqnrrz0kz5",
	appSecret: "a7adW_1JDA8XLN9-KG0XRTD0TAZh5o3APv0b5lvZ6ooMcu9z4ogkrjvFhs7yTQ4f",
	robotCode: "ding8yvoithqnrrz0kz5",
};

async function getRobotToken(): Promise<string> {
	const resp = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			appKey: HR_ACCOUNT.appKey,
			appSecret: HR_ACCOUNT.appSecret,
		}),
	});
	if (!resp.ok) throw new Error(`token: ${resp.status} ${await resp.text()}`);
	const data = (await resp.json()) as { accessToken?: string; errcode?: number; errmsg?: string };
	if (!data.accessToken) throw new Error(`token rejected: ${data.errcode} ${data.errmsg}`);
	return data.accessToken;
}

async function sendFileMessage(
	robotCode: string,
	token: string,
	staffId: string,
	mediaId: string,
	fileName: string,
): Promise<void> {
	const msgParam = JSON.stringify({
		mediaId,
		fileName,
		fileType: path.extname(fileName).slice(1) || "html",
	});

	const body = {
		robotCode,
		userIds: [staffId],
		msgKey: "sampleFile",
		msgParam,
	};

	const resp = await fetch("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-acs-dingtalk-access-token": token,
		},
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		throw new Error(`send failed: ${resp.status} ${await resp.text()}`);
	}
	const data = (await resp.json()) as { errcode?: number; errmsg?: string };
	if (data.errcode !== undefined && data.errcode !== 0) {
		throw new Error(`send rejected: ${data.errcode} ${data.errmsg}`);
	}
}

async function main(): Promise<void> {
	const staffId = process.argv[2];
	const htmlPath = process.argv[3];
	if (!staffId || !htmlPath) {
		console.error("usage: send-arch-report.ts <staffId> <htmlPath>");
		process.exit(1);
	}

	console.log("uploading html...");
	const upload = await uploadMedia(htmlPath, "file", HR_ACCOUNT);
	if (!upload) throw new Error("upload returned null");
	console.log("uploaded:", upload.mediaId);

	console.log("acquiring robot token...");
	const robotToken = await getRobotToken();

	console.log("sending to", staffId);
	const fileName = path.basename(htmlPath);
	await sendFileMessage(HR_ACCOUNT.robotCode, robotToken, staffId, upload.mediaId, fileName);
	console.log("done");
}

main().catch(err => {
	console.error("failed:", err);
	process.exit(1);
});

/**
 * Sample DingTalk message fixtures for testing.
 */

import type { DingTalkRawMessage } from "../../src/types";

export function sampleTextMessage(overrides?: Partial<DingTalkRawMessage>): DingTalkRawMessage {
	return {
		conversationId: "cid001",
		atUsers: [],
		chatbotCorpId: "corp001",
		chatbotUserId: "bot001",
		msgId: "msg001",
		senderNick: "测试用户",
		isAdmin: false,
		senderStaffId: "staff001",
		sessionWebhookExpiredTime: Date.now() + 3600_000,
		createAt: Date.now(),
		senderCorpId: "corp001",
		conversationType: "1",
		senderId: "staff001",
		conversationTitle: "测试会话",
		isInAtList: false,
		sessionWebhook: "https://example.com/webhook/abc",
		text: { content: "你好，请介绍一下自己" },
		msgtype: "text",
		robotCode: "robot001",
		...overrides,
	};
}

export function sampleGroupMessage(overrides?: Partial<DingTalkRawMessage>): DingTalkRawMessage {
	return sampleTextMessage({
		conversationType: "2",
		conversationTitle: "测试群聊",
		isInAtList: true,
		...overrides,
	});
}

export function sampleImageMessage(overrides?: Partial<DingTalkRawMessage>): DingTalkRawMessage {
	return sampleTextMessage({
		msgtype: "picture",
		content: JSON.stringify({ downloadCode: "dcode001", pictureUrl: "https://example.com/img.jpg" }),
		text: undefined,
		...overrides,
	});
}

export function sampleVoiceMessage(overrides?: Partial<DingTalkRawMessage>): DingTalkRawMessage {
	return sampleTextMessage({
		msgtype: "audio",
		content: JSON.stringify({
			downloadCode: "dcode002",
			recognition: "你好这是一条语音消息",
			duration: 3000,
		}),
		text: undefined,
		...overrides,
	});
}

export function sampleFileMessage(overrides?: Partial<DingTalkRawMessage>): DingTalkRawMessage {
	return sampleTextMessage({
		msgtype: "file",
		content: JSON.stringify({ downloadCode: "dcode003", fileName: "report.pdf", size: 1024 }),
		text: undefined,
		...overrides,
	});
}

export function sampleDuplicateMessage(): DingTalkRawMessage {
	return sampleTextMessage({ msgId: "msg001" });
}

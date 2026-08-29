import type { PiClient } from "../lib/pi-client-api";
import { PiClientAdapter } from "./pi-client-adapter";

/**
 * 客户端工厂 —— 真实 pi-client 入口（P3 已接入 @cornfield/client）。
 * 连接配置（wsUrl/token）来自 localStorage（设置页可改），默认 ws://127.0.0.1:7891/ws。
 */
export function createClient(): PiClient {
	return new PiClientAdapter();
}

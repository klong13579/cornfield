import type { PiClient } from "../lib/pi-client-api";
import { MockPiClient } from "./mock/mock-client";

/**
 * 客户端工厂 —— pi-client 替换点（唯一一处感知 mock/真实差异的模块）。
 *
 * TODO(@be-dev): 当 `@oh-my-pi/pi-client` 发布后，改为：
 *   import { createPiClient } from "@oh-my-pi/pi-client";
 *   return createPiClient({ wsUrl, token });
 * 并删除 `state/mock/` 目录。接口契约见 `lib/pi-client-api.ts`。
 */
export function createClient(): PiClient {
	return new MockPiClient();
}

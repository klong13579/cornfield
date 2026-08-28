/**
 * @cornfield/client — WebSocket client for `omp serve` (pi-wire protocol).
 *
 * 职责边界：
 *  - 不包含任何业务命令包装（UI 自己拼 `client.request({type: "prompt", message})`）
 *  - 不包含开发环境可见的日志（默认静默，需要日志就 subscribe 自己打印）
 *  - 不包含 heartbeat（服务器层 keepalive/close——WS 本身的 ping/pong）
 */
export * from "./client";
export * from "./errors";

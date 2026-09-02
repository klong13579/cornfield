/**
 * 结果形状（按领域分文件）—— serve 端命令返回的权威类型。
 * wire-server 产出、前端（web-app/desktop/pi-client）消费，双方直接 import 本包。
 */
export * from "./agents";
export * from "./artifacts";
export * from "./config-scope";
export * from "./cron";
export * from "./diagnosis";
export * from "./events";
export * from "./memory";
export * from "./models";
export * from "./providers";
export * from "./session";
export * from "./skills";
export * from "./stats";

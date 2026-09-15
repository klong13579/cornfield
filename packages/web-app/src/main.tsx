import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import "./index.css";
import { NotificationCronWatcher } from "./notifications/CronWatcher";
import { router } from "./router";
import { createClient } from "./state/client";
import { getFileWorkflow } from "./state/file-workflow-store";
import { useSessionStore } from "./state/session-store";

// 会话权威 store 初始化：接真 pi-client（PiClientAdapter，见 state/client.ts）。
const store = useSessionStore();
const client = createClient();
store.init(client);
// 文件工作流（编辑/上下文项/Diff）接同一条客户端与会话身份：归属与作废都挂在会话 store 上。
getFileWorkflow().init({ client, sessions: store });
void store.connect();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<RouterProvider router={router} />
		{/* B7-1：定时任务通知后台观察者（cron 开关开 + 页面隐藏时轮询 B6 日志） */}
		<NotificationCronWatcher />
	</StrictMode>,
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import "./index.css";
import { NotificationCronWatcher } from "./notifications/CronWatcher";
import { router } from "./router";
import { createClient } from "./state/client";
import { useSessionStore } from "./state/session-store";

// 会话权威 store 初始化：接真 pi-client（PiClientAdapter，见 state/client.ts）。
const store = useSessionStore();
store.init(createClient());
void store.connect();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<RouterProvider router={router} />
		{/* B7-1：定时任务通知后台观察者（cron 开关开 + 页面隐藏时轮询 B6 日志） */}
		<NotificationCronWatcher />
	</StrictMode>,
);

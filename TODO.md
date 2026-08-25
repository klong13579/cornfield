# TODO

> Current task state. The agent updates this file as work progresses; an empty TODO is a valid state.

## 待办
- [ ] 去 omp 化：oh-my-pi → mika 改名（P0→P4 分阶段执行） → topics/de-omp-mika-rename.md
- [ ] 统一协议层：TUI/web/桌面/IM 四前端收敛到一套 Wire（P0→P3 分阶段） → topics/unified-protocol-layer.md
- [ ] toolResult 轮次窗口化 + 配置（默认关闭） → topics/tool-output-cleanup.md
- [ ] 窗口化 A/B canary 验证后开默认 → topics/tool-output-cleanup.md
- [ ] 学习使用herdr-board 功能
- [ ] 钉钉机器人帮助我读取群消息和文档链接，帮我自动提取，并且识别重要的事项，是的话记录待办并提醒我。 → topics/dingtalk-extract-important-todos.md
- [ ] omp 添加前端框架
- [ ] omp2omp 通信机制
- [ ] session 诊断优化：诊断结果 → learning/nudge/regression 三阶段落地 → topics/session-diagnosis-loop.md
- [ ] omp 本地增加定时器功能
- [ ] 独立验证者：执行与验证分离，数字员工结果由独立进程验收 → topics/independent-verifier.md
- [ ] OMP 桌面客户端：主 app（Tauri）+ 编辑器（fork Zed）→ topics/omp-client-design.md

## 已完成

- [x] 仓库瘦身：A+B 类全部清理（含需要确认的 6 项） → topics/repo-slimming.md
- [x] read 大文件输出旁路（artifact://） → topics/tool-output-cleanup.md
- [x] search/grep/find 输出旁路（artifact://） → topics/tool-output-cleanup.md
- [x] 工具旁路 footer 格式统一 → topics/tool-output-cleanup.md
- [x] 测试一下新的语音交互功能
- [x] 测试 todo-write 参数序列化修复
- [x] gbrain 接入 agent 共享记忆（dws-persona 决策日志入库） → topics/gbrain-agent-memory.md
- [x] 我的 context engineer：数据驱动用户画像供 agent 了解我（me-context skill） → topics/dws-mycontext-prototype.md
- [x] MOA功能，参考 pi-fusion
- [x] cron-agent-subprocess-execution
- [x] omp 开发听记功能，利用 whisper
- [x] 定时任务输出结果使用 AI card
- [x] 增加 whisper 语音转文字功能
- [x] voice live 实时语音对话（Jarvis）：realtime 传输/状态机/consult 委托/TUI 面板/防自循环与慢任务交接

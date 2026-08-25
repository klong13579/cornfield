# 05: 壳骨架（editor-extension 包 + OpenSumi 组装 + web-app 风格主题 + omp agent 注册）

**What to build:** 新建壳集成层包：OpenSumi 3.9.1-next 组装（renderApp + 默认布局 + 自定义视图容器）、web-app 风格自定义主题（color-token JSON 对齐 web-app 设计体系，D15）、omp agent 正规注册（ai.native.agent.defaultType + ai-native.acp.agents 偏好，非 spike 的 provider patch）、workspace 传递（?workspaceDir= / WORKSPACE_DIR 对齐）、集成环境要点（monaco worker 本地化 / 短 TMPDIR / 版本锁快照）。

**内部两段交付（优先保障可演示节点，本票是 6 张后续票的共同前置）：**
- **5a（先）壳起 + 对话**：包能起、打开项目、IDE 里与 omp agent 真实对话（流式回复渲染，spike 已验证路径，含真实模型）——此节点即可验收
- **5b（后）主题 + 环境细节**：web-app 风格主题（D15）、agent 注册正规偏好化、monaco worker 本地化、短 TMPDIR、版本锁——不阻塞对话演示，逐项落地

**Blocked by:** None（可立即开工）

**Status:** ready-for-agent

**File scope:** 新建 packages/editor-extension（全部）；spike 探针环境 ~/Desktop/Narwal/omp-opensumi-spike/ide-startup（基准模板，含全部 patch 记录，可复现）。

- [ ] 壳启动打开项目；IDE 里与 omp agent 完成一次真实对话（流式回复渲染）
- [ ] 壳 UI 呈现 web-app 风格主题（非 OpenSumi 默认外观）
- [ ] agent 注册走正规偏好配置（非 patch）；spike 三个绕弯（默认 agent/workspace/短 TMPDIR）全部用正规方式落地
- [ ] monaco worker 本地加载（无 CDN 404）

---
*来源：v3-architecture 阶段 B1 + 集成点清单 #1-5；D15*

# 01: wire fs 写命令面（fs_write / fs_edit / fs_diff）

**What to build:** 让任何前端（IDE / web / 未来表面）能通过 wire 协议对文件做写/精确编辑/看差异——保存后 LSP 格式化与诊断状态不丢（LSP writethrough 续接）。命令：`fs_write`（整段写，含路径越界校验与 agentDir sandbox 一致）、`fs_edit`（透传既有 edit 工具的多模 schema：replace/patch/hashline/atom，自带 LSP writethrough）、`fs_diff`（前后内容统一 diff 输出，供前端 diff 视图）。

**Blocked by:** None（可立即开工）

**Status:** ready-for-agent

**File scope:** packages/pi-wire（命令 schema）、packages/coding-agent（serve 端分发 + 实现，复用既有 read/write/edit 工具路径与 LSP writethrough）、对应 wire-server 集成测试。

- [ ] `bun test` 新增/相关用例全绿（wire-server 集成测试覆盖三命令往返）
- [ ] PiClientAdapter（或等价客户端）能调通三命令并拿到正确结果
- [ ] fs_write 后 LSP 状态不丢（格式化/诊断不重置）
- [ ] 路径越界校验与现有 read 侧 sandbox 行为一致

---
*来源：v3-architecture 阶段 0；spec Implementation Decision #3；依赖文档：docs/editor-extension/topics/*（v2/v3/spec/spike）*

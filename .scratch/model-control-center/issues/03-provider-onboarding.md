# 03: 通过 Web 完成 Provider 接入

**What to build:** 用户不离开模型控制中心即可接入和维护模型 Provider。系统根据 Provider 能力提供 OAuth、API Key、自定义 Base URL 或本地端点配置，并清楚展示凭据来源和连接状态。敏感凭据只能写入权威凭据存储，不能回显或落入普通配置。

**Blocked by:** 01: 建立模型控制中心信息架构

**Status:** ready-for-agent

- [ ] Provider 工作区展示全部支持的 Provider 及其连接方式和当前状态
- [ ] 支持现有 Provider 的 OAuth 登录和重新认证流程
- [ ] 支持安全录入、替换和删除 API Key，保存后只展示掩码
- [ ] 支持需要 Base URL 的自定义或兼容 Provider 接入
- [ ] 支持本地模型端点配置，并区分离线与凭据错误
- [ ] 环境变量凭据只读展示变量名和检测状态，不允许从 Web 覆写
- [ ] API Key、OAuth token 等敏感信息不通过普通配置 DTO 返回，不写入普通配置文件或日志
- [ ] 连接、更新凭据和重新认证失败均返回可诊断错误
- [ ] OAuth、API Key、环境变量和本地端点路径具有针对性测试

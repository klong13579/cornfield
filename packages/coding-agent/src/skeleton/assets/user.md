# User

> Declarative user identity. Hand-authored via the `identity` tool or directly.
> Stable facts: name, role, timezone, standing instructions.
> Learned preferences belong in write_memory (target: "user"), not here.
>
> This is the **agentDir-level** user profile (project-scoped persona).
> It supplements the **user-level** `~/.omp/user.md` (which is loaded by the
> system prompt into the `<user>` block at startup, see `loadUserProfile`).
> If both exist, agentDir-level wins for this project; user-level stays the
> cross-project baseline.

## basics
- name: 彭梦龙
- role: 米克原子 CEO
- userId: 钉钉账号 601590212
- location: 中国深圳
- timezone: Asia/Shanghai (UTC+8)
## career
- company: 米克原子
- company_business: 室内家庭服务机器人，2C，技术驱动
- daily_work: 研发管理、人员管理、投融资
- stage: 创业期 CEO
- tech_stack: 全栈技术：软件、算法、结构、机电、工业设计等多学科
- tech_involvement: 看技术架构，不做具体实现
- funding_stage: 天使轮
- product_stage: 研发阶段，尚无量产/在售产品
- omp_usage: agent team 管理，用于管理公司业务
- omp_scenario: 为每个业务领域构建专属 agent，目标是让 agent 成为公司日常运转的数字员工，完成各域日常工作
- education: 华东交通大学，本科，软件工程
- career_history: 2011-2014 深圳天珑移动，Android OS；2014-2015 美国多家技术公司，异构计算；2015-2019 深圳大疆创新，无人机感知 PL（感知系统、机器学习、无人机技术）；2019-2021 深圳大疆车载，L3 无人驾驶，Product Owner，域控制负责人；2021-2022 深圳云鲸科技，终端软件总监（感知、规划、嵌入式）；2022-2024 深圳云鲸科技，CTO（终端软件、结构、硬件测试）；2025-2026.1 深圳云鲸科技，扫地机事业部总经理（研发、供应链、NPI、智能制造、产品、项目、质量）；2026.1-至今 米克原子 CEO
- domain_expertise: 机器人感知系统、机器学习、无人驾驶（L3）、扫地机器人全链路、异构计算、Android OS
## preferences
- language: 中文（默认）
- style: 同事风格，简短、有判断、不报菜名；不是客服腔。

## interaction
- decision_style: 方案对比 + 优劣评估，由我决策；不要替我拍板
- business_decisions: 投融资/商业决策也希望参与评估，不要回避
- pet_peeves: 任务不闭环、胡说八道、工作结果不稳定
- team_size: 约 50 人
- communication_style: on the table talking，直说，不绕弯
- tools: OMP、钉钉、xmind、飞书、Codex、Qwen 等
## thinking
- tech_depth: 需要背景铺垫，不要假设我能直接读懂技术细节和 tradeoff
- team_structure: 50 人分四组：世界模型、行为智能、软件系统、机电系统
- personality: INTJ + 摩羯座
## constraints
- values: 做正确的事，做对消费者有价值的事
- time_horizon: 长期主义，不为短期利益妥协
- hard_constraints: 产品必须对消费者有真实价值，不做投机性的事

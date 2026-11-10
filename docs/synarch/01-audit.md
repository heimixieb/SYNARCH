# SYNARCH 源码审计报告

审计对象：OpenMausBot v0.1.151（官方仓库 `milind-soni/OpenMausBot`，2026-11-09 发布，Apache 2.0）
审计日期：2026-11-10
对照蓝图：DeepSeek 官方 Super-agent 原型 `deepseek-ai/dsh-superagent-prototype`（MIT，研究代码）

## 一句话结论

OpenMausBot 已经实现了 Super-agent 所需能力的大约七成：总管、委派、换模型复查、目标模式、定时和事件触发、额度用完自动换引擎都有，而且做得很细。
**我们不需要重写，只需要补齐四块缺口：中文记忆、凭证合规、独立验收、全局任务看板，最后再加上“先观察后自动”的主动工作机制。**

---

## 一、已经有的能力（全部在源码中确认过）

| 能力 | 现状 | 代码位置 |
|---|---|---|
| 总管 Chief of Staff | 能派活（coordinate_bots）、等结果、汇总，能自己新建专家 Bot（create_bot），能搭建整个团队（propose_team_setup），队员失败时能重试（retry_thread），能接收需要人处理的问题（escalations） | `server/chief-of-staff.ts` |
| 一个总管管多个部门 | 已有“也负责这些部门”设置（managedSections），但还没有凌驾于所有部门总管之上的“全局总管” | `server/chief-of-staff.ts`、Issue #597 |
| Bot 之间委派 | delegate_bot / ask_bot，结果自动回到原对话，对方忙时自动排队重试 3 次 | `server/drivers/team-tools.ts` 等 |
| 换一个模型复查 | Bot 用 list_models 查可用模型，用 start_thread 在另一个模型上开线程，结果回传（PR #3920 已合并） | `server/drivers/agents-*.ts` |
| 目标模式 `/goal` | 群聊和单聊都能用；对方忙时会等，不会直接失败；有轮数上限、卡住检测 | `server/group-goal-run.ts`、`docs/plans/2026-09-02-goal-mode-v2.md` |
| 定时 / 网页回调 / 应用事件触发 | 定时任务、Webhook、Gmail/Slack/GitHub 等事件触发 Bot 干活 | `server/routines.ts`、`server/app-triggers.ts` |
| 额度用完自动换引擎 | 某个订阅额度用完，自动换到备用引擎，额度恢复后换回；**明确禁止轮换同一家的多个账号**（违反服务条款） | `server/limit-failover.ts`、`server/quota-switch.ts` |
| 快速分派模型 | 群聊里没点名时，用一个便宜的小模型几百毫秒内决定谁来回答 | `docs/decision-model.md` |
| 审批 | 执行命令、改文件、发消息前弹卡片，可选“先问我”或“全自动” | 权限中介 broker |
| 收件箱 | 所有“需要你回答 / 仅供参考 / 已完成”集中在一处 | `apps/docs/.../chat-and-teams.mdx` |
| 长期记忆 | 每个 Bot 有可见、可编辑的记忆，自动整理 | `server/memory-*.ts` |
| 可接入的模型 | Claude、Codex、Grok 官方命令行；DeepSeek、OpenRouter 等通过兼容接口或 OpenCode 接入 | `server/drivers/` |
| 外部控制 | 自带 MCP 服务和命令行，可以用脚本驱动整个团队 | `docs/mcp-server.md`、`docs/headless-cli.md` |
| 开发验证工具 | 一条命令启动隔离测试环境（临时数据目录 + 假 AI 引擎），不会碰真实数据 | `docs/verification/README.md` |

## 二、缺口（按优先级）

### 缺口 1：中文记忆搜不到 —— 对你影响最大（已确认）

- 问题：数据库全文搜索用的分词方式（unicode61）不认识中文词，一整句中文被当成一个“词”。所以换个说法问就搜不到。上游 Issue #5161 的测试：20 次中文提问，命中 0 次。
- 位置：`server/message-db.ts:124`、`server/message-db-memory-index.ts:14`
- 影响：总管记不住以前的决定和你的偏好，长期管理任务就无从谈起。

### 缺口 2：Claude 订阅凭证被程序直接读取（已确认）

- 问题：为了显示 Claude 的 5 小时 / 每周额度，程序直接读取 Claude Code 的登录凭证，自己去调 Anthropic 的接口。这可能违反 Anthropic 对订阅凭证的使用规定。没有开关能关掉。
- 位置：`server/plan-usage.ts:124`、`server/plan-usage.ts:787`；上游 Issue #5079
- 影响：有封号风险。关掉后代价是看不到 Claude 的额度条，额度用完后要等真正被拒绝才会切换引擎。

### 缺口 3：没有“独立验收”（已确认）

- 问题：目标模式完成时，是干活的 Bot 自己说“做完了”。DeepSeek 和 Grok Build 的做法是：完成前由另一个模型（最好不同厂家）独立检查，不通过就打回。
- 现状：上游计划文档第 5 节写了设计，标为“以后再做”，代码里没有。

### 缺口 4：没有全局任务看板（已确认）

- 问题：总管派出去的活分散在各个 Bot 的线程里，没有一个地方能一眼看到“所有正在进行的工作各卡在哪一步”。
- DeepSeek 的做法：每个工作是一张“工单”，只有几种状态：等你回答 / 等你验收 / 受阻 / 失败 / 排队中 / 工作中 / 空闲。看板只显示需要人处理的。

### 缺口 5：主动工作缺少“先观察后自动”（已确认）

- 问题：现在的触发器一旦满足条件就直接让 Bot 动手。DeepSeek 的做法是三档：关闭 / 观察（只记录“我本来会做什么”，不动手）/ 自动。你看了观察记录觉得靠谱，再放开自动。
- 这是 Super-agent“主动性”最关键的安全阀。

### 缺口 6：按难度和成本自动选模型（部分有）

- 有：额度用完自动换引擎、群聊快速分派。
- 缺：“简单活给便宜模型、难活给强模型、关键成果换一家模型复查”这种日常策略。现在只能靠总管的提示词自己判断。
- 可参考：HiRoute（`higress-group/HiRoute`，425 星，今天还在更新），专门做这件事。

## 三、对照 DeepSeek Super-agent 四个特点

| DeepSeek 要求 | OpenMausBot 现状 | 差距 |
|---|---|---|
| 连续性：不用记任务在哪个窗口 | 线程、收件箱、目标卡片都有 | 缺全局看板（缺口 4）、中文记忆（缺口 1） |
| 并行性：多个执行者同时干活 | 每个 Bot 最多 3 个线程并行，委派不阻塞总管 | 基本满足 |
| 主动性：发现事件自己处理 | 定时、Webhook、应用事件都有 | 缺“先观察后自动”（缺口 5） |
| 持久性：长期在线、出错能恢复 | 有重启恢复、自动重试、失败报告给总管 | 基本满足；缺独立验收（缺口 3） |

## 四、核实过的外部信息

| 项目 / 编号 | 状态 |
|---|---|
| Issue #597 全局总管 | 开放中，作者是项目创始人本人，尚未实现 |
| PR #5058 总管操作员 | 开放中，未合并 |
| PR #3920 换模型开线程 | 已合并，可用 |
| PR #5177 个人 Bot 向团队 Bot 委派 | 开放中，创始人提交 |
| Issue #5079 Claude 凭证 | 开放中，无修复 |
| Issue #5161 中文记忆 | 开放中，无修复 |
| DeepSeek 官方原型 | 真实存在，仓库名 `dsh-superagent-prototype`（不是 ChatGPT 说的 super-agent） |
| dsh-super-agent（vicfei） | 真实，18 星，今天有更新 |
| OpenGoat | 真实，428 星，4 月后无更新 |
| Orchestrator（ryderderder） | 真实，12 星，8 月后无更新 |

## 五、你电脑上的情况

- 已装：Git、Node 24、Python、GitHub 命令行（已登录）、pnpm 10.33.0（这次装的）
- 命令行里没有 `claude`、`codex`、`grok`：开发版 OpenMausBot 需要至少一个才能真正对话（测试环境自带假引擎，不需要）
- 你已经装过 OpenMausBot 正式版，数据在 `~/.openmausbot`。**开发时一律使用临时数据目录，不碰这份数据。**

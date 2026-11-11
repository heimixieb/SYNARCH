# SYNARCH

**一个人，很多模型，一个总管。**

SYNARCH 是 [OpenMausBot](https://github.com/milind-soni/OpenMausBot) 的一个**非官方分支**，按 DeepSeek Harness 团队《Super-agent 设计探索：迈向更自主的 Agent 系统》的思路改造：你只和“总管”说话，总管自己不动手，而是把每件活交给最擅长它的模型（Claude、Codex、DeepSeek……），检查结果后再交给你。

> **研究性质，还没做完。** 目前只在 Windows 上、用真实的 DeepSeek 模型实测过主流程；很多功能只跑过自动测试。欢迎试用和提意见，但请不要直接用在重要工作上。
>
> 本项目与 DeepSeek、OpenMausBot 官方均无关联。

[English](#english) · [设计对照](#和-deepseek-设计的对照) · [运行](#运行) · [文档](docs/synarch/) · [原 OpenMausBot 说明](README.openmausbot.md)

## 它能做什么

- **只和总管说话**：总管的对话默认就是“派活”模式；只想问一句时点一下切回普通聊天。
- **总管不动手**：在你和总管的对话里，写文件、改文件、跑命令都会被程序拒绝，总管只能把活交出去（对应 DeepSeek 设计里“Router 不带 shell”）。
- **按擅长派活**：给每个模型写下它擅长什么（设置页或直接告诉总管），总管再结合每个模型最近 30 天的成绩单（做了多少、失败多少、多快、多贵，按活的类型细分）来挑模型。
- **分阶段接力**：一件活有好几个阶段（查资料、起草、写代码、复查……）时，拆开交给不同模型，前一步的结果交给下一步。
- **默认干活模型**：总管没指定模型时用你选的便宜模型，小模型也能用上。
- **原话转交、追问续派**：每个派出去的活都附上你的原话；“改一下刚才那个”会交回原来的工作对话。
- **独立验收**：活做完后换一个模型（优先别家厂商）检查，不通过就打回，可在设置里关掉。
- **少打扰**：总管只在结果出来、需要你决定、做不下去时找你，一次只问一个问题。
- **看门狗**：可选。目标干活时另找一个模型看有没有卡住或跑偏；没事不说话，先提醒一次，还不行再找你。
- **中文记忆搜索**：修好了原版用中文搜不到过去笔记的问题。

## 和 DeepSeek 设计的对照

| DeepSeek 的设计 | SYNARCH |
|---|---|
| Router / Worker 双层，Worker 结果交回 Router | 已做：总管 + 工作对话，结果自动交回总管 |
| Router 不带 shell | 已做：程序级拒绝，DeepSeek 引擎另起只读进程 |
| 原样转交请求，不替 Worker 做计划 | 已做：自动附原话 |
| 后续消息直通对应 Worker（订阅） | 部分：总管可续派到原工作对话；你也可以直接在工作对话里说 |
| 少打扰、一次一个问题、如实报告 | 已做（靠规则，没有程序强制） |
| 按角色设置模型 | 已做：默认干活模型 |
| Watchdog 判断 Worker 是否跑偏 | 已做：默认关；打开后另找模型看目标是否卡住/跑偏，先提醒一次再找你；官方超时检测照常 |
| 异步长任务 | 已做（DeepSeek worker）：长命令约 5 秒升后台，做完叫醒同一轮；总管仍 hands-off；官方超时/卡住检测照常。只跑过单元测试 |
| 事件驱动、主动处理、先观察后自动 | 不做：面向团队和无人值守场景，一个人直接派活用不上 |
| 计算、状态与环境分离（BYOM） | 没做 |

DeepSeek 没有设计的部分（多模型挑选、模型标签和成绩单、换厂商验收）是 SYNARCH 自己加的，参考了 Grok Build 的目标验收器和 HiRoute 的分级路由思路。

## 运行

需要 Node 24+ 和 pnpm，以及至少一个已登录的引擎命令行（`claude`、`codex` 或 DeepSeek Harness 的 `dsh`）。

```sh
pnpm install
pnpm dev:server   # 服务器 → 127.0.0.1:8799
pnpm dev          # 网页 → http://127.0.0.1:5199
```

用真实 DeepSeek 在隔离的临时环境里试：把 `DEEPSEEK_API_KEY=...` 写进 `%USERPROFILE%\.synarch\deepseek.env`，然后运行 `node --experimental-strip-types scripts/synarch/launch-deepseek.ts`（用完删掉它打印的临时数据目录，里面有一份密钥副本）。

## 文档

- [docs/synarch/01-audit.md](docs/synarch/01-audit.md)：对原版的源码审计
- [docs/synarch/02-roadmap.md](docs/synarch/02-roadmap.md)：做了什么、怎么验证的、还差什么（最准确的进度）
- [docs/synarch/00-new-computer.md](docs/synarch/00-new-computer.md)：在新电脑上搭开发环境

## 致谢与许可

- 基于 [OpenMausBot](https://github.com/milind-soni/OpenMausBot)（Apache-2.0）v0.1.151。原项目的说明在 [README.openmausbot.md](README.openmausbot.md)。
- 设计思路来自 DeepSeek Harness 团队的文章和原型 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT）；没有复制其代码。
- 许可证沿用 Apache-2.0，见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。相对原版的改动见提交历史。

---

## English

**One person, many models, one chief.**

SYNARCH is an **unofficial fork** of [OpenMausBot](https://github.com/milind-soni/OpenMausBot) reshaped after the DeepSeek Harness team's *Exploring Super-agent Design*. You talk only to the Chief. In your conversations it cannot run commands or change files. It hands each job to the model best at it, picking by tags you write and by each model's recent record per kind of work. It splits staged work across models, forwards your own words with every job, and sends follow-ups to the job that did the work. Another vendor's model checks the result before it counts as done. An optional watchdog (off by default) can judge whether in-progress goal work is stuck or off track. You are interrupted only for results, decisions and stops.

**Research prototype, unfinished.** The main flow is tested end to end only on Windows with DeepSeek models. See the table above for what is done and what is not, and [docs/synarch/02-roadmap.md](docs/synarch/02-roadmap.md) (Chinese) for details. Not affiliated with DeepSeek or OpenMausBot. Licensed under Apache-2.0, like the project it builds on.

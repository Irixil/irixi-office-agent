# iRIXI Personal Agent

### 在一间有生命感的维多利亚办公室里，和你的个人 AI Agent 一起推进项目。

说清目标，让团队规划和开发，查看独立审阅，确认具体成果，下次回来继续。

**[English](README.md) · [开始体验](docs/getting-started.md) · [项目实例](docs/showcase.md) · [当前进度](STAGE_STATUS.md) · [参与贡献](CONTRIBUTING.md)**

iRIXI 是一个正在开发的可视化个人 AI 助手。猫头鹰协调工作，动物同事呈现各自的项目职能和任务状态。当前原生 Harness 使用 OmO，通过原生 RPC 工具循环和受限 Provider 桥接调用已安装的 Desktop Codex CLI。

![iRIXI 个人 AI 办公室，猫头鹰协调员与动物同事](docs/media/irixi-office.gif)

*运行界面的待机与休息动画实录，地图还有可以走上去的楼上画廊。当前为早期预览版。*

## 用它做什么

| 你想解决的问题 | iRIXI 当前的做法 |
| --- | --- |
| 几天后回来，还得重新交代项目 | 将目标、材料、接受的要求、历史成果和下一步放在同一个项目里。 |
| 不清楚 Agent 正在做什么 | 在办公室与任务页面查看原生团队、真实状态、成果和停止原因。 |
| 开发中途想补要求 | 保存修改，把当前要求带入后继规划与执行。 |
| 担心生成结果没有经过检查 | 分开显示候选、宿主检查、独立审阅和指定版本确认。 |
| 想拿到可以检查和保存的成果 | 确认具体版本后下载对应 patch；部分示例支持报告、清单等下载。 |

前台同事分别承接学习、小工具、小游戏、Agent 开发和档案记忆。它们共用任务后台；实际开发中的 Lead、Developer 和 Reviewer 是原生执行角色。

## 历史示例：文章学习链路

这条文章学习链路使用的是较早的 OpenOffice 路线，不代表当前 OmO 流程的验收结果。当时在已有项目里提出“下载完整报告”，Lead 规划后补充“另下载仅含薄弱或未检验项的待复习清单”。原生团队经过开发、独立审阅与修正，明确确认后实际下载两份 Markdown，并核对历史切换、会话恢复和刷新续接。

这条链路在本地、有人监督的环境中完成验证。项目还在持续开发，当前支持范围见 [项目进度](STAGE_STATUS.md)。

## 先体验办公室

需要 Node.js 24+、npm 和桌面浏览器，当前主要在 macOS 开发验证。

```bash
git clone https://github.com/Irixil/irixi-office-agent.git
cd irixi-office-agent
npm ci
npm run start:legacy
```

打开 [localhost:3847](http://127.0.0.1:3847)，保持演示提供者，用虚构材料建立任务。这个入口适合了解办公室和任务界面，使用的是历史桌面后台。

当前 OmO 入口使用 `npm start`，在 `127.0.0.1:3848` 启动；`npm run start:legacy` 保留旧演示后台，端口为 3847。公开源码包含 OmO 5.1.40 原生 RPC 接入和受控 Desktop Codex CLI 桥接，但不包含 OmO 安装/runtime、Codex 可执行文件、凭据、个人项目目录或本机审批。真实执行还需要本机已有这些依赖并登记可信项目范围。`npm run start:zero` 保留给早期原生设置，不是当前 OmO 入口。

**OmO 当前仍是开发预览；全新机器安装和真实执行尚未验证。** 请先看[安装与运行说明](docs/getting-started.md)。启动服务本身不会调用模型；项目执行需要用户另行操作。

## 当前重点

- 把新机器安装与项目登记流程做得可复现。
- 让项目历史与跨版本继续更顺畅。
- 通过实际项目逐步扩展文章写作和游戏流程。

欢迎反馈个人 AI 助手、多 Agent 协作、项目记忆、工作流自动化和可视化 Agent 办公室的真实使用需求。可以[报告问题](https://github.com/Irixil/irixi-office-agent/issues/new?template=bug_report.yml)、[提出场景](https://github.com/Irixil/irixi-office-agent/issues/new?template=feature_request.yml)，或通过 [Releases](https://github.com/Irixil/irixi-office-agent/releases) 关注更新。觉得方向有帮助，也欢迎点 Star 或分享仓库。

架构与来源见 [架构说明](docs/architecture/goal-first-agent.md) 和 [第三方许可](THIRD_PARTY_NOTICES.md)。iRIXI 原创代码与美术尚未指定全仓库统一许可证，上游许可按各自文件保留。

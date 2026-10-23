# iRIXI 目标优先工作架构

目标、成功条件与工作边界构成任务输入。材料用途、已接受的工作交代、项目范围和版本随同一任务保存；目标或输入改变后，旧计划和成果资格失效，历史与失败记录继续保留。

## 原生执行与界面

当前目标路线由 OmO 5.1.40 担任核心 Harness：`app/public/` 的界面状态进入 `omo-pilot/server.mjs`，服务通过 `native-rpc-runner.mjs` 启动 OmO 原生 RPC；OmO 通过受限 Provider 桥接请求既有 Desktop Codex CLI 的模型决策，再由 OmO 原生工具循环执行文件操作。桥接不替代 OmO 调度器。`omo-pilot/` 保存 iRIXI 的接入源码，不包含 OmO 安装包、运行模块、Codex 可执行文件或本机凭据。旧 OpenOffice 与 agent-office 适配仍保留在 `native/`，供历史演示和兼容检查使用。

前端与产品管理层将授权、范围、预算、审阅、确认和导出状态映射到 OmO 执行记录。原 OpenOffice integration-slice 中的 Authority、Gateway、Agent Office 和 Desktop 连接代码属于旧路线，不代表当前 OmO 运行链。

## 成果与权限

可信登记限定可读/可改文件及固定检查。执行结果需通过当前绑定、文件摘要与 CAS 守卫；候选不能继承旧版审阅或确认。代码成果以指定版本 patch 下载交付，确认不自动应用、提交、合并或发布。

本源码包排除实际任务、会话、凭据、数据库、运行授权和证据。历史精确恢复配置公开版本默认为空，相关比较和证据守卫保留。公开测试中由程序创建的 fixture 只证明各自受控检查。

## 当前验证边界

阶段状态见 [STAGE_STATUS.md](../../STAGE_STATUS.md)。已有文章学习项目的本地验证属于有人监督的选定场景。当前公开快照包含 OmO→受控 Desktop Codex CLI 的接入源码，但不含本机运行依赖与授权；新环境安装及完整业务验收仍未验证。

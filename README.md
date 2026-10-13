# iRIXI Personal Agent · 阶段源码候选

iRIXI 用目标、成功条件和明确边界组织个人项目。办公室展示同一任务的成员与执行状态；OpenOffice 提供原生分工、隔离工作区、执行及审阅，agent-office 提供办公室场景与交互。

当前阶段及未完成项见 [STAGE_STATUS.md](STAGE_STATUS.md)。R44/v15 已完成同版审阅、具体确认及 patch 下载，补丁未应用回正式业务源码。真实学习和中途筛选要求仍未完整验收，不能把这一阶段称为整个 Personal Agent 已完成。

## 本源码包

包含桌面源码、当前加载的静态美术、合成项目基线、两项目的既有适配源码和第三方许可。`native/upstream-mac-trial-20261004/sources/` 保存 OpenOffice 与 agent-office；相邻 `integration-slice-20261004/` 保存 Authority、Desktop 适配与启动入口。

原始会话、任务数据库、材料记录、调用账、运行日志、实际运行授权、候选工作树、私密执行历史、依赖和编译产物均未打包。当前副本另做了路径和历史配置整理；它与原开发环境的原始字节快照有所不同。

## 运行条件

桌面源码要求 Node.js 24 或更新版本，依赖版本按锁文件。原生链还依赖两个工作区的依赖和编译输出，以及本机已有 Codex 运行时。当前整理未执行安装、构建、服务启动或真实模型测试，跨机器运行仍待验证。

普通入口为 `npm start`；`npm run start:zero` 为禁止模型调用的开发入口，`npm run start:legacy` 为历史桌面后台。原生源码默认从随包的 `native/` 目录定位，也可用 `IRIXI_NATIVE_ROOT` 或 `--native-root` 指定已有的规范绝对路径。既有 Codex 可通过 `IRIXI_CODEX_PATH` 指定。

可信项目目录、授权文件、固定检查、源码摘要与预算必须在新环境中重新建立；源码包没有携带原用户的运行授权。示例不能被视为实际批准。新候选仍需核对当前目标、输入和范围，独立审阅并明确确认后才可下载 patch。

## 历史绑定的隐私处理

原源码中的少量精确历史恢复数据移到不上传的 `historical-bindings.local.json`；所有版本、hash、预算、CAS 与证据检查函数保留。公开的 [示例配置](native/upstream-mac-trial-20261004/integration-slice-20261004/authority/historical-bindings.example.json) 使用占位值和空历史恢复表，默认不能恢复原私人运行。配置加载器只读取同目录、规范且有界的普通文件，格式错误会拒绝。

需要迁移自己已有的历史运行时，管理员应在本机提供与其真实证据相符的私密配置和记录，并继续执行原有精确校验。不要提交本地配置、运行证据或真实模型输出。当前通用原生产品入口与这些历史回放工具的适用范围分别记录；缺少历史配置不授予新的权限。

公开回归测试保留生成的合成 fixture、匿名路径拒绝样例和路径隐藏正则。需要真实旧会话字节的单独回放用例与一次性操作脚本未进入上传范围。全部原始文件仍保存在本地冻结副本中。

实现说明见 [架构](docs/architecture/goal-first-agent.md) 与 [产品范围](docs/product/Irixi-PRD-v0.1.md)。来源、固定版本和署名见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

# 消防演练脚本排练工具

面向消防演练的**组织排练与内容呈现**工具：网页编排报警 / 疏散 / 集合 / 复盘四阶段脚本，后台 API 持久化
角色、依赖与版本；现场浏览器可下载**离线脚本包**断网播放。

> **用途边界（硬约束）**
> - 本系统**不连接、不控制任何真实消防/报警设施**，只做脚本呈现、流程组织、人工确认与复盘记录。
> - 阶段进入必须满足条件并由主持人/负责人**人工放行**；**视频 / 广播 / 时间线到点不代表人员已完成疏散**。
> - 超时只触发**预设提醒**，不自动推进、不自动替代现场负责人判断。
> - 现场已执行动作是**只追加事实**；撤销编排不会删除执行记录。
> - 新脚本只能在**已批准的切换点**（阶段放行门之前）生效。

## 运行

```bash
node -v          # 需要 Node >= 18（零第三方依赖）
npm start        # 等同 node src/server.js，默认 http://localhost:3000
npm run seed     # 需要时重置演示数据（data/db.json）
PORT=8080 npm start
```

首次启动自动写入演示数据：7 个角色、4 个资源（含 1 个**缺失的警报提示音**用于验收）、
v1 已批准脚本（四阶段、阶段条件与门控步骤）、v2 修订草稿（s9 责任人由“集合点清点员”改为“现场总指挥”、新增 s14）。

## 页面

| 页面 | 用途 |
|---|---|
| `/index.html` 控制台 | 脚本/版本总览、资源就绪登记、开排（选模式）、场次列表 |
| `/editor.html` 编排/审核 | 草稿编辑（阶段、步骤、责任人、超时阈值、资源、人工核对项、依赖、切换点）、提交、批准/驳回、修订草稿、导出 |
| `/host.html` 主持端 | 主持租约、开始/暂停/继续/结束、阶段条件查看与人工放行、提醒、版本切换、**差异页**、导出页、只追加事件日志 |
| `/field.html` 现场确认端 | 责任人按角色确认步骤、模拟断网开关、离线排队、重连同传、暂定阶段展示 |

## 两种时间推进模式

- **统一时钟（clock）**：开排后维护单一排练时钟（暂停冻结、继续累计）。时钟驱动“已到点 / 超时”**提醒**；
  仅对脚本作者显式标记为“无需确认”的步骤，时间到点才自动标记；**所有人工确认项永不自动完成**，阶段永不自动进入。
- **主持人事件（host）**：计划时间仅作参照，完全以主持人的放行/暂停/继续事件推进。

两种模式的共同点：阶段条件未满足禁止放行（服务端 412/409 强校验）；门控步骤 🚦 是需要现场核实的事实。

## 阶段、条件、暂停与人工放行

- 阶段结构：`plannedStartSec / plannedDurationSec` + `condition.requireGate` + `condition.requireConfirmedSteps[]`。
- 阶段状态：`暂定 pending →（条件满足+主持人放行）→ 进行中 active →（全部步骤有事实确认）→ 已完成 completed`。
  “completed”是事实齐备后的物化结果，**不代表自动进入下一阶段**。
- 暂停：时钟冻结；暂停期间拒绝确认与放行（离线确认只能在设备本地排队）。
- 门控步骤（gate）：现场负责人核实后确认；“放行阶段”的决定必须由在线主持人在主持端执行，离线设备只能记录门控事实。

## 主持权限（崩溃 / 争用 / 接管）

- 开排设备获得主持租约；主持端每 5 秒心跳，租约 30 秒无心跳即失效并记录 `host_expired`。
- 两人争用：第二台“申领主持”返回 `409 host_contended` 并显示当前持有者；确认前任崩溃可**强制接管**（记 `host_taken_over`）。
- 被接管设备恢复后心跳返回 `423 host_lost`，界面提示其已失去推进权限。

## 断网设备与重连

- 现场端通过 SW 缓存应用外壳；API 网络优先，失败时展示 **localStorage 中最近一次成功视图**，并明确标注“暂定、不可推进”。
- 离线期间可对本角色步骤确认：生成 `localAt` 本地时间戳进入本地队列（**不能离线放行阶段**）。
- 重连后自动上传：
  - 服务端以 `clientId|localAt|stepId` **幂等去重**（重发不产生第二条事实）；
  - 事实属于已越过阶段或排练已结束 → 标记 `late`（迟到确认仍保留为事实）；
  - 事实属于未放行阶段 → 标记 `early`（系统接收，供主持人甄别）。

## 版本与事实

- 生命周期：草稿 draft → 提交 submitted（锁定）→ 批准 approved（**不可变快照**，驳回回 draft）。
- 场次记录 `baselineVersionId`（开排版本）与当前 `versionId`；切换只允许发生在下一阶段尚未放行的批准切换点。
- `events` 为只追加日志；`step_confirmed` 内含步骤标题/责任人快照，即使新版本移除该步骤，事实仍在（差异中标“已从计划移除，执行记录保留”）。
- 含事实的场次不能作废删除，只能结束并保留全部记录。

## 差异视图（主持端页签）

- **已执行事实**：确认人、时间、角色、离线/迟到/提前标记、门控标记。
- **待确认**：按当前执行版本计算的未确认步骤（含超时/到点/暂定状态）。
- **计划修订**：以开排基线版本对比当前/选定版本，展示责任人、计划时间、内容、超时时限、确认要求的变化与增删，已执行步骤高亮提示“修订不追溯事实”。

## 离线脚本包

- `GET /api/scripts/:id/export?versionId=...` → JSON 包：版本快照、角色、阶段、**资源依赖（缺失项单列）**、
  **人工核对项清单**、免责声明。
- `...&standalone=1` → 单文件 HTML 播放器（数据内嵌、断网可开、本地计时，只显示“到点不自动放行”，不回传、不控制设施）。

## API 摘要

```
GET  /api/health /api/roles /api/resources /api/scripts /api/runs
POST /api/roles /api/resources
PUT  /api/roles/:id /api/resources/:id
POST /api/scripts                         # 新建（含草稿）
GET  /api/scripts/:id                     # 脚本+版本列表
GET  /api/scripts/:id/versions/:vid
PUT  /api/scripts/:id/versions/:vid       # 仅草稿
POST /api/scripts/:id/draft               # 基于某版本新建修订草稿
POST /api/scripts/:id/versions/:vid/{submit|approve|reject|discard}
GET  /api/scripts/:id/export[?standalone=1&versionId=...]
POST /api/runs                            # 开排 {scriptId,versionId,mode,clientId,hostName}
GET  /api/runs/:id                        # 实时视图（clock 模式 GET 会幂等推进时钟）
POST /api/runs/:id/{host|heartbeat|release-host|start|pause|resume|complete|release-phase|confirm|switch-version}
GET  /api/runs/:id/diff[?compareVersionId=...]
DELETE /api/runs/:id                      # 仅 created 且无事实可作废，否则 409
```

## 自动化验收

`/tmp/accept.mjs`（测试脚本，随仓库外执行）覆盖 37 项断言，包括：两人争用、主持崩溃接管、旧主持心跳 423、
条件未满足拒绝放行、暂停冻结、重复确认冲突、离线提前/迟到确认与幂等、未批准版本拒绝切换、阶段中拒绝切换、
切换点切换并保留事实、责任人变更差异、撤销编排不删事实、提示音缺失导出、含事实场次禁作废、已批准版本不可变。
另用 2s 短租约实例验证真实租约过期接管。

## 目录

```
src/
  server.js   HTTP 路由 / 静态文件
  engine.js   排练引擎：租约、时钟/事件、阶段条件、确认、版本切换、提醒、视图、差异
  scripts.js  脚本版本生命周期（不可变快照）
  export.js   JSON 脚本包与单文件离线播放器
  store.js    JSON 文件原子持久化
  seed.js     演示数据
public/       四个页面 + app.js 工具（离线队列）+ sw.js
data/db.json  持久化文件（运行后生成）
```

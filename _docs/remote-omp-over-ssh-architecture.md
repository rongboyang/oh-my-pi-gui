# 架构：通过 SSH 接入远端 omp 实例

状态：设计草案 · 对应 [PRD](./remote-omp-over-ssh-prd.md) · 首版：macOS 客户端 → macOS 远端主机

## 1. 决策摘要

**借鉴 OpenCode 的进程分离和重连同步，不照搬它的 HTTP API 和自动部署。** 增加由用户在远端主机预先启动的 Core 常驻模式。Electron 主进程调用系统 OpenSSH，启动一个短命的连接助手；助手只把 SSH 的 stdin/stdout 接到目标实例的 Unix domain socket，不创建 Agent。消息、工具、工作区、任务和审批都归远端实例；本机 sidecar 保持原行为。

首个里程碑应验证的不是「SSH 能通」，而是「同一个任务在 SSH 断开后继续执行，重连后能恢复结果和待审批」。阶段二只在这条链路上增加一个受限的文档读取操作。

## 2. OpenCode 实际怎么做

调研基于本地 OpenCode checkout [`b9a60d9`](https://github.com/anomalyco/opencode/commit/b9a60d9d078d87bfb90f039e431090508f88ac02)。以下是源码行为，不是对两台机器运行结果的验证。

| 层 | OpenCode 实现 | omp 采纳或区别 |
| --- | --- | --- |
| SSH 与认证 | Desktop SSH 插件的 main controller 调用 OpenSSH；通过临时 askpass 把认证和主机信任交互呈现在 GUI。连接尝试有编号，旧尝试不能覆盖新状态。[命令](https://github.com/anomalyco/opencode/blob/b9a60d9d078d87bfb90f039e431090508f88ac02/packages/gui-plugins/src/ssh/command.ts#L138-L177) · [askpass](https://github.com/anomalyco/opencode/blob/b9a60d9d078d87bfb90f039e431090508f88ac02/packages/gui-plugins/src/ssh/askpass.ts#L11-L94) · [状态机](https://github.com/anomalyco/opencode/blob/b9a60d9d078d87bfb90f039e431090508f88ac02/packages/gui-plugins/src/ssh/main-machine.ts#L419-L469) | 采纳系统 OpenSSH、交互归属和尝试隔离；不接受任意 SSH 命令或开启 agent 转发。 |
| 发现与启动 | 远端 `service status` 和私有 registration 用来发现服务；缺少兼容服务时，bootstrap 可安装 CLI 并启动服务；用户授权替换时可重启。[bootstrap](https://github.com/anomalyco/opencode/blob/b9a60d9d078d87bfb90f039e431090508f88ac02/packages/gui-plugins/src/ssh/bootstrap.ts#L76-L160) | 只发现并选择**已运行**的 omp；不安装、启动、替换或重启，不回退到本机。 |
| 数据通道与生命周期 | SSH 把本地 loopback 端口转发到远端 HTTP 服务，带服务认证探测 API 后才进入 ready。清理 SSH 连接不停止服务。另有客户端通过 stdin 持有的 `serve --stdio`，EOF 会结束其租约，不是同一种服务。[controller](https://github.com/anomalyco/opencode/blob/b9a60d9d078d87bfb90f039e431090508f88ac02/packages/gui-plugins/src/ssh/controller.ts#L156-L277) · [服务模式](https://github.com/anomalyco/opencode/blob/b9a60d9d078d87bfb90f039e431090508f88ac02/packages/cli/src/server-process.ts#L153-L220) | 采纳「服务寿命独立于连接」和协议级 ready；omp 已有双向 RPC，不另起 HTTP、SSE 或本地端口转发。 |
| 重连与审批 | SSE 是有限队列上的实时流，不是用 `Last-Event-ID` 回放的日志。重连后客户端重新查询活动会话和审批，协调快照与实时事件。服务端按会话检查审批归属。[事件源](https://github.com/anomalyco/opencode/blob/b9a60d9d078d87bfb90f039e431090508f88ac02/packages/server/src/event-feed.ts#L37-L83) · [同步](https://github.com/anomalyco/opencode/blob/b9a60d9d078d87bfb90f039e431090508f88ac02/packages/client/src/solid/data.ts#L781-L824) · [审批](https://github.com/anomalyco/opencode/blob/b9a60d9d078d87bfb90f039e431090508f88ac02/packages/server/src/handlers/permission.ts#L58-L87) | 采纳「先对账，再接实时流」；另加 omp 自己的快照边界、单写租约、待审批快照和副作用回执。 |
| 服务重启与文件 | OpenCode 有部分任务的 at-least-once 重启恢复；文件界面从当前服务端按需读取。[任务恢复](https://github.com/anomalyco/opencode/blob/b9a60d9d078d87bfb90f039e431090508f88ac02/packages/core/src/session/execution/restart.ts#L469-L529) · [文件读取](https://github.com/anomalyco/opencode/blob/b9a60d9d078d87bfb90f039e431090508f88ac02/packages/app/src/workspaces/files/model.tsx#L220-L240) | 实例重启只恢复已保存会话，不恢复执行中的旧任务。文件预览按需读取，但不引入通用文件 API。 |

### omp 的现有边界

- GUI 的 [`SidecarManager`](../src/main/sidecar.ts#L348-L445) 为 tab 启动本机 `omp --mode rpc-ui`；[`RpcClient`](../src/main/rpc-client.ts#L15-L70) 关联请求 ID、处理超时，但不能证明超时的操作未在 Core 执行。`rpc-ui` 已有帧版本协商、结构化对话、工具事件和 UI 请求，可复用其消息类型和分发逻辑。
- GUI [`sidecar-source.json`](../sidecar-source.json) 锁定的 Core 在 [stdin EOF](https://github.com/nornzach/oh-my-pi/blob/92deec8708fea3cb038b296111f4dd98d6487ee2/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L5579-L5650) 后拒绝待处理 UI 请求、清理会话并退出；[stdout 交付失败](https://github.com/nornzach/oh-my-pi/blob/92deec8708fea3cb038b296111f4dd98d6487ee2/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L1976-L1993) 也会触发退出。`ssh … omp --mode rpc-ui` 会新开进程，不能当作接入方案。
- Core [`get_state`](https://github.com/nornzach/oh-my-pi/blob/92deec8708fea3cb038b296111f4dd98d6487ee2/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L3136-L3193) 有会话和运行状态，却没有待处理 UI 请求；[历史分页](https://github.com/nornzach/oh-my-pi/blob/92deec8708fea3cb038b296111f4dd98d6487ee2/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L4507-L4537) 在流式或压缩时可拒绝查询。不能用顺序调用这两个 RPC 代替运行中的一致快照，更不能把历史游标当作事件游标。

## 3. 进程、SSH 与实例发现

```text
客户端                                    远端主机（SSH 登录账号）
Renderer → Electron IPC → Main
                    本机 tab ├→ 现有 SidecarManager → 本机 omp
                    远端 tab └→ SshConnection → OpenSSH ──→ omp remote attach（短命助手）
                                                                      │ 私有 Unix socket
                                                                      ▼
                                                        omp remote serve（用户预先启动）
                                                           ├─ Agent / 工具 / 模型
                                                           └─ 远端工作区 / 会话 / 待审批
```

命令名为接口提案，不是当前版本已支持的命令：

1. `omp remote serve --name <name>`：用户在目标目录运行，启动一个绑定该工作区的实例。启动不由 GUI 或其 SSH session 管理；长期运行可由用户自己的前台会话或 supervisor 保持。Core 在用户私有运行目录中创建 socket 并发布登记项。仅有 SSH 助手退出不会触发 Agent 的停机路径。
2. `omp remote list --json`：枚举当前 SSH 账号已运行的实例；返回名称、工作区、稳定实例键和协议摘要。不返回凭据或任意 socket 路径。按私有登记定位，并经 socket 确认实例身份与存活；残留文件或 PID 复用不算实例在线。没有可用实例则明确报错；有多个目标时明确选择。
3. `omp remote attach --instance <key>`：只连接登记对应的 socket，双向转发帧；stdout 专用于协议，诊断走 stderr。协商前核对预期实例和工作区，拒绝登记与握手不一致的连接。助手既不创建会话，也不接受客户端传入的 socket 路径或 Shell 脚本。

稳定实例键绑定用户定义的名称和规范化工作区；每次启动另生成 `epoch`。客户端持久化 SSH profile、实例键和不透明 `sessionId`；`epoch` 仅用于判断运行连续性。重连命中同一个稳定键但 `epoch` 变化时，提示「远端实例已重启」，只恢复远端能找到的已保存会话，不把旧任务映射为新实例上的运行任务；原目标不存在时不换到其他实例。

**认证与连接管理：** Electron main 用 argv 启动系统 OpenSSH，复用用户的 alias、known_hosts 和密钥配置；仅允许结构化目标，远端命令固定，实例键只接受协议定义的格式。默认不分配 PTY、不转发 agent，不绕过 host-key 校验；首次主机指纹或密码/口令由用户经当次连接的 askpass 回答。提示与 `attemptId`、发起窗口绑定，只在内存处理，取消或失联立即清理。需要时复用一次尝试内的专用 SSH control socket，由 main 管理，避免重复认证，不共享或关闭用户已有的 SSH master。Unix socket 位于仅远端账号可访问的私有目录；不监听 TCP、不额外向公网开放 RPC。SSH 认证授予的是远端账号访问权限，并不把 Agent 限制在项目目录内。

**为什么不用另外两种方式：** OpenCode 的 loopback HTTP 隧道适合它已有的 server/SDK；omp 采用同方案仍要新实现实例所有权与恢复，还会多一个 HTTP 服务入口和认证边界。维持某个现有 `rpc-ui` 子进程的 stdin，再由外部守护进程缓存其 stdout 虽可避免 EOF，但无法从管道原语得出审批和快照的权威状态。优先在 Core 中复用执行与 RPC 分发，把远程接入做成独立的生命周期适配层。

## 4. 远程契约与恢复

### 4.1 握手、状态和写入权

- **协议：** 通过受限的双向 NDJSON 控制帧协商远程协议主版本、支持能力和帧大小，再承载选定的现有 RPC 命令与事件 payload；历史、任务输出按页或分块。远程协议版本独立于现有 `rpc-ui` v1/v2 帧版本。阶段一能力（会话快照、任务输出、审批、操作回执）缺失即报不兼容；预览能力单独协商，不影响阶段一连接。
- **ready 条件：** SSH 已认证、实例握手成功、已取得写入租约、初次快照与事件流已对齐；缺一项都不开放常规写操作。如果 Core 初始化本身需要用户确认，远程 endpoint 必须先能完成握手并交付该请求，UI 在「正在连接」期间可处理该请求，不能等 Core ready 才可显示审批。
- **单写者：** Core 给活动连接签发写入租约和递增的 fencing 标识，在执行每个写操作前校验。主动断开、连接 EOF 或心跳到期释放租约；第二个 GUI 不抢占有效租约，可在释放后重试。连接失效时拒绝旧租约的迟到写入，但已被 Core 接受的工作继续。写租约只管 GUI 写入，不是运行任务的取消令牌。
- **客户端状态：** `connecting → syncing → ready`；链路丢失进入 `reconnecting`，用户主动结束或不可恢复错误进入 `disconnected`。仅对临时网络故障做有界退避；主机认证、指纹变化、无实例、协议不兼容、其他客户端占用分别给出下一步。旧尝试的事件和回执不能写入新连接。断线期间显示「远端状态未确认」与最后已知状态，不标记已完成，也不在客户端排队写操作。

### 4.2 快照与流的交界

**每次连接都从权威快照恢复；首版不实现持久化的全量事件回放。** Core 在同一个会话状态边界上捕获快照及其序号 `S`，并从 `S + 1` 开始排队实时事件。快照包含 `epoch`、会话及任务 ID、运行/等待/结束状态、已提交的消息与结果引用、尚在生成的回复和当前工具进度，以及仍有效的待审批。已完成的回复和工具结果来自远端保存的会话，不依赖客户端是否收到过实时事件。

客户端先提交快照，再顺序应用同一 `epoch` 中 `seq > S` 的增量；丢弃已应用的帧。历史分页与快照绑定到同一视图边界，第一次同步不必把整段历史装进内存，也不能因任务仍在 streaming 而无法进入界面。若排队溢出、序号跳跃或同步期间会话视图失效，丢弃该次增量并重新取快照。断线时不得让慢客户端反压阻塞 Agent；限制每连接队列，超限关闭连接而非静默丢弃结果。

**输出保留：** 不持久化每个 token delta。断线期间的工具输出和结构化结果仍由远端采集；已完成工具的结果随会话保存，运行中已产生的工具输出通过快照引用远端有界输出记录。若现有工具仅发实时事件、没有可读记录，阶段一须补齐该路径；达到产品的输出上限时标记截断，不能把丢失的输出显示成空结果。远端操作日志与连接诊断分开，连接诊断不含输出正文。

### 4.3 审批、重复请求和停止

| 问题 | 处理规则 |
| --- | --- |
| 审批在断线期间产生 | 待请求由远端 Core 持有，断线不 resolve、不取消、不批准。重连快照交付仍有效的同一个请求，绑定 `epoch + sessionId + requestId`。保留工具自身显式超时、取消或拒绝策略；不能仅因没有客户端而自动批准。 |
| 重复回复或回复时切 tab | 先校验当前租约、会话和请求，再原子地领取 pending 请求并记录回执，仅第一次能决定结果。Main 按来源路由，未知、过期、来自其他 tab 的请求直接拒绝，绝不发给当前活动 tab。 |
| 写请求超时或 ACK 丢失 | GUI 在发送前生成 `actionId`，与 `epoch` 和会话一起记录为未确认；若 GUI 重启，只恢复对账所需的标识，不自动恢复发送队列。Core 在分发前登记接受状态，并按标识查询结果；在回执保留窗口内同 ID 的重复提交不能再次执行。重连先读回执及会话/审批状态，从不自动重发。跨 `epoch` 或回执已回收仍无法证明时显示「结果未确认」；不承诺跨崩溃的 exactly-once。 |
| 用户点击停止 | 向当前实例显式发送绑定 `sessionId + runId` 的停止操作，复用 Core abort 能力；校验运行 ID，防止迟到的停止误伤下一任务。只在远端确认后显示已停止；传输断开与关闭 tab 都不发送 abort。 |
| 远端实例退出 | 已提交会话仍可在用户启动新实例后打开。运行中任务和内存审批不迁移，旧操作不重放，不自动重跑。 |

## 5. GUI / Core 实现落点

| 归属 | 改动边界 |
| --- | --- |
| Core fork：`packages/coding-agent` | 从现有 `runRpcMode` 复用命令分发、`AgentSession`、事件和交互类型，将 stdin EOF / stdout 错误的进程所有权留在 stdio 适配器。远端模式持有 Agent、私有登记/socket、租约、快照、待审批和回执。接入只允许核心命令集；旧 `switch_session` 可改变 cwd，远端路由须改用该工作区内的不透明 session ID，拒绝跨工作区打开。 |
| GUI main：[`index.ts`](../src/main/index.ts#L312-L359)、[`sidecar-pool.ts`](../src/main/sidecar-pool.ts)、[`ipc.ts`](../src/main/ipc.ts#L584-L695) | 在 per-tab backend 边界保留 `LocalSidecar` 行为，新增 `RemoteConnection`；共享可复用的 RPC 请求关联与事件投递，不共享 spawn、warm spare、重启和销毁策略。IPC 按窗口所属 tab 和 backend 选择路由；远端只允许协商过的命令。包括审批、会话归属和缓存键在内均带 `backendId`，临时 UI 路由再加连接代际。 |
| GUI 会话与恢复：[`tab-layout.ts`](../src/main/tab-layout.ts)、[`use-rpc-events.ts`](../src/renderer/hooks/use-rpc-events.ts) | tab 描述持久化区分本机与远端；远端路径是显示数据，不是客户端文件路径。复用渲染和事件 store，按远端快照重新挂载。远端查询不读客户端 `SessionIndex`/`ConversationIndex`，恢复不运行本地目录或 `.jsonl` 存在性检查。远端关闭或不支持的接口显式返回不可用。 |
| GUI 能力隔离：[`ipc.ts`](../src/main/ipc.ts#L1279-L1465)、[`file-actions.ts`](../src/renderer/lib/file-actions.ts) | 远端 tab 不启用本机文件/编辑、Finder、浏览器 relay、host tool/URI、调度器或本机终端服务。远端工具仍可在远端运行命令和 Git。禁用未纳入交付的路径不只靠隐藏按钮：main 的 IPC 边界也拒绝绕路调用，不能只改聊天 RPC。 |

## 6. 阶段二：远端文档预览

1. 聊天与工具结果中的路径携带来源 tab/backend。相对路径由远端以绑定的工作区根目录解析；GUI 不先走本地 `resolvePath`，也不把修饰键点击交给 Finder。调用该连接的 `read_document(path)`；工作区根目录由实例确定，客户端不能另传一个根目录。
2. Core 只返回受大小上限约束的 UTF-8 Markdown / 纯文本和远端路径标签。仅允许工作区内的普通文件；解析链接后检查物理边界，再在远端通过工作区根目录的目录描述符逐级打开，禁止打开阶段跟随被替换的链接；不能只以字符串前缀或单独 `realpath` 检查后再盲开。用已打开的文件描述符检查类型并限量读，区分不存在、无权、越界、超限和不支持。预览的边界不等于 Agent 工具沙箱。
3. GUI 内存中按需渲染，不写出项目副本。复用现有 [`MarkdownRenderer`](../src/renderer/lib/markdown.tsx)，为远端预览收紧资源策略：不执行脚本、不自动加载任何网络或本机文件资源、不读取相邻图片；文档模块不调用本机 Quick Look。关闭或重开预览时不依赖磁盘缓存；重新打开走远端读取，断开时清楚显示不可用。

## 7. 实现顺序与验收

| 顺序 | 交付关口 | 证明方式 |
| --- | --- | --- |
| 1. Core 传输与生命周期 | 同一个已启动实例可经私有 socket 多次接入；断线不会结束 Core 或其任务。 | 用真实 Core/socket 切断传输：断开时远端命令继续，接回后可读远端结果；杀掉实例和只杀 helper 的行为可区分。覆盖阻塞审批与 stdio 本机模式回归。 |
| 2. 恢复、单写与不确定投递 | 运行中快照、序号、审批、回执和写租约收敛后再接 GUI。 | 注入快照期间新事件、队列溢出、ACK 丢失、过期租约和两个并发客户端；验证输出恢复、批准只落一次、拒绝不执行、显式停止只影响指定任务、重启不重跑。 |
| 3. 阶段一可发布 | macOS GUI 连接 macOS 远端实例，完成 [PRD 阶段一验收](./remote-omp-over-ssh-prd.md#6-发布验收)。 | 两台 Mac 实测：客户端无项目/凭据，远端改代码并测试；分别测试关 GUI、断网、审批和恢复，以及认证/指纹异常、无实例、版本错误、第二客户端和同名目录。 |
| 4. 阶段二独立发布 | 远端 Markdown/纯文本按需预览，不依赖本地项目或额外传输。 | 从聊天和工具输出点击预览；构造同名本地文件、越界符号链接、不可读/超限文件和带外部图片的 Markdown，观察实际渲染、错误路由及无自动资源请求。 |

代码所有权：远端 CLI、会话语义和协议定义在 Core fork 实现；Electron 连接、IPC 与 renderer 在 GUI repo 实现。先发布支持远程接入的 Core 或提供兼容安装指引，再发布 GUI；客户端内置 sidecar 仍只用于本机模式，不能替代远端已运行实例。

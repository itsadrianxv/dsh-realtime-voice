# DSH Realtime Voice

DeepSeek Harness 官方插件形态的实时语音 Agent：安装后在 WebUI 输入框旁出现拨打按钮，用户可持续对话、打断播报、询问进度，并用语音启动、追加、纠正或停止当前 DSH Agent 工作。

当前版本：`0.1.0-alpha.7`，目标 DSH：`0.1.0-rc.7`。

本包同时声明 DSH bundle、Host 插件和“原生 WebUI 浏览器侧”插件。这里不是另做一个网站：UI 直接注入 DSH 自带的 `http://127.0.0.1:3080`，不新增页面或 UI 端口。它不修改 DSH 源码，不另起后台进程；卸载或禁用时会移除 UI/路由并关闭麦克风、音频、浏览器 WebSocket 和百炼连接，已经交给 DSH 的任务继续运行。

## 当前能力

- DSH 原生 3080 WebUI：拨号按钮位于发送按钮右侧，使用同尺寸、同色系的通话图标
- 独立可拖动语音浮窗；可在任意位置展开使用，也可收起为带动态波形和计时的悬浮球
- “设置 → 插件 → DSH 实时语音”内一键切换 Qwen Audio Realtime Flash/Plus；下一通生效，不中断当前通话
- “快速声学打断 / 智能语义轮次”可切换；快速模式采用浏览器本地起音检测、立即停播、Host 显式取消和百炼 VAD 三层打断
- 自动识别 `DASHSCOPE_API_KEY`，也可在插件设置中通过 DSH 官方 credentials 安全写入或替换；浏览器不可回读明文
- 默认低延迟 `server_vad`（阈值 0.35、静音 500ms），可选 `smart_turn`；实时转写、流式 PCM 播放、用户全双工打断
- Agent-first 语义路由：每条最终语音转写都直接进入拨号时绑定的 DSH Agent，由 Agent 自己理解、回答、调用现有工具或委派后台任务；不做关键词或正则分流
- 当前会话动态注入语音协调提示与 4 个仅该 Agent 可见的 DSH 工具：委派、追加/纠正、状态、取消
- 耗时、多步或阻塞工作可委派到同工作区、同模型的真实 DSH 工作会话，语音协调 Agent 保持可响应，工作结果完成后自动回到原会话并播报
- 按工作区/标题检索其他 DSH 会话，并读取指定会话最后一条 Agent 回复
- 双层上下文闭环：工作指令进入持久 DSH 会话，`turn/end` 的最终 Agent 回复回灌语音上下文并主动播报
- 长通话恢复：隔离上游/浏览器 socket 异常、忽略迟到旧连接事件、重置音频流，并针对百炼 `1007` 限流延长退避
- DSH credentials 解析 `DASHSCOPE_API_KEY`，密钥不进入浏览器包
- `dsh.voice.v1` 二进制协议，WebUI 与微信小程序共用底层契约

运行时为两层模型：Qwen Audio Realtime 只负责转写、播报和打断，不持有 DSH 工具也不决定是否执行；DSH 当前会话选择的 DeepSeek/千问等 Agent 模型负责全部语义、工具与工作编排。这是单一事实源：语音中的问答和执行都由绑定的 DSH Agent 产生。

## 上下文模型

实时语音不再建第二个“语义对话大脑”。DSH 会话是唯一长期事实源：插件通过官方 `session.prompt` 把每条最终转写原样写入拨号时绑定的 DSH 会话，再订阅该会话事件，以 `sessionId + turn + eventSeq` 关联并去重，在 `turn/end` 后把最终 `assistant/message` 交给 Qwen 仅作语音播报。语音链路中 Qwen 的短期状态只服务声学连续性、字幕和打断，不承担 Agent 记忆。

一通电话与拨号瞬间的 DSH `sessionId` 一对一绑定，而且全局同时只允许一通。页面切换不会迁移通话，右侧栏始终显示绑定线程并可返回。DSH 的“新建会话”页面在选定工作区后已经持有一个空白 session：从这里拨号会绑定这个空白线程，第一条有效语音转写（包括寒暄或任务）成为该 DSH 会话的第一轮，因此文字与语音上下文始终一致。尚未选工作区、因此尚无 session 时，插件不会猜目录或偷偷创建无归属会话，选择工作区后拨号入口自动出现。

## 本地开发安装

```powershell
pnpm install
pnpm build
pnpm test
pnpm verify
dsh plugin --profile web add .
```

随后由用户选择安全时机重启 `dsh web` 并刷新浏览器。官方 `dsh plugin add/remove` 会改变 profile bundle 集合，当前 DSH 不会在已运行进程里热安装一个全新的 bundle；本插件所承诺的热插拔是：不修改本体、Fiber 生命周期完整、配置重载和卸载可彻底释放插件资源。

## 配置密钥

插件配置只保存凭据引用，默认是 `DASHSCOPE_API_KEY`。安装后会自动识别启动 DSH 的系统环境或已有 DSH credentials；也可以打开“设置 → 插件 → DSH 实时语音”直接输入。输入值走官方 write-only credentials API，设置页面只能看到“已配置/未配置”，不能回读明文。不要把 Key 写入 `cordis.patch.yml`、浏览器代码或 Git。

## 一键安装目标

首个可用版验证完成并发布 GitHub tag 后：

```powershell
dsh plugin --profile web add github:martinbear1/dsh-realtime-voice#v0.1.0-alpha.7
```

发布包会提交预构建 `lib/`，不使用会触发 pnpm `allowBuilds` 的 `prepare`，以保持一条命令安装。

卸载：

```powershell
dsh plugin --profile web remove @harness-remote/dsh-realtime-voice
```

## 微信小程序

协议详见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。小程序以后通过已经认证的 Harness Remote 网关代理同一 WebSocket 路径；插件仍然保管百炼密钥并执行所有 DSH 工具，小程序只实现录音、二进制帧、播放、字幕和控制 UI。

小程序 V1 的产品边界是前台实时通话。微信没有承诺所有设备的 RecorderManager PCM 都具有一致的位深和字节序，所以小程序必须先通过真机探针确认 `pcm_s16le`，才能在 `voice.hello` 中声明 `pcmS16leVerified: true`。后台/锁屏连续录音、所有机型可靠全双工和裸 PCM 的统一回声消除不在 V1 承诺内；进入后台时语音链路可停，但 DSH Agent 继续运行，回到前台后重新连线并读取权威任务状态。

## 已验证

- DSH `0.1.0-rc.7` 官方 CLI 本地安装、卸载、重新安装
- 原生 3080 WebUI 插槽：安装后按钮 1 个，卸载后 0 个，重装后恢复
- 真实 WebUI 插件配置卡：Flash/Plus 即时持久化切换；系统 Key 状态检测和 write-only 输入框正常挂载
- 真实 WebUI 布局测量：拨号按钮与发送按钮均为 34px 蓝色圆形，拨号按钮位于发送按钮右侧
- 现有 Agent 会话与所选工作区空白新会话均出现拨号入口；无工作区时不创建隐式任务会话
- `qwen-audio-3.0-realtime-plus` 真实建连、`voice.ready` 和 ping/pong
- Agent-first 合成语音完整回环：16 kHz PCM 上行、英文转写原样进入持久 DSH 会话、DSH Agent 生成最终回复、Qwen 播报及 24 kHz PCM 下行
- 真实 `ws` 成功回调兼容：首个下行音频包不会被误判为发送失败；助手流式字幕按增量完整拼接
- 本地起音约 80ms 后先清空播放，Host 对同一响应只取消一次；VAD 云端事件继续作为权威兜底
- 悬浮窗口拖拽坐标自动限制在视口内，窗口缩放与展开/收起时不会丢出屏幕
- 插件增删前后 28 个现有会话及最新会话 ID 保持一致
- 协议、DSH Agent 会话绑定、会话级工具注入、后台工作会话与 Host 生命周期自动化测试

真实麦克风环境音与听感仍需人工验收；自动测试不会擅自采集或上传环境音。

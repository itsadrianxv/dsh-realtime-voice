# DSH Realtime Voice

DeepSeek Harness 官方插件形态的实时语音 Agent：安装后在 WebUI 输入框旁出现拨打按钮，用户可持续对话、打断播报、询问进度，并用语音启动、追加、纠正或停止当前 DSH Agent 工作。

当前版本：`0.1.0-alpha.2`，目标 DSH：`0.1.0-rc.7`。

本包同时声明 DSH bundle、Host 插件和“原生 WebUI 浏览器侧”插件。这里不是另做一个网站：UI 直接注入 DSH 自带的 `http://127.0.0.1:3080`，不新增页面或 UI 端口。它不修改 DSH 源码，不另起后台进程；卸载或禁用时会移除 UI/路由并关闭麦克风、音频、浏览器 WebSocket 和百炼连接，已经交给 DSH 的任务继续运行。

## 当前能力

- DSH 原生 3080 WebUI 输入框右侧的实时语音拨打按钮和全局通话浮层
- Qwen Audio 3.0 Realtime，默认质量档 `qwen-audio-3.0-realtime-plus`；配置改为 `qwen-audio-3.0-realtime-flash` 即可切换极速档
- `smart_turn`/服务端 VAD、实时转写、流式 PCM 播放、用户打断
- Function Calling 到官方 DSH `apiProxy`：开始、queue/steer、状态、取消
- 按工作区/标题检索其他 DSH 会话，并读取指定会话最后一条 Agent 回复
- 双层上下文闭环：工作指令进入持久 DSH 会话，`turn/end` 的最终 Agent 回复回灌语音上下文并主动播报
- DSH credentials 解析 `DASHSCOPE_API_KEY`，密钥不进入浏览器包
- `dsh.voice.v1` 二进制协议，WebUI 与微信小程序共用底层契约

运行时只使用两层模型：Qwen Audio Realtime 负责听说、打断和受限 Function Calling；DSH 当前会话选择的 DeepSeek/千问等编码模型负责真正的 Agent 工作。语音模型不会旁路 DSH 自己修改代码。

## 上下文模型

实时语音上下文与 DSH 会话不会机械合并。DSH 会话是长期事实源，保存用户确认过的工作指令、Agent 执行和最终回复；语音上下文只保存短期口语、字幕、打断和工具调用。实际工作通过官方 `session.prompt` 写入拨号时绑定的 DSH 会话，插件再订阅该会话事件，以 `sessionId + turn + eventSeq` 关联并去重，在 `turn/end` 后把最终 `assistant/message` 注入语音模型继续播报。寒暄、静音和打断不会污染工作线程；断线重连时从 DSH 状态与最近回复恢复。

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

插件配置只保存凭据引用，默认是 `DASHSCOPE_API_KEY`。请通过 DSH 的 credentials 能力保存该引用对应的 Key，或在启动 DSH 的环境中提供同名变量。不要把 Key 写入 `cordis.patch.yml`、浏览器代码或 Git。

## 一键安装目标

首个可用版验证完成并发布 GitHub tag 后：

```powershell
dsh plugin --profile web add github:martinbear1/dsh-realtime-voice#v0.1.0-alpha.2
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
- `qwen-audio-3.0-realtime-plus` 真实建连、`voice.ready` 和 ping/pong
- 合成语音完整回环：16 kHz PCM 上行、英文转写、`received` 回复及 24 kHz PCM 下行
- 插件增删前后 28 个现有会话及最新会话 ID 保持一致
- 协议、工具白名单/幂等、Function Calling 回写和 Host 生命周期自动化测试

真实麦克风环境音与听感仍需人工验收；自动测试不会擅自采集或上传环境音。

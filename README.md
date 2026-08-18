# DSH Trace Insight｜DSH 轨迹解读器

![Stars](https://img.shields.io/github/stars/Liu-Bot24/dsh-trace-insight?style=flat&label=Stars) ![Forks](https://img.shields.io/github/forks/Liu-Bot24/dsh-trace-insight?style=flat&label=Forks) ![Views 14d](https://github-stats.liu-qi.cn/api/badge/Liu-Bot24/dsh-trace-insight/views14d.svg?v=4) ![Clones 14d](https://github-stats.liu-qi.cn/api/badge/Liu-Bot24/dsh-trace-insight/clones14d.svg?v=4) ![Downloads](https://img.shields.io/github/downloads/Liu-Bot24/dsh-trace-insight/total?style=flat&label=Downloads) ![Release](https://img.shields.io/github/v/release/Liu-Bot24/dsh-trace-insight?style=flat&label=Release)

面向 DeepSeek Harness（DSH）的只读执行复盘插件。它把密集的轨迹事件整理成持续更新的分析时间线，帮助你看清 Agent 做了什么、哪里出错、为什么出错，以及结论对应哪些原始证据。

[English](README.en.md)

![DSH Trace Insight 复盘时间线](docs/assets/trace-insight-review.png)

## 它解决什么问题

DSH 原生轨迹记录了消息、工具调用和事件，但长任务往往包含成百上千个步骤，单靠逐条翻阅很难回答这些问题：

- Agent 实际采用了什么策略？
- 哪些步骤真正推进了任务，哪些是重复试探？
- 失败来自模型判断、工具使用、环境条件还是输入缺失？
- 一段“已经完成”的回答是否有足够证据支撑？
- 长时间运行的一轮中，目前已经发生了什么？

Trace Insight 直接读取 DSH 的结构化 Session Event Log，用规则分析建立事实底座，再按需使用独立模型解释决策、风险和改进方向。

## 主要功能

- **持续复盘**：按 Turn 和 Seq 整理规则分析与模型分析，长任务不必等到整轮结束才看到阶段进展。
- **规则分析**：在本机识别工具失败、重复失败、无进展循环、路径猜测、工具误用、完成信号和验证缺口，不调用模型。
- **模型解读**：使用独立配置的 DSH 模型分析策略、根因、风险、下一步和可复用经验，不改变开发 Agent 的主模型。
- **证据定位**：从结论回到对应的 Seq、Turn、Step、Tool、摘录和原始前后文。
- **任务概览**：按开发阶段、工具使用和问题线索汇总整个任务，并可回到成员记录。
- **结果对比**：比较同一段轨迹的两次模型分析，观察不同模型或配置给出的差异。
- **受控重分析**：可以为指定区间临时切换模型重新分析，不改变以后自动分析使用的默认模型。
- **历史与导出**：分析记录保存在本机，可分别导出分析历史、原始 Session 历史或完整分析包。

## 界面

安装壳层补丁后，DSH 的对话或轨迹保留在左侧，Trace Insight 在右侧检查器中同时显示。你可以一边查看原始执行过程，一边阅读解读结果。

主要页面包括：

- **复盘**：查看按时间排列的规则分析和模型分析。
- **概览**：查看整个任务的阶段、工具和问题汇总。
- **对比**：比较同一轨迹区间的两次成功分析。
- **设置**：配置分析模型、自动分析策略、资源限制和导出。

如果不安装壳层补丁，插件仍可使用，但会显示为 DSH 会话中的独立标签页。

### 证据定位

模型结论和规则发现可以打开独立证据抽屉。每条引用都会标出 Seq、Turn 和摘要，用户需要时再读取对应的原始前后文。

![Trace Insight 证据定位](docs/assets/trace-insight-evidence.png)

### 任务概览

概览按开发阶段、工具使用和问题线索汇总整个 Session。汇总只整理已有分析，不会产生新的模型调用。

![Trace Insight 任务概览](docs/assets/trace-insight-overview.png)

### 两次运行对比

对比只接受范围和输入一致的两次成功分析，分别展示结论、配置、资源用量和原始证据。

![Trace Insight 两次运行对比](docs/assets/trace-insight-compare.png)

## 安装

### 安装前提

- DeepSeek Harness `0.1.0-rc.6`
- DSH Web
- Node.js `22.19.0` 或更高版本

### Windows

克隆或下载本仓库，在仓库根目录执行：

```powershell
npm pack
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

也可以在执行 `npm pack` 后双击 `安装到DSH.cmd`。

### macOS 或 Linux

```bash
npm pack
bash ./install.sh
```

安装器会把插件加入 DSH 的 `web` profile，并通过 `--dump-config` 检查插件是否进入配置。

安装完成后，完全关闭旧 DSH 进程并重新启动。以下命令在 Windows、macOS 和 Linux 上相同：

```shell
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web
```

如果系统已经安装全局 `dsh`，也可以直接运行 `dsh web`。

## 在 Windows 启用右侧检查器

在 Windows PowerShell 中运行：

```powershell
pwsh -File .\patches\apply-shell-patch.ps1
```

补丁仅支持经过验证的 DSH `0.1.0-rc.6` 布局。脚本会在写入前检查 DSH 版本和目标文件 SHA-256，并备份所有将被替换的文件；版本或文件状态不匹配时会停止，不会强制覆盖。

补丁成功后按 `Ctrl+F5` 刷新页面。脚本会输出对应的恢复命令，DSH 升级后不要继续强行使用旧补丁。

右侧检查器补丁目前仅支持 Windows。macOS 和 Linux 可以正常安装和使用 Trace Insight，但界面会显示为 DSH 会话中的独立标签页。

## 第一次使用

1. 打开任意 DSH 会话。
2. 点击页面顶部的 **解读**，打开右侧检查器或解读标签页。
3. 进入 **复盘**。规则分析会直接读取现有轨迹，不需要配置模型。
4. 如需模型解读，进入 **设置 → 模型与自动策略**，选择 DSH 已注册的 provider 和模型。
5. 保存后，可以等待自动分析触发，也可以在复盘中选择一段轨迹手动分析。
6. 点击分析结论中的证据入口，可以查看对应原始事件和前后文。

打开解读页面、刷新、筛选、查看证据、进入概览或进行对比，都不会触发模型调用。

## 模型与自动分析

Trace Insight 的分析模型与开发 Agent 的主模型相互独立。你可以设置：

- 全局默认模型；
- 当前 Session 专用模型；
- 仅本次分析临时使用的模型。

只有前两项会保存。临时换用更强模型不会修改以后自动分析使用的默认配置。

自动分析只会在 Session 已被实时执行纳入观察、已配置默认模型并满足触发条件时运行。模型失败、取消或返回无效结果时，分析进度不会越过该区间。

## 数据保存与导出

默认数据目录：

| 平台 | 路径 |
| --- | --- |
| Windows | `%USERPROFILE%\.dsh\trace-insight` |
| macOS / Linux | `$HOME/.dsh/trace-insight` |

如果设置了 `DSH_HOME`，数据目录为 `<DSH_HOME>/trace-insight`。目录中主要包含：

```text
settings.json
sessions/<session-id-hash>.json
```

可导出的内容分为：

- **分析历史**：规则分析、模型分析、运行状态和分析进度；
- **原始 Session 历史**：DSH 原始事件、surface 与会话谱系；
- **完整分析包**：同时包含分析历史和原始 Session 历史。

原始历史和完整分析包需要再次确认。分析历史也可能包含证据摘录和模型原文，共享前请先检查内容。

## 只读、隐私与费用

- 不修改被检查的 Session、工作区、Skill 或全局记忆。
- 不干预、不暂停、不阻断开发 Agent 的执行。
- 规则分析完全在本机运行，不调用模型。
- 只有自动分析或用户主动发起模型分析时才会产生模型请求。
- 模型输入使用经过裁剪和常见凭证脱敏的轨迹证据，不会发送完整原始日志。
- 使用外部模型意味着相应证据会发送给你选择的模型供应商。
- 原始 Session 导出默认关闭，不会自动夹带到普通分析导出中。

## 卸载

### Windows

```powershell
.\uninstall.ps1
```

也可以双击 `卸载插件.cmd`。卸载插件不会自动删除 `%DSH_HOME%\trace-insight` 中已经保存的分析历史。

### macOS 或 Linux

如果系统已经安装全局 `dsh`：

```bash
dsh plugin --profile web remove dsh-plugin-trace-insight
```

否则使用：

```bash
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web remove dsh-plugin-trace-insight
```

卸载后请重启 DSH。卸载插件不会自动删除 `$DSH_HOME/trace-insight` 或 `$HOME/.dsh/trace-insight` 中已经保存的分析历史。

## 常见问题

### 看不到“解读”入口

Windows PowerShell：

```powershell
dsh --profile web --dump-config | Select-String "trace-insight"
```

macOS 或 Linux：

```bash
dsh --profile web --dump-config | grep "trace-insight"
```

确认后完全关闭旧 DSH 进程，重新运行 `dsh web`，再按 `Ctrl+F5`。

### 显示“等待默认模型”

这不是故障。规则分析仍会继续运行。进入 **设置 → 模型与自动策略**，选择 DSH 已注册的模型并保存即可。

### 模型分析失败

失败记录会保留，分析进度不会跳过失败区间。请检查 provider 凭证、模型路由和限流状态，再从失败区间重试或换模型复查。

### 通过局域网地址打开 DSH 时无法读取数据

Trace Insight Host RPC 仅允许 loopback 页面访问。请在运行 DSH 的同一台机器上通过 `127.0.0.1` 或 `localhost` 使用。

## 兼容性

| 项目 | 当前验证状态 |
| --- | --- |
| Trace Insight | `1.0.0` |
| DeepSeek Harness | `0.1.0-rc.6` |
| DSH Web | 已验证 |
| Node.js | `22.19.0` 或更高版本 |
| 核心插件 | Windows、macOS、Linux |
| 右侧检查器补丁 | 仅 Windows |

DSH 仍处于预览阶段。升级 DSH 前请先确认插件和右侧检查器补丁是否已有对应兼容版本。

## 开发

```powershell
npm run build
npm test
npm pack
```

`client.js` 由 `src/client-template.js` 生成，两者必须保持同步。

## 许可证

[MIT License](LICENSE)

# Trace Insight 标准标签版

在 DeepSeek Harness 的 **对话｜轨迹｜解读** 中复盘会话执行过程。使用 DSH 标准插件接口，不修改 DSH 安装文件，不需要侧栏补丁。

[English](README.en.md)

## 功能

- **复盘**：按时间查看工具结果、规则发现和模型解读。
- **概览**：汇总执行阶段、工具与问题，并定位对应记录。
- **对比**：比较同一段轨迹的两次模型分析。
- **设置与导出**：配置独立分析模型、保存全局或会话设置，导出分析历史和经过确认的原始轨迹。

规则分析在本机运行，不调用模型。模型分析使用你在 DSH 中配置的 provider；只有手动分析或满足已启用的自动分析条件时才发送模型请求。插件不修改被分析的会话。

## 安装

需要 Node.js 22.19.0 或更高版本，以及 DSH Web 0.1.0-rc.7、0.1.0-rc.8、0.1.1-rc.1 或 0.1.1-rc.2。

命令行管理 DSH 插件需要 `pnpm`；未安装时先运行 `npm install -g pnpm`。

```shell
dsh plugin --profile web add https://github.com/Liu-Bot24/dsh-trace-insight/releases/download/standard-v1.4.0/dsh-plugin-trace-insight-standard-1.4.0.tgz
```

如果通过 `npx` 使用 DSH，将命令开头的 `dsh` 替换为 `npx --yes --package=@deepseek-ai/dsh dsh`；卸载命令同样适用。

重新启动 DSH Web，打开会话，选择 **解读**。在插件市场安装时，按市场提示刷新页面或重启。

首次使用可直接查看规则分析；需要模型解读时，在 **设置 → 模型与自动策略** 中选择模型并保存。

## 更新与卸载

从插件市场更新，或对新版本的标准版安装包执行同一条 `dsh plugin --profile web add` 命令。已有分析历史和设置会保留。

```shell
dsh plugin --profile web remove dsh-plugin-trace-insight
```

卸载后按市场提示刷新或重新启动 DSH。分析历史和设置仍保存在 `<DSH_HOME>/trace-insight`，默认是用户目录中的 `.dsh/trace-insight`。

## 与侧栏版切换

标准标签版和侧栏版是同一插件的两种呈现方式，使用同一插件名和数据格式，不同时安装为两个插件。

已有侧栏版时，先用侧栏版的卸载程序移除插件并恢复它管理的 DSH 文件，再安装本标准版。分析历史和设置会保留。标准版不会自行修改或清除其他版本留下的宿主补丁。

## 隐私与使用范围

分析界面在运行 DSH 的同一台机器上通过 `localhost` 或 `127.0.0.1` 使用。外部模型会收到经过裁剪和凭证脱敏的轨迹证据；导出原始轨迹或完整分析包前需要确认。共享导出内容前请检查其中的会话信息。

## 许可证

[MIT](LICENSE)

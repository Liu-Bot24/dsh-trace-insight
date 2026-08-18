# DSH Trace Insight

![Stars](https://img.shields.io/github/stars/Liu-Bot24/dsh-trace-insight?style=flat&label=Stars) ![Forks](https://img.shields.io/github/forks/Liu-Bot24/dsh-trace-insight?style=flat&label=Forks) ![Views 14d](https://github-stats.liu-qi.cn/api/badge/Liu-Bot24/dsh-trace-insight/views14d.svg?v=4) ![Clones 14d](https://github-stats.liu-qi.cn/api/badge/Liu-Bot24/dsh-trace-insight/clones14d.svg?v=4) ![Downloads](https://img.shields.io/github/downloads/Liu-Bot24/dsh-trace-insight/total?style=flat&label=Downloads) ![Release](https://img.shields.io/github/v/release/Liu-Bot24/dsh-trace-insight?style=flat&label=Release)

A read-only execution retrospective plugin for DeepSeek Harness (DSH). It turns dense trajectory events into a continuously updated analysis timeline, helping you understand what the Agent did, where it failed, why it failed, and which original events support each conclusion.

[简体中文](README.md)

![DSH Trace Insight review timeline](docs/assets/trace-insight-review.png)

## What problem does it solve?

DSH records messages, tool calls, and execution events, but long tasks can contain hundreds or thousands of steps. Reading the raw trajectory alone makes it difficult to answer questions such as:

- What strategy did the Agent actually follow?
- Which steps moved the task forward, and which were repeated attempts?
- Did a failure come from model judgment, tool usage, environment constraints, or missing input?
- Is a claimed completion supported by sufficient evidence?
- What has happened so far during a long-running Turn?

Trace Insight reads the structured DSH Session Event Log directly. Deterministic rule analysis establishes the factual baseline, while an independently configured model can explain decisions, risks, and possible improvements.

## Features

- **Continuous review**: organize rule and model analysis by Turn and Seq, including stable progress from a long-running open Turn.
- **Rule analysis**: detect tool failures, repeated failures, no-progress loops, path guessing, tool misuse, completion signals, and verification gaps locally without calling a model.
- **Model interpretation**: analyze strategy, root cause, risk, next steps, and reusable lessons through a separate DSH model without changing the development Agent's model.
- **Evidence navigation**: trace conclusions back to Seq, Turn, Step, Tool, excerpts, and original event context.
- **Task overview**: summarize development phases, tool usage, and issue threads across the Session, with drill-down to member records.
- **Result comparison**: compare two successful model analyses of the same trajectory range.
- **Controlled re-analysis**: temporarily use another model for a selected range without changing the default model used later.
- **History and export**: keep analysis history locally and export analysis history, raw Session history, or a combined bundle.

## Interface

With the optional shell patch installed, DSH Chat or Trajectory remains on the left while Trace Insight opens in a resizable inspector on the right. This allows the original execution and its interpretation to be viewed together.

The main areas are:

- **Review**: the timeline of rule and model analysis.
- **Overview**: task-wide phases, tools, and issue summaries.
- **Compare**: two successful analyses of the same trajectory range.
- **Settings**: model selection, automatic analysis policy, resource limits, and export.

Without the shell patch, the plugin remains usable as a separate DSH conversation tab.

### Evidence navigation

Model conclusions and rule findings can open a dedicated evidence drawer. Each reference identifies its Seq, Turn, and summary; original surrounding events are loaded only when requested.

![Trace Insight evidence navigation](docs/assets/trace-insight-evidence.png)

### Task overview

Overview groups the existing analysis by development phase, tool usage, and issue thread. It does not create a new model call.

![Trace Insight task overview](docs/assets/trace-insight-overview.png)

### Run comparison

Compare accepts two successful analyses with the same range and input, then shows their conclusions, configurations, resource usage, and source evidence side by side.

![Trace Insight run comparison](docs/assets/trace-insight-compare.png)

## Installation

### Requirements

- DeepSeek Harness `0.1.0-rc.6`
- DSH Web
- Node.js `22.19.0` or newer

### Windows

Clone or download this repository, then run the following commands from its root:

```powershell
npm pack
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

After `npm pack`, you can also double-click `安装到DSH.cmd`.

### macOS or Linux

```bash
npm pack
bash ./install.sh
```

The installer adds the plugin to the DSH `web` profile and verifies the resulting configuration with `--dump-config`.

After installation, stop the old DSH process completely and restart it. The following command is the same on Windows, macOS, and Linux:

```shell
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web
```

If `dsh` is installed globally, run `dsh web` instead.

## Enable the right-side inspector on Windows

Run the following command in Windows PowerShell:

```powershell
pwsh -File .\patches\apply-shell-patch.ps1
```

The patch supports only the verified DSH `0.1.0-rc.6` layout. Before writing, it verifies the DSH version and the SHA-256 of every target file, then backs up all files that will be replaced. It refuses unknown versions or modified layouts instead of forcing an overwrite.

After the patch succeeds, refresh the browser with `Ctrl+F5`. The script prints the matching restore command. Do not force the old patch onto a newer DSH build.

The right-side inspector patch currently supports Windows only. Trace Insight can still be installed and used on macOS and Linux, where it appears as a separate DSH conversation tab.

## First use

1. Open any DSH Session.
2. Select **Trace Insight** to open the right-side inspector or the fallback conversation tab.
3. Open **Review**. Rule analysis reads the existing trajectory without requiring a model.
4. To enable model interpretation, open **Settings → Model and automatic policy** and select a provider/model registered in DSH.
5. Wait for automatic analysis or select a trajectory range for manual analysis.
6. Open an evidence entry to inspect the corresponding original event and surrounding context.

Opening or refreshing Trace Insight, filtering the timeline, viewing evidence, opening Overview, or comparing existing analyses does not call a model.

## Models and automatic analysis

The Trace Insight model is independent of the development Agent's main model. You can configure:

- a global default model;
- a model override for the current Session;
- a temporary model for one analysis run.

Only the first two persist. Temporarily selecting a stronger model does not replace the default used by future automatic analysis.

Automatic analysis runs only after a Session has been observed during live execution, a default analysis model is configured, and a trigger condition is met. A failed, cancelled, or invalid model result cannot advance analysis progress past that range.

## Storage and export

Default data directories:

| Platform | Path |
| --- | --- |
| Windows | `%USERPROFILE%\.dsh\trace-insight` |
| macOS / Linux | `$HOME/.dsh/trace-insight` |

When `DSH_HOME` is set, the data directory is `<DSH_HOME>/trace-insight`. Its primary contents are:

```text
settings.json
sessions/<session-id-hash>.json
```

Exports are separated into:

- **Analysis history**: rule analysis, model analysis, run state, and analysis progress.
- **Raw Session history**: original DSH events, surface, and Session lineage.
- **Combined bundle**: both analysis history and raw Session history.

Raw history and combined bundles require explicit confirmation. Analysis history may also contain evidence excerpts and model output, so inspect it before sharing.

## Read-only, privacy, and cost boundaries

- Trace Insight does not modify the inspected Session, workspace, Skill, or global memory.
- It does not intervene in, pause, or block the development Agent.
- Rule analysis runs locally and never calls a model.
- Model requests occur only through automatic analysis or a user-initiated model analysis.
- Model input uses bounded trajectory evidence with common credential patterns redacted instead of sending the complete raw log.
- Using an external model sends the selected evidence to that model provider.
- Raw Session data is excluded from ordinary analysis exports by default.

## Uninstall

### Windows

```powershell
.\uninstall.ps1
```

You can also double-click `卸载插件.cmd`. Uninstalling the plugin does not automatically delete analysis history stored under `%DSH_HOME%\trace-insight`.

### macOS or Linux

If `dsh` is installed globally:

```bash
dsh plugin --profile web remove dsh-plugin-trace-insight
```

Otherwise use:

```bash
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 plugin --profile web remove dsh-plugin-trace-insight
```

Restart DSH after uninstalling. The command does not automatically delete analysis history under `$DSH_HOME/trace-insight` or `$HOME/.dsh/trace-insight`.

## Troubleshooting

### The Trace Insight entry is missing

Windows PowerShell:

```powershell
dsh --profile web --dump-config | Select-String "trace-insight"
```

macOS or Linux:

```bash
dsh --profile web --dump-config | grep "trace-insight"
```

Then stop the old DSH process completely, run `dsh web` again, and refresh with `Ctrl+F5`.

### The page says that it is waiting for a default model

This is not an error. Rule analysis continues to work. Open **Settings → Model and automatic policy**, select a model registered in DSH, and save it.

### Model analysis fails

The failed record is preserved, and analysis progress does not skip the failed range. Check provider credentials, routing, and rate limits, then retry the range or review it with another model.

### Data cannot be loaded from a LAN address

Trace Insight Host RPC is loopback-only. Use `127.0.0.1` or `localhost` on the same machine that runs DSH.

## Compatibility

| Component | Verified version |
| --- | --- |
| Trace Insight | `1.0.0` |
| DeepSeek Harness | `0.1.0-rc.6` |
| DSH Web | Verified |
| Node.js | `22.19.0` or newer |
| Core plugin | Windows, macOS, and Linux |
| Right-side inspector patch | Windows only |

DSH is still in preview. Before upgrading DSH, confirm that a compatible Trace Insight build and inspector patch are available.

## Development

```powershell
npm run build
npm test
npm pack
```

`client.js` is generated from `src/client-template.js` and must remain synchronized.

## License

[MIT License](LICENSE)

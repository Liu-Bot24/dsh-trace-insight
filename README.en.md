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

Trace Insight reads the structured DSH Session Event Log directly. Local rule analysis establishes the factual baseline, while an independently configured model can explain decisions, risks, and possible improvements.

## Features

- **Continuous review**: organize rule and model analysis by Turn and Seq, including stable progress from a long-running open Turn.
- **Rule analysis**: detect tool failures, repeated failures, no-progress loops, path guessing, tool misuse, completion signals, and evidence gaps locally without calling a model.
- **Model interpretation**: analyze strategy, root cause, risk, next steps, and reusable lessons through a separate DSH model without changing the development Agent's model.
- **Evidence navigation**: trace conclusions back to Seq, Turn, Step, Tool, excerpts, and original event context.
- **Task overview**: summarize development phases, tool usage, and issue threads across the Session, with drill-down to member records.
- **Result comparison**: compare two successful model analyses of the same trajectory range.
- **Controlled re-analysis**: temporarily use another model for a selected range without changing the default model used later.
- **History and export**: keep analysis history locally and export analysis history, raw Session history, or a combined bundle.

## Interface

DSH Chat or Trajectory stays on the left while Trace Insight appears in a resizable right sidebar, so the original execution and its interpretation can be viewed together.

The sidebar contains four pages:

- **Review**: the timeline of rule and model analysis.
- **Overview**: task-wide phases, tools, and issue summaries.
- **Compare**: two successful analyses of the same trajectory range.
- **Settings**: model selection, automatic analysis policy, resource limits, and export.

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

DeepSeek Harness `0.1.0-rc.7` and Node.js `22.19.0` or newer are required. Stop DSH before installing.

Download or clone this repository, then run the installer from the repository root. The installer prepares DSH, installs Trace Insight, and adds the right sidebar.

### Windows

Double-click `安装到DSH.cmd`, or run this command in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

### macOS or Linux

```bash
bash ./install.sh
```

Start DSH after installation:

```shell
npx --yes @deepseek-ai/dsh@0.1.0-rc.7 web
```

Open any Session and select **Trace Insight** to open the sidebar.

## First use

1. Open any DSH Session and select **Trace Insight**.
2. Open **Review**. Rule analysis reads the existing trajectory without requiring a model.
3. To enable model interpretation, open **Settings → Model and automatic policy** and select a provider/model registered in DSH.
4. Wait for automatic analysis or select a trajectory range for manual analysis.
5. Open an evidence entry to inspect the corresponding original event and surrounding context.

Opening or refreshing Trace Insight, filtering the timeline, viewing evidence, opening Overview, or comparing existing analyses does not call a model.

## Models and automatic analysis

The Trace Insight model is independent of the development Agent's main model. You can configure:

- a global default model;
- a model override for the current Session;
- a temporary model for one analysis run.

Only the first two persist. Temporarily selecting another model does not replace the default used by future automatic analysis.

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

Exporting raw history or a combined bundle requires confirmation. Analysis history may also contain evidence excerpts and model output, so inspect it before sharing.

## Read-only, privacy, and cost boundaries

- Trace Insight does not modify the inspected Session, workspace, Skill, or global memory.
- It does not intervene in, pause, or block the development Agent.
- Rule analysis runs locally and never calls a model.
- Model requests occur only through automatic analysis or a user-initiated model analysis.
- Model input uses bounded trajectory evidence with common credential patterns redacted instead of sending the complete raw log.
- Using an external model sends the selected evidence to that model provider.
- Raw Session data is excluded from ordinary analysis exports by default.

## Uninstall

Stop DSH before uninstalling.

### Windows

Double-click `卸载插件.cmd`, or run this command in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

### macOS or Linux

```bash
bash ./uninstall.sh
```

The uninstaller removes both Trace Insight and the right sidebar. Existing analysis history remains in the data directory.

## Troubleshooting

### The installer says DSH is running

Close the DSH terminal or window, then run the installer again.

### The Trace Insight entry or sidebar is missing

Stop DSH completely, run the installer again, and start DSH. If the entry still does not appear, check whether the plugin is present in the `web` profile.

Windows PowerShell:

```powershell
npx --yes @deepseek-ai/dsh@0.1.0-rc.7 --profile web --dump-config | Select-String "trace-insight"
```

macOS or Linux:

```bash
npx --yes @deepseek-ai/dsh@0.1.0-rc.7 --profile web --dump-config | grep "trace-insight"
```

### The page is waiting for a default model

Rule analysis continues to work. Open **Settings → Model and automatic policy**, select a model registered in DSH, and save it.

### Model analysis fails

The failed record is preserved, and analysis progress does not skip the failed range. Check provider credentials, routing, and rate limits, then retry the range or review it with another model.

### Data cannot be loaded from a LAN address

Trace Insight Host RPC is loopback-only. Use `127.0.0.1` or `localhost` on the same machine that runs DSH.

## License

[MIT License](LICENSE)

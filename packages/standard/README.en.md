# Trace Insight — Standard Tab Edition

Review DeepSeek Harness sessions in **Conversation | Trajectory | 解读**. This edition uses standard DSH plugin interfaces, does not modify DSH installation files, and needs no sidebar patch.

[中文](README.md)

## Features

- **Review**: browse tool outcomes, rule-based findings, and model analyses over time.
- **Overview**: summarize execution stages, tools, and issues, then open the related records.
- **Compare**: compare two model analyses of the same trajectory range.
- **Settings and export**: select an independent analysis model, save global or session settings, and export analysis history or explicitly confirmed raw trajectories.

Rule-based analysis runs locally without model calls. Model analysis uses a provider configured in DSH and runs only when requested manually or when enabled automatic-analysis conditions are met. The plugin does not modify the session being analyzed.

## Install

Requires Node.js 22.19.0 or newer and DSH Web 0.1.0-rc.7, 0.1.0-rc.8, 0.1.1-rc.1, or 0.1.1-rc.2.

DSH's command-line plugin manager also requires `pnpm`. If it is not installed, run `npm install -g pnpm` first.

```shell
dsh plugin --profile web add https://github.com/Liu-Bot24/dsh-trace-insight/releases/download/standard-v1.4.0/dsh-plugin-trace-insight-standard-1.4.0.tgz
```

If you run DSH through `npx`, replace the leading `dsh` with `npx --yes --package=@deepseek-ai/dsh dsh`. This also applies to the uninstall command.

Restart DSH Web, open a session, and select **解读**. When installing through the marketplace, follow its refresh or restart prompt.

Rule-based review works immediately. To use model analysis, select a model under **Settings → Model and automation** and save it.

## Update and uninstall

Update through the marketplace, or run the same `dsh plugin --profile web add` command with the new standard-edition archive URL. Analysis history and settings are retained.

```shell
dsh plugin --profile web remove dsh-plugin-trace-insight
```

Refresh or restart DSH as prompted. Saved analysis history and settings remain in `<DSH_HOME>/trace-insight`, which defaults to `.dsh/trace-insight` in your user directory.

## Switching from the sidebar edition

The standard tab and sidebar editions are alternative presentations of the same plugin. They share a package name and data format and are not installed as two simultaneous plugins.

If the sidebar edition is installed, first use its uninstaller to remove the plugin and restore the DSH files it manages, then install this edition. Analysis history and settings are retained. The standard edition does not modify or remove host patches left by another edition.

## Privacy and access

Use the analysis interface through `localhost` or `127.0.0.1` on the machine running DSH. External models receive cropped trajectory evidence with credential redaction. Raw and full-bundle exports require confirmation; review session information before sharing exports.

## License

[MIT](LICENSE)

# Trace Insight — Patch-free Sidebar

Review DeepSeek Harness sessions in a right sidebar. Use **解读** in the session header to open or close it and drag its left edge to resize. This edition uses standard DSH plugin interfaces, does not modify DSH installation files, and requires no other sidebar framework.

[中文](README.md)

## Features

- **Review**: browse tool outcomes, rule-based findings, and model analyses over time.
- **Overview**: summarize execution stages, tools, and issues, then open the related records.
- **Compare**: compare two model analyses of the same trajectory range.
- **Settings and export**: select an independent analysis model, save global or session settings, and export analysis history or explicitly confirmed raw trajectories.

Rule-based analysis runs locally without model calls. Model analysis uses a provider configured in DSH and runs only when requested manually or when enabled automatic-analysis conditions are met. The plugin does not modify the session being analyzed.

After automatic analysis pauses, use **手动重试** beside the notice to review the failed segment's model and expected usage in place. Longer backfills show the total expected usage and batch count before confirmation, then continue through batches automatically within each batch's call and input-character limits. A call failure or cancellation stops the remainder without discarding completed progress.

## Install

Requires Node.js 22.19.0 or newer and DSH Web 0.1.0-rc.7, 0.1.0-rc.8, 0.1.1-rc.1, or 0.1.1-rc.2.

DSH's command-line plugin manager also requires `pnpm`. If it is not installed, run `npm install -g pnpm` first.

Install the patch-free sidebar 1.5.0:

```shell
dsh plugin --profile web add https://github.com/Liu-Bot24/dsh-trace-insight/releases/download/standard-v1.5.0/dsh-plugin-trace-insight-standard-1.5.0.tgz
```

You can also install a local `.tgz` using its absolute path. Keep that file in a permanent directory, such as `<DSH_HOME>/trace-insight/packages`, because DSH retains the reference. `DSH_HOME` defaults to `.dsh` in your user directory.

If you run DSH through `npx`, replace the leading `dsh` with `npx --yes --package=@deepseek-ai/dsh dsh`. This also applies to the uninstall command.

Restart DSH Web, open a session, and click **解读**. Wide windows show the sidebar beside the conversation; narrow windows use a closable drawer. Closing it restores the conversation width. Drag the edge or focus it and use the left/right arrow keys to resize.

Rule-based review works immediately. To use model analysis, select a model under **Settings → Model and automation** and save it.

## Update and uninstall

Run the same `dsh plugin --profile web add` command with the new archive. Analysis history and settings are retained.

```shell
dsh plugin --profile web remove dsh-plugin-trace-insight
```

Refresh or restart DSH as prompted. Saved analysis history and settings remain in `<DSH_HOME>/trace-insight`, which defaults to `.dsh/trace-insight` in your user directory.

## Switching from an earlier edition

This edition shares its package name and data format with earlier editions and is not installed alongside them as a second plugin. The tab edition can be updated directly.

If the file-patched sidebar edition is installed, stop DSH and use that edition's uninstaller to restore the DSH files it manages before installing this edition. Analysis history and settings are retained. Normal installation, deactivation and removal of this edition do not modify DSH installation files.

## Privacy and access

Use the analysis interface through `localhost` or `127.0.0.1` on the machine running DSH. External models receive cropped trajectory evidence with credential redaction. Raw and full-bundle exports require confirmation; review session information before sharing exports.

## License

[MIT](LICENSE)

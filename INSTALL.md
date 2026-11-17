# Install Council Mode

Needs a Claude Code build with the mods API (function hooks). Tested on Claude Code 2.1.326 (`claude --version`); older builds may not load mods.

## Option A: from GitHub (normal)

```bash
claude plugin install council --marketplace itumor/claude-council-mode
```

Inside a terminal session instead:

```
/plugin install council --marketplace itumor/claude-council-mode
```

Desktop app: click + next to the prompt box, Plugins, Add marketplace `itumor/claude-council-mode`, then Add plugin.

## Option B: from a local clone

```bash
git clone https://github.com/itumor/claude-council-mode.git ~/src/claude-council-mode
```

```bash
claude plugin marketplace add ~/src/claude-council-mode
```

```bash
claude plugin install council@claude-council-mode
```

## Check it works

1. Start a new Claude Code session (mods load at session start).
2. Run `claude plugin list` and look for `council@claude-council-mode` with `Status: ✔ enabled`.
3. In the session type `/council status` (terminal) or ask `council status` (desktop app).

## Council on in every session

Install with the setting on:

```bash
claude plugin install council --marketplace itumor/claude-council-mode --config autoOn=true
```

Already installed: open the config menu (`/config` in a terminal session), find the council row, set `autoOn` on, then start a new session.

## Update

```bash
claude plugin marketplace update claude-council-mode
```

```bash
claude plugin update council@claude-council-mode
```

Then start a new session. `claude plugin list` shows the version from `.claude-plugin/plugin.json` (0.6.0 at time of writing).

## Remove

```bash
claude plugin uninstall council
```

```bash
claude plugin marketplace remove claude-council-mode
```

## Develop

From the repo root, `claude plugin test .` runs the tests. Usage and design: [README.md](README.md).

# Install Council Mode

Needs a Claude Code build with the mods API (function hooks). Check with `claude --version`.

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
git clone https://github.com/itumor/claude-council-mode.git ~/Council/council-mod
```

```bash
claude plugin marketplace add ~/Council/council-mod
```

```bash
claude plugin install council@claude-council-mode
```

## Check it works

1. Start a new Claude Code session (mods load at session start).
2. Run `claude plugin list` and look for `council` with status `loaded`.
3. In the session type `/council status` (terminal) or ask `council status` (desktop app).

## Update

```bash
claude plugin marketplace update claude-council-mode
```

## Remove

```bash
claude plugin uninstall council
```

```bash
claude plugin marketplace remove claude-council-mode
```

## Develop

From the repo root, `claude plugin test .` runs the tests. Usage and design: [README.md](README.md).

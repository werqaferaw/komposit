# skills

There's one skill per app: `illustrator/`, `photoshop/`, `aftereffects/` and `premiere/`. Each `SKILL.md` tells an AI how to work in that app through the komposit MCP tools (see `mcp/`). After that come the app's tested recipes, copied word for word from `connectors/<app>/guide.md`. It's the same text the `guide` tool serves.

Don't edit the recipes here. Edit the guide, then regenerate:

```sh
node skills/build.mjs           # rewrite the skills from the guides
node skills/build.mjs --check   # fail if a skill is out of date
node --test skills/skills.test.ts
```

To use them in Claude Code, copy a folder into `~/.claude/skills/` (or into `.claude/skills/` in a project). Other agents that read `SKILL.md` folders take them the same way. Every skill expects the komposit MCP server to be connected.

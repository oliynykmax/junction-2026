# pstack config

`models.md` is the team's shared t3-pstack model sheet: which provider and model each pstack role runs on. pstack reads the sheet from `~/.config/t3-pstack/models.md`, so each machine needs a copy:

```sh
mkdir -p ~/.config/t3-pstack && cp pstack/models.md ~/.config/t3-pstack/models.md
```

Validate it after editing with `/setup-pstack`, which checks every entry against the models your T3 can run.

| Tier | Models |
| --- | --- |
| Main work (features, hard bugs, judgment) | Claude Sonnet 5.5 and Opus 5.5, `effort=xhigh` |
| Panels (arena, architect, interrogate) | Opus 5.5 + GPT-6.1 Sol/Terra, plus Gemini 3.8 Flash where it adds a family |
| Unimportant work (exploring, investigating, tooling) | Gemini 3.8 Flash (High), Copilot |

Session hook is on, so new chats are told when to enter `/poteto-mode`. Budget: large (xhigh reasoning).

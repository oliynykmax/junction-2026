# pstack model configuration (T3). One line per role. Delete a line to fall back to the skill default.
# `inherit-parent` or `auto` as a value: the role runs on the parent chat's model (`delegate_task` omits `target`). Alias entries in a panel list still count toward its fan-out.
# budget: large (xhigh)
feature, refactoring: claudeAgent/claude-sonnet-5-5 effort=xhigh
bug-fix: claudeAgent/claude-opus-5-5 effort=xhigh
perf-issue: claudeAgent/claude-opus-5-5 effort=xhigh
hillclimb: claudeAgent/claude-opus-5-5 effort=xhigh
judgment and prose: claudeAgent/claude-opus-5-5 effort=xhigh
hardest tasks: claudeAgent/claude-opus-5-5 effort=xhigh
how explorer: acpRegistry_copilot/default
how explainer: claudeAgent/claude-sonnet-5-5 effort=xhigh
why investigators: antigravity/gemini-3.8-flash-high
why synthesizer: claudeAgent/claude-opus-5-5 effort=xhigh
reflect tooling: antigravity/gemini-3.8-flash-high
reflect judgment, divergent, synthesizer: claudeAgent/claude-opus-5-5 effort=xhigh
arena runners: claudeAgent/claude-opus-5-5 effort=xhigh, codex/gpt-6.1-sol reasoningEffort=xhigh, codex/gpt-6.1-terra reasoningEffort=xhigh
arena cross-judge pool: codex/gpt-6.1-sol reasoningEffort=xhigh, codex/gpt-6.1-terra reasoningEffort=xhigh, antigravity/gemini-3.8-flash-high
swarm workers: codex/gpt-6.1-terra reasoningEffort=high
architect runners: claudeAgent/claude-opus-5-5 effort=xhigh, codex/gpt-6.1-sol reasoningEffort=xhigh, codex/gpt-6.1-terra reasoningEffort=xhigh
interrogate reviewers: claudeAgent/claude-opus-5-5 effort=xhigh, codex/gpt-6.1-sol reasoningEffort=xhigh, antigravity/gemini-3.8-flash-high
session hook: on

# Project Instructions

## Overview
<!-- Describe the project, its purpose, and primary goals -->

## Architecture
<!-- High-level structure, key technologies, and how components relate -->

## Conventions
<!-- Coding standards, naming conventions, patterns to follow -->

## Setup

After cloning, run the setup script once to install all plugins and dependencies:

```bash
bash .claude/scripts/setup.sh
```

This installs: persistent-planning, babel-fish, and hit-em-with-the-docs.

## Key Commands
<!-- Important scripts or commands used in this project -->

## Plugins & Tools

### persistent-planning
Structured planning system for complex tasks. Use this when starting any multi-step or non-trivial task.
- `/start-planning "task name"` — initializes a persistent plan with task_plan.md and notes.md in `.planning/`
- Skill definition: `.claude/skills/persistent-planning/SKILL.md`

### babel-fish
Generates and maintains a live project map of routes, models, import chains, vocabulary, and infra profile.
- Auto-regenerates on every commit via pre-commit hook
- Manual regeneration: `python3 .claude/project-map/generate.py --force`
- Project map: `.claude/project-map/PROJECT_MAP.md`
- Rules auto-loaded: `.claude/rules/project-vocabulary.md`, `.claude/rules/operational-runbook.md`
- Developer skill: `.claude/skills/<project>-developer-skill/SKILL.md`

### hit-em-with-the-docs
Self-managing documentation system with pattern discovery and hierarchical doc structure.
- `/docs load <domain>` — load docs for a specific domain
- `/docs list` — list all 15 documentation domains
- `/docs search <query>` — search across all docs
- `/docs stats` — documentation health stats
- `/docs maintain` — run maintenance
- `/docs integrate <file>` — integrate a document into the system
- `/discover patterns` — discover coding patterns
- `/discover anti-patterns` — detect anti-patterns and code smells
- `/discover standards` — extract implicit coding standards
- CLI also available: `npx hewtd`

## Notes
<!-- Anything else Claude should know about this workspace -->

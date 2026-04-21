# mission-control

Mission Control dashboard for the open-brain Supabase project, served via GitHub Pages at https://bmoore210.github.io/mission-control/.

This repo is a mirror for publishing only. The **source of truth** for the dashboard is `docs/mission-control-v0.html` in the private [`bmoore210/agents`](https://github.com/bmoore210/agents) repo — edits should be made there and copied here.

The Supabase URL and publishable anon JWT embedded in `index.html` are safe to commit publicly: the open-brain project is RLS-gated, and the anon role has `SELECT` only on `agent_activity`, `agent_messages`, `tasks`, and three read-only views. Everything else is RLS-blocked.

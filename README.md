# Récap prospection

Monitoring des appels de prospection du Cabinet Ekinox : Ringover pousse chaque appel vers Supabase, le CRM Jarvi dit si c'est de la prospection, une tâche Claude planifiée rédige les résumés depuis Modjo, et l'équipe lit l'état des lieux du jour sur une page privée.

- Front : GitHub Pages (`web/`), sans framework ni build.
- Back : Supabase `mwbwgnulwfyuqgdgwhqg` (Paris) — Postgres, Auth, Edge Functions, pg_cron.
- Spécifications : `SPECS.md`. Prototype de référence : `design/prototype.html`.
- Écarts assumés par rapport à la spécification : `docs/decisions.md`.
- Conventions pour Claude Code : `CLAUDE.md`.
- Version en production : v1.0.0

## Déploiement

Un push sur `main` déclenche `supabase.yml` (migrations puis edge functions) et `pages.yml` (site). Réglages à faire une fois : voir `SPECS.md` §9.1.

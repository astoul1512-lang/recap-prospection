# Récap prospection

Monitoring des appels de prospection du Cabinet Ekinox : Ringover pousse chaque appel vers Supabase, le CRM Jarvi dit si c'est de la prospection, Modjo / Ringover fournissent le résumé, Claude le met en forme, et l'équipe lit l'état des lieux du jour sur une page privée.

- Front : GitHub Pages (`web/`), sans framework.
- Back : Supabase `mwbwgnulwfyuqgdgwhqg` (Paris) — Postgres, Auth, Edge Functions, pg_cron.
- Spécifications : `SPECS.md`. Prototype de référence : `design/prototype.html`.
- Conventions pour Claude Code : `CLAUDE.md`.
- Version en production : v0.1.0

## Déploiement

Un push sur `main` déclenche `supabase.yml` (migrations puis edge functions) et `pages.yml` (site). Réglages à faire une fois : voir `SPECS.md` §9.1.

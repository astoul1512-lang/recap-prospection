-- =====================================================================
-- Récap prospection — lot 1 : classement, tâches planifiées, résumés
-- Migration additive. La migration initiale n'est jamais modifiée.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Détection de répondeur
--
-- Ringover envoie `answering_machine_detection` (HUMAN / MACHINE / NOTSURE)
-- sur l'événement de raccrochage. Ce champ n'était pas prévu par la
-- spécification : il répond tout seul, pour les appels courts, à la question
-- que la file « À qualifier » posait à l'équipe. On le conserve pour pouvoir
-- afficher « Répondeur » et revenir sur la décision si elle se révèle fausse.
-- ---------------------------------------------------------------------
alter table public.calls add column if not exists machine_detection text;

-- Le rattrapage cherche les appels non classés : sans index, il relit la table.
create index if not exists calls_a_classer_idx on public.calls (started_at desc)
  where kind = 'a_classer';

-- ---------------------------------------------------------------------
-- 2. Garde de modification : la nouvelle colonne n'est pas modifiable par un
--    membre. La fonction est réécrite en entier (Postgres ne sait pas
--    modifier une ligne d'un corps de fonction) ; seule la ligne
--    `new.machine_detection` est nouvelle.
-- ---------------------------------------------------------------------
create or replace function private.guard_member_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then return new; end if; -- service role : pas de garde
  if not public.is_active_user() then raise exception 'inactive' using errcode = '42501'; end if;
  if new.kind_manual is distinct from old.kind_manual then
    insert into public.corrections (call_id, field, old_value, new_value, author_id)
    values (old.call_id, 'kind', old.kind_manual::text, new.kind_manual::text, uid); end if;
  if new.outcome_manual is distinct from old.outcome_manual then
    insert into public.corrections (call_id, field, old_value, new_value, author_id)
    values (old.call_id, 'outcome', old.outcome_manual::text, new.outcome_manual::text, uid); end if;
  if new.situation is distinct from old.situation then
    insert into public.corrections (call_id, field, old_value, new_value, author_id)
    values (old.call_id, 'situation', old.situation::text, new.situation::text, uid); end if;
  if new.summary is distinct from old.summary then
    insert into public.corrections (call_id, field, old_value, new_value, author_id)
    values (old.call_id, 'summary', left(old.summary, 200), left(new.summary, 200), uid); end if;
  if new.next_step is distinct from old.next_step then
    insert into public.corrections (call_id, field, old_value, new_value, author_id)
    values (old.call_id, 'next_step', old.next_step, new.next_step, uid); end if;
  if new.needs_review is distinct from old.needs_review then
    new.reviewed_at = now(); new.reviewed_by = uid;
    insert into public.corrections (call_id, field, old_value, new_value, author_id)
    values (old.call_id, 'needs_review', old.needs_review::text, new.needs_review::text, uid); end if;
  -- Toute autre colonne est remise à l'ancienne valeur
  new.call_id = old.call_id; new.direction = old.direction; new.external_number = old.external_number;
  new.ringover_user_id = old.ringover_user_id; new.started_at = old.started_at; new.answered_at = old.answered_at;
  new.ended_at = old.ended_at; new.duration_s = old.duration_s; new.status = old.status;
  new.kind = old.kind; new.outcome = old.outcome; new.transcript_source = old.transcript_source;
  new.record_link = old.record_link; new.tags = old.tags; new.comments = old.comments;
  new.jarvi_profile_id = old.jarvi_profile_id; new.jarvi_company_id = old.jarvi_company_id;
  new.contact_name = old.contact_name; new.contact_role = old.contact_role; new.company_name = old.company_name;
  new.review_reason = old.review_reason; new.jarvi_checked_at = old.jarvi_checked_at;
  new.jarvi_check_count = old.jarvi_check_count; new.source = old.source; new.day = old.day;
  new.last_event_ts = old.last_event_ts; new.summarize_attempts = old.summarize_attempts;
  new.machine_detection = old.machine_detection;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 3. Réglages internes des tâches planifiées
--
-- pg_cron doit prouver aux fonctions qu'il est bien pg_cron. Plutôt qu'un
-- secret recopié à la main de la base vers les Edge Functions — deux endroits
-- à tenir synchronisés, donc un jour désynchronisés — la valeur ne vit qu'ici
-- et la fonction vient la comparer. Voir docs/decisions.md, D2.
-- ---------------------------------------------------------------------
create table if not exists private.config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table private.config enable row level security;  -- aucune policy : illisible

-- Le jeton est tiré au sort par la base elle-même, une seule fois : il n'a
-- jamais à passer par le dépôt (qui est public), ni par un écran, ni par une
-- conversation. `do nothing` : rejouer la migration ne le change pas, sans quoi
-- les tâches planifiées seraient coupées à chaque déploiement.
insert into private.config (key, value)
select 'cron_token', encode(extensions.gen_random_bytes(32), 'hex')
on conflict (key) do nothing;

create or replace function private.config_value(p_key text) returns text
language sql stable security definer set search_path = private as $$
  select value from private.config where key = p_key;
$$;

-- Comparaison du jeton, faite en base : la fonction ne voit jamais la valeur
-- attendue, elle n'obtient qu'un oui ou un non.
create or replace function public.check_cron_token(p_token text) returns boolean
language sql stable security definer set search_path = public, private as $$
  select coalesce(
    length(p_token) >= 32
    and p_token = private.config_value('cron_token'),
    false);
$$;

-- Identité de l'appelant, vue par la base : une seule définition de « membre
-- actif », celle des policies RLS.
create or replace function public.current_active_user() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.app_users where id = auth.uid() and active;
$$;

revoke all on function private.config_value(text) from public, anon, authenticated;
revoke all on function public.check_cron_token(text) from public, anon, authenticated;
revoke all on function public.current_active_user() from public, anon;
grant execute on function public.check_cron_token(text) to service_role;
grant execute on function public.current_active_user() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. Journal des tâches
--
-- Une tâche qui cesse de tourner ne prévient personne, et son silence
-- ressemble à « il n'y avait rien à faire ». C'est la principale fragilité des
-- traitements planifiés (docs/decisions.md, D1, règle 4) : on garde donc la
-- date du dernier passage réussi de chacune, affichée sur l'écran
-- d'administration.
-- ---------------------------------------------------------------------
create table if not exists public.job_runs (
  name text primary key,
  ran_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb
);
alter table public.job_runs enable row level security;

drop policy if exists job_runs_read on public.job_runs;
create policy job_runs_read on public.job_runs
  for select to authenticated using (public.is_active_user());

create or replace function public.note_job_run(p_name text, p_detail jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.job_runs (name, ran_at, detail)
  values (p_name, now(), coalesce(p_detail, '{}'::jsonb))
  on conflict (name) do update set ran_at = excluded.ran_at, detail = excluded.detail;
$$;
revoke all on function public.note_job_run(text, jsonb) from public, anon, authenticated;
grant execute on function public.note_job_run(text, jsonb) to service_role;

-- ---------------------------------------------------------------------
-- 5. Ce qui reste à résumer
--
-- La mise en forme des résumés est faite par une tâche Claude planifiée, pas
-- par une fonction serveur (docs/decisions.md, D1). Cette vue est son plan de
-- travail : fenêtre de sept jours — pour qu'une journée manquée se rattrape
-- seule — et exclusion de tout appel dont un humain a déjà touché le résumé,
-- la situation ou l'étape suivante.
-- ---------------------------------------------------------------------
create or replace view public.v_a_resumer with (security_invoker = true) as
select c.call_id,
       c.day,
       c.started_at,
       c.duration_s,
       c.direction,
       c.external_number,
       c.company_name,
       c.contact_name,
       c.contact_role,
       c.record_link,
       ru.display_name as user_name
from public.calls c
left join public.ringover_users ru on ru.ringover_user_id = c.ringover_user_id
where public.effective_kind(c) = 'prospection'
  and c.status = 'answered'
  and coalesce(c.duration_s, 0) >= 60
  and c.summary is null
  and c.started_at > now() - interval '7 days'
  and not exists (
    select 1 from public.corrections k
    where k.call_id = c.call_id
      and k.field in ('summary', 'situation', 'next_step')
  );

-- ---------------------------------------------------------------------
-- 6. Planifications
--
-- `classify` en rattrapage : le classement normal se fait à la seconde où
-- l'appel se termine, dans le webhook. Ce passage-ci ne sert qu'aux appels que
-- Jarvi n'a pas pu trancher sur le moment (panne, lenteur) et à ceux que la
-- réconciliation nocturne a rapatriés depuis l'API.
--
-- L'autorisation envoyée est la clé publiable du projet — la même que celle du
-- site, publique par construction : elle sert à passer la porte du portail
-- Supabase (verify_jwt), pas à obtenir un droit. Ce qui fait autorité, c'est le
-- jeton de tâche, tiré au sort plus haut et vérifié par la fonction.
-- ---------------------------------------------------------------------
create or replace function private.appeler_fonction(p_nom text, p_requete text default '')
returns bigint language sql security definer set search_path = private, public, extensions as $$
  select net.http_post(
    url := 'https://mwbwgnulwfyuqgdgwhqg.supabase.co/functions/v1/' || p_nom || p_requete,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_l2zxUEPG1R0MB-LDxfs7Cg_5ELMpEf7',
      'x-cron-token', coalesce(private.config_value('cron_token'), '')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$$;
revoke all on function private.appeler_fonction(text, text) from public, anon, authenticated;

select cron.unschedule('classify_batch') where exists (
  select 1 from cron.job where jobname = 'classify_batch');
select cron.schedule('classify_batch', '*/15 * * * *',
  $$ select private.appeler_fonction('classify', '?mode=batch') $$);

select cron.unschedule('reconcile_nightly') where exists (
  select 1 from cron.job where jobname = 'reconcile_nightly');
-- 01:00 UTC = 03:00 Paris en été, 02:00 en hiver : dans les deux cas la
-- journée de la veille est close et l'API Ringover a fini de la consolider.
select cron.schedule('reconcile_nightly', '0 1 * * *',
  $$ select private.appeler_fonction('reconcile') $$);

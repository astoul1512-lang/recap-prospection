-- =====================================================================
-- Récap prospection — schéma initial (lot 0)
-- Projet Supabase : mwbwgnulwfyuqgdgwhqg (Paris, eu-west-3)
-- Principe : tout est fermé par défaut (RLS), seules les edge functions
-- (service role) écrivent les appels ; les membres actifs lisent et corrigent.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------
-- Schéma privé : tables techniques jamais exposées par PostgREST
-- ---------------------------------------------------------------------
create schema if not exists private;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type public.call_kind as enum ('prospection', 'hors_prospection', 'inconnu', 'a_classer');
create type public.call_outcome as enum ('tentative', 'court', 'bache', 'conversation', 'rdv');
create type public.call_situation as enum ('rdv', 'ouvert', 'porte', 'client', 'direct', 'besoin', 'relance', 'bache');
create type public.call_status as enum ('ringing', 'answered', 'missed', 'voicemail', 'ended');
create type public.call_direction as enum ('in', 'out');
create type public.review_reason as enum ('inconnu', 'court');
create type public.transcript_source as enum ('modjo', 'ringover', 'aucune');
create type public.app_role as enum ('admin', 'member');

-- ---------------------------------------------------------------------
-- Utilisateurs de l'application (liste blanche)
-- ---------------------------------------------------------------------
create table public.app_users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  display_name text not null,
  role public.app_role not null default 'member',
  active boolean not null default true,
  invited_by uuid references public.app_users (id),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

-- Invitations en attente : l'email doit être ici AVANT la création du compte auth
create table private.invitations (
  email text primary key,
  display_name text not null,
  role public.app_role not null default 'member',
  invited_by uuid,
  created_at timestamptz not null default now()
);

-- Refuse toute création de compte auth dont l'email n'a pas été invité (BEFORE),
-- puis crée la ligne app_users correspondante (AFTER, car la FK vise auth.users).
create or replace function private.check_invited()
returns trigger language plpgsql security definer set search_path = public, private as $$
begin
  if not exists (select 1 from private.invitations where lower(email) = lower(new.email)) then
    raise exception 'Adresse non invitée : %', new.email using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function private.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public, private as $$
declare inv private.invitations%rowtype;
begin
  select * into inv from private.invitations where lower(email) = lower(new.email);
  insert into public.app_users (id, email, display_name, role, invited_by)
  values (new.id, lower(new.email), inv.display_name, inv.role, inv.invited_by)
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_check
  before insert on auth.users
  for each row execute function private.check_invited();
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- ---------------------------------------------------------------------
-- Lignes Ringover -> collaborateur
-- ---------------------------------------------------------------------
create table public.ringover_users (
  ringover_user_id text primary key,
  display_name text not null,
  email text,
  active boolean not null default true,
  app_user_id uuid references public.app_users (id),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Cache des recherches Jarvi (par numéro E.164)
-- ---------------------------------------------------------------------
create table public.jarvi_cache (
  phone_e164 text primary key,
  found boolean not null,
  profile_id text,
  company_id text,
  first_name text,
  last_name text,
  headline text,
  company_name text,
  is_contact boolean,
  is_talent boolean,
  fetched_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Appels
-- ---------------------------------------------------------------------
create table public.calls (
  call_id text primary key,                       -- data.call_id Ringover
  channel_id text,
  direction public.call_direction not null,
  external_number text not null,                  -- E.164, ex. +33612345678
  ringover_user_id text references public.ringover_users (ringover_user_id),
  started_at timestamptz not null,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_s integer,
  status public.call_status not null default 'ringing',
  is_internal boolean not null default false,
  is_anonymous boolean not null default false,
  kind public.call_kind not null default 'a_classer',
  kind_manual public.call_kind,
  outcome public.call_outcome not null default 'tentative',
  outcome_manual public.call_outcome,
  situation public.call_situation,
  summary text,
  next_step text,
  transcript_source public.transcript_source not null default 'aucune',
  summarize_attempts smallint not null default 0,
  record_link text,                               -- lien Ringover, jamais l'audio
  tags text[] not null default '{}',
  comments text,
  jarvi_profile_id text,
  jarvi_company_id text,
  contact_name text,
  contact_role text,
  company_name text,
  needs_review boolean not null default false,
  review_reason public.review_reason,
  reviewed_at timestamptz,
  reviewed_by uuid references public.app_users (id),
  jarvi_checked_at timestamptz,
  jarvi_check_count smallint not null default 0,
  source text not null default 'webhook',        -- webhook | api
  day date not null,                              -- jour Paris
  last_event_ts bigint not null default 0,        -- anti-désordre des webhooks
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index calls_day_idx on public.calls (day);
create index calls_number_idx on public.calls (external_number);
create index calls_review_idx on public.calls (needs_review) where needs_review;

-- Valeurs effectives (manuel prime sur auto)
create or replace function public.effective_kind(c public.calls) returns public.call_kind
language sql immutable as $$ select coalesce(c.kind_manual, c.kind) $$;
create or replace function public.effective_outcome(c public.calls) returns public.call_outcome
language sql immutable as $$ select coalesce(c.outcome_manual, c.outcome) $$;

-- ---------------------------------------------------------------------
-- Journal brut des webhooks (append-only, jamais lisible depuis l'app)
-- ---------------------------------------------------------------------
create table private.webhook_events (
  id bigserial primary key,
  received_at timestamptz not null default now(),
  event text not null,
  call_id text,
  attempt integer,
  signature_ok boolean not null,
  payload jsonb not null
);
create index webhook_events_call_idx on private.webhook_events (call_id);

-- ---------------------------------------------------------------------
-- Corrections humaines (audit, insert-only)
-- ---------------------------------------------------------------------
create table public.corrections (
  id bigserial primary key,
  call_id text not null references public.calls (call_id) on delete cascade,
  field text not null,
  old_value text,
  new_value text,
  note text,
  author_id uuid references public.app_users (id),
  created_at timestamptz not null default now()
);
create index corrections_call_idx on public.corrections (call_id);

-- ---------------------------------------------------------------------
-- Statut de complétude par jour (réconciliation nocturne)
-- ---------------------------------------------------------------------
create table public.day_status (
  day date primary key,
  webhook_count integer not null default 0,
  api_count integer,
  complete boolean,
  checked_at timestamptz
);

-- ---------------------------------------------------------------------
-- Fonctions utilitaires
-- ---------------------------------------------------------------------
create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_users where id = auth.uid() and active);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_users
                 where id = auth.uid() and active and role = 'admin'
                   and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2');
$$;

create or replace function private.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create trigger calls_touch before update on public.calls
  for each row execute function private.touch_updated_at();

-- Un membre ne peut modifier que les colonnes de correction ; tout est journalisé.
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
  return new;
end $$;
create trigger calls_guard before update on public.calls
  for each row execute function private.guard_member_update();

-- ---------------------------------------------------------------------
-- RLS : tout fermé, ouvertures explicites
-- ---------------------------------------------------------------------
alter table public.app_users enable row level security;
alter table public.ringover_users enable row level security;
alter table public.jarvi_cache enable row level security;
alter table public.calls enable row level security;
alter table public.corrections enable row level security;
alter table public.day_status enable row level security;
alter table private.webhook_events enable row level security;   -- aucune policy : illisible
alter table private.invitations enable row level security;      -- aucune policy : illisible

create policy app_users_self_read on public.app_users
  for select to authenticated using (id = auth.uid() or public.is_admin());
create policy app_users_admin_write on public.app_users
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy ringover_users_read on public.ringover_users
  for select to authenticated using (public.is_active_user());
create policy ringover_users_admin on public.ringover_users
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy calls_read on public.calls
  for select to authenticated using (public.is_active_user());
create policy calls_member_update on public.calls
  for update to authenticated using (public.is_active_user()) with check (public.is_active_user());

create policy corrections_read on public.corrections
  for select to authenticated using (public.is_active_user());

create policy day_status_read on public.day_status
  for select to authenticated using (public.is_active_user());

-- jarvi_cache : aucune policy pour authenticated (service role uniquement)

-- ---------------------------------------------------------------------
-- Vues (security_invoker : héritent des policies)
-- ---------------------------------------------------------------------
create or replace view public.v_calls with (security_invoker = true) as
select c.*,
       public.effective_kind(c) as kind_eff,
       public.effective_outcome(c) as outcome_eff,
       ru.display_name as user_name
from public.calls c
left join public.ringover_users ru on ru.ringover_user_id = c.ringover_user_id
where not c.is_internal and not c.is_anonymous
  and public.effective_kind(c) in ('prospection', 'inconnu');

create or replace view public.v_funnel_day with (security_invoker = true) as
select day, ringover_user_id,
  count(*) filter (where direction = 'out') as tentatives,
  count(*) filter (where status = 'answered') as personne_eue,
  count(*) filter (where outcome_eff in ('conversation', 'rdv')) as conversations,
  count(*) filter (where outcome_eff = 'rdv') as rdv,
  count(*) filter (where needs_review) as a_qualifier
from public.v_calls
where kind_eff = 'prospection' or needs_review
group by day, ringover_user_id;

-- ---------------------------------------------------------------------
-- Purges (rétention : appels 24 mois, événements bruts 90 jours, cache 30 jours)
-- ---------------------------------------------------------------------
create or replace function private.purge() returns void
language sql security definer set search_path = public, private as $$
  delete from private.webhook_events where received_at < now() - interval '90 days';
  delete from public.jarvi_cache where fetched_at < now() - interval '30 days';
  delete from public.calls where started_at < now() - interval '24 months';
$$;
select cron.schedule('purge_nightly', '30 3 * * *', $$ select private.purge() $$);

-- Les appels aux edge functions planifiées (reconcile, summarize batch) sont
-- ajoutés dans la migration 0002 une fois l'URL du projet et la clé connues :
--   select cron.schedule('reconcile', '0 1 * * *',  -- 03:00 Paris en été
--     $$ select net.http_post(url := '<PROJECT_URL>/functions/v1/reconcile',
--          headers := '{"Authorization": "Bearer <CRON_TOKEN>"}'::jsonb) $$);

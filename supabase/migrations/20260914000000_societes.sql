-- =====================================================================
-- Récap prospection — les sociétés, leurs contacts, leurs prospecteurs
--
-- Copie de travail de la partie CRM de Jarvi, limitée à ce que la page
-- Sociétés a besoin d'afficher. Jarvi reste la source : rien ici n'est saisi
-- à la main, tout est réécrit à chaque synchronisation.
--
-- Aucune donnée candidat (`isTalent` sans `isContact`) n'entre dans ces
-- tables — règle absolue de CLAUDE.md, et la synchronisation ne demande que
-- des contacts.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Les sociétés
-- ---------------------------------------------------------------------
create table if not exists public.companies (
  jarvi_company_id  text primary key,
  name              text not null,
  sector            text,
  jarvi_url         text,
  -- Écrit par la routine du soir, jamais par du code : deux phrases qui
  -- disent où en est la prospection du compte (lot Sociétés §6).
  etat_des_lieux    text,
  etat_des_lieux_at timestamptz,
  -- Disparue de Jarvi : marquée, jamais supprimée. Un compte qui s'efface
  -- emporterait avec lui l'historique des appels qui le désignent.
  archived_at       timestamptz,
  synced_at         timestamptz not null default now()
);

comment on table public.companies is
  'Sociétés du CRM Jarvi dont le responsable prospecte (Martin, Rémy ou '
  'Adrien) — voir docs/decisions.md D9. Copie de travail, réécrite par '
  'jarvi-sync.';

create index if not exists companies_synced_idx
  on public.companies (synced_at) where archived_at is null;

-- ---------------------------------------------------------------------
-- 2. Les prospecteurs d'un compte
--
-- Une table plutôt qu'une colonne : une société peut avoir plusieurs
-- responsables dans Jarvi, et Adrien a tranché — le compte apparaît alors
-- dans la liste de chacun, chacun avec sa propre jauge de couverture.
-- Une colonne aurait obligé à choisir un responsable, donc à effacer le
-- travail de l'autre.
-- ---------------------------------------------------------------------
create table if not exists public.company_owners (
  jarvi_company_id text not null references public.companies (jarvi_company_id) on delete cascade,
  prospecteur      text not null,
  synced_at        timestamptz not null default now(),
  primary key (jarvi_company_id, prospecteur)
);

comment on table public.company_owners is
  'Prénom du ou des responsables Jarvi d''une société. Le prénom seul : '
  'c''est la clé de rapprochement avec la ligne Ringover, comme partout '
  'ailleurs dans l''application.';

-- ---------------------------------------------------------------------
-- 3. Les contacts
--
-- « Opérationnels » au sens d'Adrien : tous les contacts rattachés à la
-- société dans Jarvi, sans distinction. Il n'y a rien à cocher.
-- ---------------------------------------------------------------------
create table if not exists public.contacts (
  jarvi_profile_id text primary key,
  jarvi_company_id text not null references public.companies (jarvi_company_id) on delete cascade,
  name             text not null,
  -- Le poste tel qu'il s'affiche dans Jarvi. Tronqué : certains `headline`
  -- LinkedIn font trois lignes et déformeraient le tableau.
  role             text,
  -- Jamais affiché en entier côté front (SPECS §2.4) : il sert au
  -- rapprochement avec les appels, pas à l'affichage.
  phone_e164       text,
  jarvi_url        text,
  archived_at      timestamptz,
  synced_at        timestamptz not null default now()
);

comment on table public.contacts is
  'Contacts CRM rattachés aux sociétés suivies. Jamais de candidat : '
  'jarvi-sync ne demande que des profils isContact.';

create index if not exists contacts_company_idx
  on public.contacts (jarvi_company_id) where archived_at is null;
create index if not exists contacts_phone_idx
  on public.contacts (phone_e164) where phone_e164 is not null;

-- ---------------------------------------------------------------------
-- 4. Le lien entre un appel et un contact
--
-- Écrit à la synchronisation et par `classify` pour les nouveaux appels.
-- Nullable : un appel vers un numéro qu'aucun contact ne porte reste un
-- appel valide, il n'a simplement pas de fiche en face.
-- ---------------------------------------------------------------------
alter table public.calls add column if not exists contact_id text
  references public.contacts (jarvi_profile_id) on delete set null;

create index if not exists calls_contact_idx
  on public.calls (contact_id) where contact_id is not null;

comment on column public.calls.contact_id is
  'Contact Jarvi rattaché à cet appel. Rapproché d''abord sur '
  'jarvi_profile_id, sinon sur le numéro. Nullable.';

-- ---------------------------------------------------------------------
-- 5. Lecture pour l'équipe, écriture pour les seules fonctions
--
-- Même règle que `calls` : un membre invité lit, personne n'écrit depuis le
-- navigateur. Ces tables sont une copie de Jarvi — les corriger ici
-- reviendrait à créer une seconde vérité qui diverge à la première synchro.
-- ---------------------------------------------------------------------
alter table public.companies enable row level security;
alter table public.company_owners enable row level security;
alter table public.contacts enable row level security;

drop policy if exists companies_read on public.companies;
create policy companies_read on public.companies
  for select to authenticated using (public.is_active_user());

drop policy if exists company_owners_read on public.company_owners;
create policy company_owners_read on public.company_owners
  for select to authenticated using (public.is_active_user());

drop policy if exists contacts_read on public.contacts;
create policy contacts_read on public.contacts
  for select to authenticated using (public.is_active_user());

revoke all on public.companies from anon;
revoke all on public.company_owners from anon;
revoke all on public.contacts from anon;

-- ---------------------------------------------------------------------
-- 6. Ce que la routine doit reprendre
--
-- Les sociétés dont un appel a été résumé depuis la dernière écriture de
-- l'état des lieux — ou qui n'en ont jamais eu. Même principe que
-- `v_a_resumer` : la routine demande « ce qui manque », jamais « ce qui date
-- d'hier », et une journée sautée se rattrape toute seule.
-- ---------------------------------------------------------------------
create or replace view public.v_comptes_a_resumer with (security_invoker = true) as
select c.jarvi_company_id,
       c.name,
       c.etat_des_lieux,
       c.etat_des_lieux_at,
       max(a.started_at) as dernier_appel_resume_at,
       count(*)          as nb_appels_resumes
from public.companies c
join public.contacts ct
  on ct.jarvi_company_id = c.jarvi_company_id
join public.calls a
  on a.contact_id = ct.jarvi_profile_id
where c.archived_at is null
  and a.summary is not null
  and not a.hors_rapport
group by c.jarvi_company_id, c.name, c.etat_des_lieux, c.etat_des_lieux_at
having c.etat_des_lieux_at is null
    or max(a.started_at) > c.etat_des_lieux_at;

comment on view public.v_comptes_a_resumer is
  'Sociétés dont l''état des lieux est à réécrire : un appel a été résumé '
  'depuis la dernière rédaction, ou il n''y en a jamais eu.';

-- ---------------------------------------------------------------------
-- 6 bis. Où en est le tour de synchronisation
--
-- La liste des sociétés Jarvi se parcourt par tranches, un passage toutes
-- les quinze minutes. Il faut donc se souvenir d'où on en est.
--
-- Ce curseur est une commodité, jamais une source de vérité : s'il se perd
-- ou se remet à zéro, le tour recommence depuis le début et tout est
-- réécrit à l'identique. C'est la différence avec un curseur « depuis la
-- date X », qui lui laisserait un trou définitif et silencieux.
--
-- Aucune policy : comme `jarvi_cache`, cette table n'est lisible que par le
-- service role.
-- ---------------------------------------------------------------------
create table if not exists public.sync_state (
  nom        text primary key,
  valeur     integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.sync_state enable row level security;
revoke all on public.sync_state from anon, authenticated;

insert into public.sync_state (nom, valeur) values ('jarvi_sync_offset', 0)
on conflict (nom) do nothing;

-- ---------------------------------------------------------------------
-- 7. Rapprocher les appels des contacts
--
-- Deux clés, dans cet ordre : l'identifiant de profil que `classify` a déjà
-- posé, sinon le numéro. Le second rattrape les appels antérieurs à la
-- création du contact dans Jarvi — le cas le plus fréquent, puisque le
-- collaborateur crée souvent la fiche après avoir appelé.
--
-- En SQL et pas dans la fonction : rapatrier des milliers d'appels pour les
-- recomparer un par un coûterait plusieurs minutes à chaque passage.
-- ---------------------------------------------------------------------
create or replace function public.rattacher_appels_contacts()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with lien as (
    select a.call_id,
           coalesce(
             (select c.jarvi_profile_id from public.contacts c
               where c.archived_at is null
                 and c.jarvi_profile_id = a.jarvi_profile_id),
             (select c.jarvi_profile_id from public.contacts c
               where c.archived_at is null
                 and c.phone_e164 is not null
                 and c.phone_e164 = a.external_number
               limit 1)
           ) as contact_id
      from public.calls a
     where a.contact_id is null
       and not a.is_internal
       and not a.is_anonymous
  )
  update public.calls a
     set contact_id = lien.contact_id
    from lien
   where lien.call_id = a.call_id
     and lien.contact_id is not null;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.rattacher_appels_contacts() from public, anon, authenticated;
grant execute on function public.rattacher_appels_contacts() to service_role;

-- ---------------------------------------------------------------------
-- 8. La synchronisation, toutes les quinze minutes
--
-- Pas une fois par jour : environ 665 sociétés et leurs contacts ne tiennent
-- pas dans une exécution de fonction. Chaque passage prend les sociétés les
-- moins fraîchement synchronisées, par petits lots. Le tour complet se fait
-- en quelques heures et recommence — une société créée dans Jarvi le matin
-- est dans la page l'après-midi, et une panne se rattrape sans intervention.
--
-- C'est la même règle que partout ici : interroger « ce qui est le plus
-- vieux », jamais « ce qui a changé depuis telle date ». Un curseur qui se
-- perd laisse un trou silencieux ; un tri par ancienneté, jamais.
-- ---------------------------------------------------------------------
select cron.unschedule('jarvi_sync') where exists (
  select 1 from cron.job where jobname = 'jarvi_sync');
select cron.schedule('jarvi_sync', '*/15 * * * *',
  $$ select private.appeler_fonction('jarvi-sync') $$);

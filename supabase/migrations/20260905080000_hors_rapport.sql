-- =====================================================================
-- Récap prospection — « hors rapport » devient une colonne, et les
-- locuteurs des appels sortants sont remis à l'endroit.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Hors rapport
--
-- La routine du soir sait reconnaître un appel qui n'a rien à faire dans le
-- rapport de prospection, même quand Jarvi connaît le numéro : une discussion
-- interne, un rappel personnel, un échange sans aucun contenu commercial.
--
-- Elle n'avait aucun endroit pour le noter. `review_reason` est une
-- énumération fermée (`inconnu`, `court`) qui refusait la valeur, alors elle
-- s'est repliée sur `tags` — un tableau de texte libre prévu pour les
-- étiquettes Ringover. Ça marche et ça ne se voit pas : exactement le genre de
-- contournement qui devient une convention non écrite, puis un piège.
--
-- On lui donne la colonne qu'il lui fallait.
-- ---------------------------------------------------------------------
alter table public.calls add column if not exists hors_rapport boolean not null default false;

-- Reprise des seize appels déjà marqués, et nettoyage de l'étiquette.
update public.calls
   set hors_rapport = true,
       tags = array_remove(tags, 'hors_rapport')
 where 'hors_rapport' = any(tags);

comment on column public.calls.hors_rapport is
  'Écarté du rapport par la routine : le numéro est connu de Jarvi mais la '
  'conversation n''a rien de commercial. Un membre corrige en passant '
  'kind_manual à hors_prospection, qui prime.';

-- ---------------------------------------------------------------------
-- 2. Remettre les locuteurs à l'endroit sur les appels sortants
--
-- Ringover numérote les canaux par rôle : 1 = celui qui appelle, 0 = celui qui
-- décroche. Le collaborateur est donc le canal 1 sur un appel sortant. Le code
-- ne regardait que le numéro de canal et attribuait systématiquement le canal 0
-- au collaborateur : sur tous les appels sortants, les rôles étaient inversés.
--
-- Un résumé bâti sur une transcription inversée retourne le sens de l'échange
-- — « il nous a envoyé promener » devient « nous l'avons envoyé promener » —
-- sans que rien ne le signale.
--
-- On échange les deux étiquettes plutôt que de tout retélécharger : c'est
-- exact, instantané, et les transcriptions ne disparaissent pas de l'écran
-- pendant une demi-heure. Le caractère \x01 sert de garde le temps de
-- l'échange, il n'apparaît jamais dans une transcription.
-- ---------------------------------------------------------------------
update public.calls
   set transcript = replace(
         replace(
           replace(transcript, 'Collaborateur : ', E'\x01'),
           'Interlocuteur : ', 'Collaborateur : '),
         E'\x01', 'Interlocuteur : ')
 where direction = 'out'
   and transcript is not null
   and transcript like '%Collaborateur : %';

-- ---------------------------------------------------------------------
-- 3. Garde de modification : la nouvelle colonne n'est pas modifiable par un
--    membre. Il dispose de `kind_manual`, qui prime sur tout le reste.
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
  new.transcript = old.transcript; new.transcript_fetched_at = old.transcript_fetched_at;
  new.transcript_attempts = old.transcript_attempts; new.hors_rapport = old.hors_rapport;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 4. Sortir ces appels de partout
--
-- `v_calls` est la porte unique : la page du jour, les colonnes par situation,
-- la file « À qualifier », les compteurs et l'entonnoir en descendent tous.
-- Un seul `and not c.hors_rapport` suffit donc à les retirer de l'ensemble.
--
-- Toute vue qui change de forme se supprime avant d'être recréée, et
-- `v_funnel_day` dépend de `v_calls` : les deux partent ensemble.
-- ---------------------------------------------------------------------
drop view if exists public.v_funnel_day;
drop view if exists public.v_calls;

create view public.v_calls with (security_invoker = true) as
select c.*,
       public.effective_kind(c) as kind_eff,
       public.effective_outcome(c) as outcome_eff,
       c.transcript is not null as a_transcription,
       ru.display_name as user_name
from public.calls c
left join public.ringover_users ru on ru.ringover_user_id = c.ringover_user_id
where not c.is_internal and not c.is_anonymous
  and not c.hors_rapport
  and public.effective_kind(c) in ('prospection', 'inconnu');

-- Reprise à l'identique : « personne eue » exige trente secondes, sauf
-- décision humaine contraire (docs/decisions.md, D5).
create view public.v_funnel_day with (security_invoker = true) as
select day, ringover_user_id,
  count(*) filter (where direction = 'out') as tentatives,
  count(*) filter (
    where status = 'answered'
      and (coalesce(duration_s, 0) >= 30
           or outcome_manual in ('bache', 'conversation', 'rdv'))
  ) as personne_eue,
  count(*) filter (where outcome_eff in ('conversation', 'rdv')) as conversations,
  count(*) filter (where outcome_eff = 'rdv') as rdv,
  count(*) filter (where needs_review) as a_qualifier
from public.v_calls
where kind_eff = 'prospection' or needs_review
group by day, ringover_user_id;

-- ---------------------------------------------------------------------
-- 5. Et du plan de travail de la routine
--
-- Sans quoi elle rouvrirait chaque soir les seize appels qu'elle vient
-- justement d'écarter.
-- ---------------------------------------------------------------------
drop view if exists public.v_a_resumer;

create view public.v_a_resumer with (security_invoker = true) as
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
       c.needs_review,
       c.review_reason,
       c.summary is null as sans_resume,
       c.transcript,
       ru.display_name as user_name
from public.calls c
left join public.ringover_users ru on ru.ringover_user_id = c.ringover_user_id
where public.effective_kind(c) = 'prospection'
  and c.status = 'answered'
  and coalesce(c.duration_s, 0) >= 20
  and c.transcript is not null
  and not c.hors_rapport
  and (c.summary is null or c.needs_review)
  and c.started_at > now() - interval '7 days'
  and c.reviewed_at is null
  and c.kind_manual is null
  and c.outcome_manual is null
  and not exists (
    select 1 from public.corrections k
    where k.call_id = c.call_id
      and k.field in ('summary', 'situation', 'next_step', 'outcome', 'kind', 'needs_review')
  );

-- Le sens de l'appel décide de qui parle sur quel canal : la fonction de
-- récupération en a besoin.
drop view if exists public.v_sans_transcription;

create view public.v_sans_transcription with (security_invoker = true) as
select c.call_id,
       c.day,
       c.started_at,
       c.duration_s,
       c.direction,
       c.company_name,
       c.transcript_attempts,
       ru.display_name as user_name
from public.calls c
left join public.ringover_users ru on ru.ringover_user_id = c.ringover_user_id
where public.effective_kind(c) = 'prospection'
  and c.status = 'answered'
  and coalesce(c.duration_s, 0) >= 20
  and c.transcript is null
  and not c.hors_rapport
  and c.started_at > now() - interval '7 days';

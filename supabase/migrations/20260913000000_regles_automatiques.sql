-- =====================================================================
-- Récap prospection — plus rien n'attend un humain sans raison
--
-- Règle métier d'Adrien : un appel remonte dans le rapport seulement s'il y a
-- eu un échange **et** que le numéro est dans la partie CRM de Jarvi. Sinon il
-- est hors rapport.
--
-- La routine du soir applique déjà cette règle à chaque passage. Tant qu'elle
-- est la seule à le faire, la file « À qualifier » dépend d'une tâche Claude :
-- le jour où elle ne tourne pas, la file se remplit d'appels que personne
-- n'aurait dû voir. Cette migration porte la règle dans la base et dans les
-- fonctions, pour qu'elle tienne toute seule.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Le seuil descend de 60 à 20 secondes
--
-- Jusqu'ici, tout appel décroché de moins d'une minute partait dans la file :
-- « bâché ou vraie conversation ? ». La question a du sens à 40 secondes. Elle
-- n'en a aucun à 6 : en dessous de vingt secondes il n'y a pas de parole à
-- transcrire, donc rien que la routine puisse apporter, et rien qu'un humain
-- puisse trancher en écoutant — il n'y a rien à écouter.
--
-- C'est le même seuil que celui de `v_a_resumer` (docs/decisions.md, D6) : au
-- dessus, la routine sait faire ; en dessous, il n'y a pas de matière. Les deux
-- doivent rester d'accord, sinon une tranche d'appels tombe entre les deux et
-- n'est traitée par personne.
--
-- Ces appels deviennent des tentatives — ce qu'ils sont : un numéro composé,
-- pas un échange.
-- ---------------------------------------------------------------------
update public.calls
   set outcome = 'tentative',
       needs_review = false,
       review_reason = null
 where status = 'answered'
   and coalesce(duration_s, 0) < 20
   and outcome = 'court'
   -- Jamais par-dessus une décision humaine (SPECS §1.1.6) : ni un appel déjà
   -- tranché dans la file, ni une issue corrigée à la main.
   and reviewed_at is null
   and outcome_manual is null;

-- ---------------------------------------------------------------------
-- 2. Les résumés bâtis sur des transcriptions inversées
--
-- Les locuteurs des appels sortants étaient inversés jusqu'au 5 septembre
-- (docs/decisions.md, D8). Les transcriptions ont été remises à l'endroit le
-- jour même — mais pas les résumés déjà rédigés à partir d'elles. Ceux-là
-- racontent l'échange à l'envers : « il nous a envoyé promener » y est devenu
-- « nous l'avons envoyé promener ». Le texte reste plausible, et c'est bien le
-- problème : rien ne le signale.
--
-- On les efface pour que la routine les réécrive depuis la transcription
-- corrigée. L'ancien texte est archivé avant, hors de portée de
-- l'application : effacer sans garder serait irréversible, et on ne détruit
-- pas du travail réel pour réparer une erreur de code.
-- ---------------------------------------------------------------------
create table if not exists private.resumes_avant_correction (
  call_id     text primary key,
  summary     text,
  situation   text,
  next_step   text,
  archived_at timestamptz not null default now()
);

comment on table private.resumes_avant_correction is
  'Résumés rédigés à partir des transcriptions aux locuteurs inversés '
  '(avant le 5 septembre 2026). Archive de sécurité : rien ne les lit, ils '
  'sont là pour pouvoir comparer si un doute survient.';

insert into private.resumes_avant_correction (call_id, summary, situation, next_step)
select c.call_id, c.summary, c.situation::text, c.next_step
from public.calls c
where c.direction = 'out'
  and c.summary is not null
  and c.started_at < timestamptz '2026-09-05 00:00:00+02'
  and c.reviewed_at is null
  and c.kind_manual is null
  and c.outcome_manual is null
  and not exists (
    select 1 from public.corrections k
    where k.call_id = c.call_id
      and k.field in ('summary', 'situation', 'next_step')
  )
on conflict (call_id) do nothing;

-- Remise en file : `v_a_resumer` reprend tout ce qui n'a pas de résumé.
-- La situation et l'étape suivante partent avec — elles découlent du même
-- texte retourné, les garder reviendrait à réparer à moitié.
update public.calls c
   set summary = null,
       situation = null,
       next_step = null
  from private.resumes_avant_correction a
 where a.call_id = c.call_id;

-- ---------------------------------------------------------------------
-- 3. La revérification Jarvi, 24 h puis 72 h après l'appel
--
-- Un numéro absent de Jarvi au moment de l'appel n'est pas forcément un
-- inconnu : c'est souvent un contact que le collaborateur créera le soir même,
-- ou le lendemain. Aujourd'hui ces appels restent `inconnu` pour toujours —
-- `classify?mode=batch` ne relit que `kind = 'a_classer'`, rien ne les rouvre.
-- Ils attendent un humain qui n'a rien à décider.
--
-- Deux repassages suffisent : le lendemain, puis trois jours après. Au-delà,
-- le numéro n'est pas dans le CRM et n'y sera pas — l'appel sort du rapport
-- avec son motif, visible sur l'écran « Écartés du rapport », et réintégrable
-- d'un clic si quelqu'un n'est pas d'accord.
--
-- La vue dit « qui est dû », pas « qui a été vu N fois » : on compare la date
-- de dernière vérification à l'échéance. Un appel vérifié après son échéance
-- en sort de lui-même, sans compteur à tenir.
-- ---------------------------------------------------------------------
create or replace view public.v_a_revoir_jarvi with (security_invoker = true) as
select c.call_id,
       c.external_number,
       c.is_internal,
       c.is_anonymous,
       c.status,
       c.duration_s,
       c.outcome,
       c.outcome_manual,
       c.kind_manual,
       c.machine_detection,
       c.reviewed_at,
       c.jarvi_check_count,
       c.started_at,
       -- 2 = dernier passage : si Jarvi ne connaît toujours pas le numéro,
       -- l'appel sort du rapport.
       case when c.started_at <= now() - interval '72 hours' then 2 else 1 end as passage
from public.calls c
where c.kind = 'inconnu'
  and c.kind_manual is null
  and not c.hors_rapport
  and not c.is_internal
  and not c.is_anonymous
  and c.external_number like '+%'
  -- Une décision humaine ferme le sujet.
  and c.reviewed_at is null
  -- Au-delà de quinze jours, on n'y revient plus : la réconciliation est
  -- close, et un contact créé si tard ne concerne plus cet appel.
  and c.started_at > now() - interval '15 days'
  and (
    (c.started_at <= now() - interval '24 hours'
     and coalesce(c.jarvi_checked_at, c.started_at) < c.started_at + interval '24 hours')
    or
    (c.started_at <= now() - interval '72 hours'
     and coalesce(c.jarvi_checked_at, c.started_at) < c.started_at + interval '72 hours')
  );

comment on view public.v_a_revoir_jarvi is
  'Appels dont le numéro était inconnu de Jarvi et dont la revérification est '
  'due (24 h, puis 72 h après l''appel). `passage` = 2 signale le dernier '
  'essai : au-delà, l''appel est écarté du rapport.';

-- Toutes les heures : l'échéance est à 24 h et 72 h, l'heure près suffit
-- largement, et le lot reste petit.
select cron.unschedule('classify_revoir') where exists (
  select 1 from cron.job where jobname = 'classify_revoir');
select cron.schedule('classify_revoir', '17 * * * *',
  $$ select private.appeler_fonction('classify', '?mode=revoir') $$);

-- ---------------------------------------------------------------------
-- 4. Quatorze jours pour récupérer une transcription
--
-- Conséquence directe du point 3 : un numéro requalifié en prospection trois
-- jours après l'appel doit encore pouvoir obtenir sa transcription, puis son
-- résumé. Sept jours laissaient trop peu de marge — la chaîne complète
-- (revérification, transcription, routine du soir) pouvait dépasser la fenêtre
-- et l'appel arrivait dans le rapport sans rien à lire.
--
-- Les deux vues bougent ensemble. Élargir la récupération sans élargir le plan
-- de travail de la routine rapatrierait des transcriptions que plus rien ne
-- résume.
-- ---------------------------------------------------------------------
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
  and c.started_at > now() - interval '14 days';

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
  and c.started_at > now() - interval '14 days'
  and c.reviewed_at is null
  and c.kind_manual is null
  and c.outcome_manual is null
  and not exists (
    select 1 from public.corrections k
    where k.call_id = c.call_id
      and k.field in ('summary', 'situation', 'next_step', 'outcome', 'kind', 'needs_review')
  );

-- ---------------------------------------------------------------------
-- 5. Le motif d'écartement n'est pas modifiable par un membre
--
-- Oubli de la migration précédente : `hors_rapport` était protégée, pas
-- `hors_rapport_motif`. Un membre pouvait donc réécrire la justification sans
-- que rien ne soit journalisé. Il dispose de `kind_manual`, qui prime, et du
-- bouton de réintégration côté administration.
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
  new.transcript_attempts = old.transcript_attempts;
  new.hors_rapport = old.hors_rapport; new.hors_rapport_motif = old.hors_rapport_motif;
  return new;
end $$;

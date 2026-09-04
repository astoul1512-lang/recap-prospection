-- =====================================================================
-- Récap prospection — stocker la transcription à côté de l'appel
--
-- Les transcriptions viennent désormais de l'API Ringover et non de Modjo
-- (docs/decisions.md, D7). On les garde en base pour deux raisons : la
-- routine du soir n'a plus qu'un seul endroit où regarder, et l'équipe peut
-- relire l'échange depuis la fiche appel sans quitter l'application.
-- =====================================================================

alter table public.calls
  add column if not exists transcript text,
  add column if not exists transcript_fetched_at timestamptz,
  add column if not exists transcript_attempts smallint not null default 0;

-- Le rattrapage cherche « décroché, sans transcription, pas trop d'essais » :
-- sans index, il relit toute la table toutes les dix minutes.
create index if not exists calls_sans_transcript_idx
  on public.calls (started_at desc)
  where transcript is null and status = 'answered';

-- ---------------------------------------------------------------------
-- Garde de modification : les trois nouvelles colonnes ne sont pas
-- modifiables par un membre. La fonction est réécrite en entier (Postgres ne
-- sait pas modifier une ligne d'un corps de fonction) ; seules les trois
-- dernières affectations sont nouvelles.
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
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Ce qu'on ne fait PAS, et pourquoi
--
-- `v_calls` n'est pas recréée. Sa liste de colonnes a été figée à sa dernière
-- création (voir migration 20260904040000) : la transcription n'y entrera donc
-- pas, et c'est exactement ce qu'on veut. L'écran du jour charge quarante à
-- cinquante appels d'un coup ; y joindre autant de transcriptions ferait
-- passer la page de quelques kilo-octets à plusieurs centaines, pour un texte
-- que personne ne lit à ce moment-là.
--
-- La fiche appel va donc chercher la transcription à l'unité, dans `calls`,
-- quand elle s'ouvre. La RLS existante s'applique telle quelle : membre actif,
-- lecture seule.
-- ---------------------------------------------------------------------

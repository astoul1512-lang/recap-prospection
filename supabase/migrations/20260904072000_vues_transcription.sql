-- =====================================================================
-- Récap prospection — la routine lit les transcriptions, plus Modjo
--
-- Depuis D7, la transcription est en base. La vue de travail de la routine
-- ne liste donc plus que les appels dont le texte est déjà là : sans
-- transcription, il n'y a rien à résumer, et lui présenter ces appels ne
-- ferait que l'inviter à inventer.
--
-- Une seconde vue compte ce qui attend encore, pour que l'écran
-- d'administration le montre — un texte qui n'arrive jamais doit se voir.
-- =====================================================================

-- Toute vue qui change de forme se supprime avant d'être recréée : `create or
-- replace` n'ajoute des colonnes qu'à la fin de la liste. Leçon de la
-- migration 20260904060000, qui a échoué là-dessus.
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
  -- Le changement de D7 : pas de texte, pas de travail.
  and c.transcript is not null
  -- Deux motifs de figurer ici : pas encore de résumé, ou pas encore de tag.
  and (c.summary is null or c.needs_review)
  and c.started_at > now() - interval '7 days'
  -- Jamais un appel qu'un humain a déjà tranché : ni par la file
  -- (`reviewed_at`), ni en corrigeant un champ (`corrections`).
  and c.reviewed_at is null
  and c.kind_manual is null
  and c.outcome_manual is null
  and not exists (
    select 1 from public.corrections k
    where k.call_id = c.call_id
      and k.field in ('summary', 'situation', 'next_step', 'outcome', 'kind', 'needs_review')
  );

-- ---------------------------------------------------------------------
-- Ce qui attend encore sa transcription.
--
-- Sert à deux choses : le compteur de l'écran d'administration, et le plan de
-- travail de la fonction `fetch-transcript` — une seule définition de « ce
-- qu'il manque », pour que les deux ne puissent pas diverger.
-- ---------------------------------------------------------------------
drop view if exists public.v_sans_transcription;

create view public.v_sans_transcription with (security_invoker = true) as
select c.call_id,
       c.day,
       c.started_at,
       c.duration_s,
       c.company_name,
       c.transcript_attempts,
       ru.display_name as user_name
from public.calls c
left join public.ringover_users ru on ru.ringover_user_id = c.ringover_user_id
where public.effective_kind(c) = 'prospection'
  and c.status = 'answered'
  and coalesce(c.duration_s, 0) >= 20
  and c.transcript is null
  and c.started_at > now() - interval '7 days';

-- ---------------------------------------------------------------------
-- Récupération des transcriptions, toutes les dix minutes.
--
-- Ringover met quelques minutes à transcrire un appel : inutile d'insister
-- plus souvent, inutile d'attendre la nuit. Six tentatives par appel, soit une
-- heure de patience, puis on laisse tomber — le compteur de l'écran
-- d'administration montrera ce qui n'est jamais arrivé.
-- ---------------------------------------------------------------------
select cron.unschedule('fetch_transcripts') where exists (
  select 1 from cron.job where jobname = 'fetch_transcripts');
select cron.schedule('fetch_transcripts', '*/10 * * * *',
  $$ select private.appeler_fonction('fetch-transcript') $$);

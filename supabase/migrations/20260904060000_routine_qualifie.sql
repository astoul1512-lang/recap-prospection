-- =====================================================================
-- Récap prospection — la routine du soir qualifie aussi les appels courts
--
-- Ce qu'on a constaté le 4 septembre 2026 en regardant Modjo : il contient
-- des appels de 52, 54, 56, 58 secondes, avec transcription ET résumé. Or la
-- vue `v_a_resumer` ne demandait que les appels d'une minute ou plus — donc
-- exactement pas ceux qui s'accumulent dans la file « À qualifier ».
--
-- Les résumés Modjo suffisent pourtant à trancher : « recrutement géré en
-- interne, nous sommes bien couverts » se lit « pas de besoin » ; « il
-- recommande Clémentine » se lit « porte d'entrée » ; « erreur de numéro » se
-- lit « rien ». Faire trancher ça à la main, appel par appel, alors que le
-- texte est déjà écrit, c'est du travail donné pour rien.
--
-- La vue devient donc le plan de travail complet de la routine : ce qui
-- manque un résumé, ET ce qui attend une qualification.
--
-- Voir docs/decisions.md, D6.
-- =====================================================================

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
       c.needs_review,
       c.review_reason,
       c.summary is null as sans_resume,
       ru.display_name as user_name
from public.calls c
left join public.ringover_users ru on ru.ringover_user_id = c.ringover_user_id
where public.effective_kind(c) = 'prospection'
  and c.status = 'answered'
  -- Vingt secondes : en dessous, il n'y a pas de parole à transcrire, donc
  -- rien que Modjo puisse apporter. Ces appels-là restent à l'équipe.
  and coalesce(c.duration_s, 0) >= 20
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

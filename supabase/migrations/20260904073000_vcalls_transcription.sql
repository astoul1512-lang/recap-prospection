-- =====================================================================
-- Récap prospection — l'écran doit distinguer deux attentes
--
-- Jusqu'ici, une conversation sans résumé portait l'étiquette « Résumé à
-- compléter », quelle qu'en soit la raison. Or il y en a deux, et elles
-- n'appellent pas la même chose :
--
--   - la transcription n'est pas encore arrivée → il n'y a rien à faire,
--     qu'attendre ;
--   - la transcription est là, le résumé non → la routine a du retard, ou
--     elle a buté sur cet appel.
--
-- Confondre les deux, c'est ne jamais savoir si la chaîne fonctionne. On
-- expose donc un simple booléen : la transcription est-elle arrivée ?
--
-- Le texte lui-même reste hors de la vue — l'écran du jour charge cinquante
-- appels d'un coup, la fiche appel ira le chercher à l'unité.
-- =====================================================================

-- Toute vue qui change de forme se supprime avant d'être recréée, et
-- `v_funnel_day` dépend de `v_calls` : les deux partent ensemble.
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
  and public.effective_kind(c) in ('prospection', 'inconnu');

-- Reprise à l'identique de la migration 20260904050000 : « personne eue »
-- exige trente secondes, sauf décision humaine contraire (docs/decisions.md, D5).
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

-- ATTENTION : `select c.*` fige la liste des colonnes à la création. Toute
-- colonne ajoutée plus tard à `calls` — y compris `transcript`, qu'on ne veut
-- justement pas ici — n'entrera dans cette vue que si on la recrée.

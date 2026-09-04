-- =====================================================================
-- Récap prospection — « personne eue » : trente secondes au moins
--
-- Ringover marque un appel « décroché » dès que la ligne se connecte. Un
-- serveur vocal, un raccrochage immédiat, une erreur de numéro comptaient
-- donc comme une personne jointe. Sur la première vraie journée : 36
-- « personnes eues » sur 44 appels — 82 % — dont 24 duraient moins de dix
-- secondes. Le deuxième chiffre de l'entonnoir, celui qu'on lit en premier,
-- ne voulait rien dire.
--
-- Seuil fixé par Adrien le 4 septembre 2026 : en dessous de trente secondes,
-- on n'a pas eu la personne. Voir docs/decisions.md, D5.
--
-- La correction humaine prime toujours (SPECS §1.1.6) : un refus sec de six
-- secondes qualifié « Bâché » reste un refus qu'on a entendu, et il compte.
-- =====================================================================

create or replace view public.v_funnel_day with (security_invoker = true) as
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

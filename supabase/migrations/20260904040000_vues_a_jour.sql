-- =====================================================================
-- Récap prospection — remettre les vues au niveau de la table
--
-- LE PIÈGE, à retenir : `create view … as select c.* from calls c` ne veut
-- pas dire « toutes les colonnes de calls ». Postgres développe l'étoile **au
-- moment de la création** et fige la liste. Une colonne ajoutée ensuite à
-- `calls` n'apparaît jamais dans la vue.
--
-- Ce que ça a donné : `machine_detection` a été ajoutée à `calls`, mais pas à
-- `v_calls`. L'application, qui demande ses colonnes nommément, s'est vu
-- refuser la requête entière par PostgREST — et l'écran du jour s'est affiché
-- vide. Pas un message d'erreur : « aucun appel ». Le pire des symptômes,
-- puisqu'il ressemble à une journée calme.
--
-- RÈGLE POUR LA SUITE : toute migration qui ajoute une colonne à `calls`
-- rejoue ce fichier. `create or replace view` ne suffit pas — il n'autorise
-- l'ajout de colonnes qu'à la fin, or `c.*` les insère au milieu. Il faut
-- supprimer et recréer, donc reprendre aussi `v_funnel_day` qui en dépend.
-- =====================================================================

drop view if exists public.v_funnel_day;
drop view if exists public.v_calls;

create view public.v_calls with (security_invoker = true) as
select c.*,
       public.effective_kind(c) as kind_eff,
       public.effective_outcome(c) as outcome_eff,
       ru.display_name as user_name
from public.calls c
left join public.ringover_users ru on ru.ringover_user_id = c.ringover_user_id
where not c.is_internal and not c.is_anonymous
  and public.effective_kind(c) in ('prospection', 'inconnu');

create view public.v_funnel_day with (security_invoker = true) as
select day, ringover_user_id,
  count(*) filter (where direction = 'out') as tentatives,
  count(*) filter (where status = 'answered') as personne_eue,
  count(*) filter (where outcome_eff in ('conversation', 'rdv')) as conversations,
  count(*) filter (where outcome_eff = 'rdv') as rdv,
  count(*) filter (where needs_review) as a_qualifier
from public.v_calls
where kind_eff = 'prospection' or needs_review
group by day, ringover_user_id;

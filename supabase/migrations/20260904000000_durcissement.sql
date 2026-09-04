-- =====================================================================
-- Récap prospection — durcissement suite à l'audit Supabase (4 sept. 2026)
--
-- L'audit de sécurité Supabase, passé après le déploiement du lot 0, remonte
-- deux familles d'avertissements réels. Ils sont corrigés ici. Les trois points
-- « INFO » restants (RLS active sans policy sur invitations, webhook_events et
-- jarvi_cache) sont volontaires : une table dont la RLS est active et qui n'a
-- AUCUNE policy est totalement illisible, c'est l'état le plus fermé possible.
-- =====================================================================

-- --------------------------------------------------------------------
-- 1. Chemin de recherche figé sur les fonctions qui en manquaient
--
-- Sans `search_path` fixe, une fonction résout ses noms d'objets selon le
-- chemin de l'appelant. Quelqu'un qui peut créer un objet dans un schéma placé
-- en tête de ce chemin peut alors détourner ce que la fonction exécute. Aucune
-- de ces trois n'est SECURITY DEFINER, le risque est donc faible — mais c'est
-- une hygiène qui ne coûte rien, et la spécification (§8) demande un audit à zéro.
--
-- `search_path = ''` est le réglage le plus strict : plus rien n'est résolu
-- implicitement. Ces trois fonctions n'utilisent que leur argument et `now()`
-- (résolu dans pg_catalog, toujours consulté d'office), donc rien ne casse.
-- --------------------------------------------------------------------
alter function private.touch_updated_at() set search_path = '';
alter function public.effective_kind(public.calls) set search_path = '';
alter function public.effective_outcome(public.calls) set search_path = '';

-- --------------------------------------------------------------------
-- 2. Fermer aux visiteurs anonymes les deux fonctions de contrôle d'accès
--
-- `is_active_user()` et `is_admin()` sont SECURITY DEFINER : elles s'exécutent
-- avec les droits de leur propriétaire. Postgres les rend exécutables par TOUS
-- par défaut, y compris le rôle `anon` — donc appelables sans être connecté via
-- /rest/v1/rpc/. Elles ne renvoient rien d'exploitable (sans session,
-- auth.uid() est nul, donc toujours faux), mais exposer une fonction de
-- contrôle d'accès à des inconnus n'a aucune raison d'être.
--
-- On révoque au niveau de PUBLIC (le pseudo-rôle qui couvre tout le monde) :
-- révoquer seulement pour `anon` ne servirait à rien, le droit hérité de PUBLIC
-- resterait. Puis on rouvre uniquement à qui en a besoin.
--
-- ATTENTION : `authenticated` doit impérativement les garder. Les policies RLS
-- de public.calls, app_users, corrections et day_status les appellent, et une
-- policy s'évalue avec les droits du rôle appelant. Les révoquer à
-- `authenticated` fermerait l'application à ses propres utilisateurs.
-- --------------------------------------------------------------------
revoke all on function public.is_active_user() from public;
revoke all on function public.is_admin() from public;

grant execute on function public.is_active_user() to authenticated, service_role;
grant execute on function public.is_admin() to authenticated, service_role;

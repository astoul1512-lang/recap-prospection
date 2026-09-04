-- =====================================================================
-- Récap prospection — fermer réellement is_active_user() et is_admin()
--                     aux visiteurs anonymes
--
-- La migration 20260904000000 révoquait ces fonctions au niveau de PUBLIC.
-- L'audit a continué de les signaler comme appelables sans être connecté, et
-- la lecture des droits réels explique pourquoi :
--
--   is_active_user : postgres=X, anon=X, authenticated=X, service_role=X
--
-- Supabase applique des privilèges par défaut sur le schéma public qui
-- accordent NOMMÉMENT le droit d'exécution à anon, authenticated et
-- service_role — en plus du droit hérité de PUBLIC. Retirer PUBLIC ne retire
-- donc pas le droit nommé : il faut révoquer anon explicitement.
--
-- À retenir pour les prochaines fonctions : sur Supabase, un `revoke ... from
-- public` seul ne ferme rien dans le schéma public. C'est ce que fait déjà,
-- correctement, la migration 20260903010000 (revoke from public, anon,
-- authenticated) pour les quatre fonctions de service.
--
-- authenticated conserve le droit : les policies RLS de calls, app_users,
-- corrections et day_status appellent ces fonctions, et une policy s'évalue
-- avec les droits du rôle appelant.
-- =====================================================================

revoke all on function public.is_active_user() from anon;
revoke all on function public.is_admin() from anon;

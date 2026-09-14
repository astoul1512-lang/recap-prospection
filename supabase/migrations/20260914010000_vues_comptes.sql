-- =====================================================================
-- Récap prospection — les vues de couverture des comptes (lot Sociétés §4)
--
-- Tout le calcul de la page Sociétés est ici, et nulle part ailleurs. Le
-- front n'additionne rien : il affiche des lignes déjà calculées, filtre et
-- trie. C'est la règle du lot — quatre arbitrages métier d'Adrien qui ne
-- doivent exister qu'à un seul endroit :
--
--   1. « Appelé » = un appel tenté, décroché ou non. Ici on mesure l'effort
--      de prospection, pas le résultat. C'est délibérément différent du
--      reste de l'application, où « personne eue » exige trente secondes.
--   2. La jauge de couverture d'un prospecteur ne compte que SES appels.
--      Si Rémy appelle un contact d'un compte de Martin, l'appel se voit
--      mais ne crédite pas Martin.
--   3. Périmètre : prospection, non écarté du rapport. Les tentatives sans
--      décroché sont incluses — elles n'ont pas de résumé, c'est le cas
--      nominal : sur les données réelles, 5 appels sur 40 ont produit un
--      échange.
--   4. Seuil d'alerte : 14 jours, dans une seule constante.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Les trois constantes du lot, en fonctions
--
-- Une fonction plutôt qu'une valeur recopiée : le jour où le seuil passe à
-- 21 jours, il y a un seul endroit à changer, et le front lit la valeur au
-- lieu de la deviner (`v_comptes.seuil_jours`).
-- ---------------------------------------------------------------------
create or replace function public.seuil_couverture_jours()
returns integer language sql immutable parallel safe as $$
  select 14
$$;

comment on function public.seuil_couverture_jours() is
  'Nombre de jours sans appel du propriétaire au-delà duquel un compte '
  'passe en alerte (lot Sociétés §2.4). Constante unique : ne jamais '
  'recopier 14 ailleurs, ni en SQL ni dans le front.';

-- Les prénoms viennent de deux mondes qui ne s'accordent pas sur les
-- accents : Ringover dit « Rémy », Jarvi écrit souvent « Remy ». Comparer
-- les chaînes telles quelles mettrait toutes ses jauges à zéro sans lever
-- la moindre erreur — exactement le genre de panne muette que ce projet
-- cherche à éviter (docs/decisions.md D7).
create or replace function public.prenom_normalise(nom text)
returns text language sql immutable parallel safe as $$
  select lower(translate(btrim(coalesce(nom, '')),
                         'àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ',
                         'aaaeeeeiioouuucAAAEEEEIIOOUUUC'))
$$;

comment on function public.prenom_normalise(text) is
  'Prénom comparable entre Ringover et Jarvi : accents et casse retirés.';

-- La plus chaude des situations d'un compte. L'ordre est celui arbitré par
-- Adrien ; une situation inconnue de la liste se range en dernier plutôt
-- que de faire échouer la vue.
create or replace function public.situation_chaude(situations text[])
returns text language sql immutable parallel safe as $$
  select s
    from unnest(coalesce(situations, '{}'::text[])) as s
   order by array_position(
              array['rdv', 'ouvert', 'porte', 'relance',
                    'client', 'direct', 'besoin', 'bache'], s)
   limit 1
$$;

comment on function public.situation_chaude(text[]) is
  'La situation la plus chaude d''un compte : rdv > ouvert > porte > '
  'relance > client > direct > besoin > bache (lot Sociétés §4).';

revoke all on function public.seuil_couverture_jours() from anon;
revoke all on function public.prenom_normalise(text) from anon;
revoke all on function public.situation_chaude(text[]) from anon;

-- ---------------------------------------------------------------------
-- 2. Les appels qui comptent pour un compte
--
-- Bâtie sur `calls` et non sur `v_calls` : `v_calls` laisse passer les
-- appels `inconnu` (c'est sa raison d'être, la file « À qualifier ») et ne
-- porte pas `contact_id`. Les trois conditions du périmètre sont donc
-- écrites ici en toutes lettres, comme dans `v_a_resumer`.
-- ---------------------------------------------------------------------
create or replace view public.v_compte_appels with (security_invoker = true) as
select ct.jarvi_company_id as company_id,
       c.contact_id,
       c.call_id,
       c.day,
       c.started_at,
       c.direction,
       c.duration_s,
       c.status,
       ru.display_name as user_name,
       c.situation,
       c.summary,
       c.next_step,
       c.record_link,
       -- « Échange » = la routine a su dire où en est la relation. Un appel
       -- sans situation est une tentative : la page affiche « Pas de
       -- décroché » et ça n'a rien d'anormal.
       c.situation is not null as echange
from public.calls c
join public.contacts ct on ct.jarvi_profile_id = c.contact_id
left join public.ringover_users ru on ru.ringover_user_id = c.ringover_user_id
where public.effective_kind(c) = 'prospection'
  and not c.hors_rapport
  and not c.is_internal
  and not c.is_anonymous;

comment on view public.v_compte_appels is
  'Un appel de prospection par ligne, rattaché à son contact et à sa '
  'société. Tentatives incluses : ici on compte l''effort, pas le '
  'résultat (lot Sociétés §2.1).';

-- ---------------------------------------------------------------------
-- 3. Les contacts, vus par chaque prospecteur du compte
--
-- Une ligne par couple (contact × prospecteur) : un compte partagé donne
-- deux lignes par contact, et chacun voit sa propre couverture.
--
-- Un contact disparu de Jarvi sort de la liste — sauf s'il a été appelé :
-- l'effacer ferait baisser le dénominateur et remonterait la jauge toute
-- seule, ce qui serait un mensonge.
-- ---------------------------------------------------------------------
create or replace view public.v_compte_contacts with (security_invoker = true) as
select o.jarvi_company_id as company_id,
       o.prospecteur,
       ct.jarvi_profile_id as contact_id,
       ct.name             as contact_name,
       ct.role             as contact_role,
       ct.jarvi_url,
       ct.archived_at,
       count(a.call_id)                                    as nb_appels,
       max(a.started_at)                                   as dernier_appel_at,
       (array_agg(a.user_name order by a.started_at desc)
          filter (where a.call_id is not null))[1]         as dernier_appel_par,
       (array_agg(a.situation::text order by a.started_at desc)
          filter (where a.situation is not null))[1]       as derniere_situation,
       count(a.call_id) filter (
         where public.prenom_normalise(a.user_name)
             = public.prenom_normalise(o.prospecteur)) > 0 as appele_par_proprietaire,
       count(a.call_id) filter (where a.echange) > 0       as a_echange
from public.contacts ct
join public.company_owners o on o.jarvi_company_id = ct.jarvi_company_id
left join public.v_compte_appels a on a.contact_id = ct.jarvi_profile_id
group by o.jarvi_company_id, o.prospecteur, ct.jarvi_profile_id,
         ct.name, ct.role, ct.jarvi_url, ct.archived_at
having ct.archived_at is null or count(a.call_id) > 0;

comment on view public.v_compte_contacts is
  'Un contact par ligne et par prospecteur du compte, avec son dernier '
  'appel et le fait qu''il ait été appelé par le propriétaire du compte.';

-- ---------------------------------------------------------------------
-- 4. Une ligne par compte et par prospecteur — la page Sociétés
--
-- Trois agrégats séparés, parce qu'ils ne se comptent pas au même niveau :
-- les appels du compte (tous prospecteurs confondus), les appels du seul
-- propriétaire, et les contacts. Les mélanger en une seule jointure
-- multiplierait les lignes et gonflerait les compteurs.
-- ---------------------------------------------------------------------
create or replace view public.v_comptes with (security_invoker = true) as
with par_compte as (
  select a.company_id,
         count(*)                                                as nb_appels,
         max(a.started_at)                                       as dernier_appel_at,
         (array_agg(a.user_name order by a.started_at desc))[1]  as dernier_appel_par,
         array_remove(array_agg(distinct a.situation::text), null::text) as situations
    from public.v_compte_appels a
   group by a.company_id
),
par_proprietaire as (
  select a.company_id,
         o.prospecteur,
         count(*)          as nb_appels_proprietaire,
         max(a.started_at) as dernier_appel_proprietaire_at
    from public.v_compte_appels a
    join public.company_owners o
      on o.jarvi_company_id = a.company_id
     and public.prenom_normalise(a.user_name) = public.prenom_normalise(o.prospecteur)
   group by a.company_id, o.prospecteur
),
par_contact as (
  select company_id,
         prospecteur,
         count(*)                                             as nb_contacts,
         count(*) filter (where appele_par_proprietaire)      as nb_contacts_appeles_par_proprietaire,
         count(*) filter (where nb_appels > 0)                as nb_contacts_appeles_total,
         count(*) filter (where a_echange)                    as nb_contacts_avec_echange
    from public.v_compte_contacts
   group by company_id, prospecteur
)
select c.jarvi_company_id as company_id,
       c.name,
       c.sector,
       c.jarvi_url,
       o.prospecteur,
       coalesce(pc.nb_contacts, 0)                           as nb_contacts,
       coalesce(pc.nb_contacts_appeles_par_proprietaire, 0)  as nb_contacts_appeles_par_proprietaire,
       coalesce(pc.nb_contacts_appeles_total, 0)             as nb_contacts_appeles_total,
       coalesce(pc.nb_contacts_avec_echange, 0)              as nb_contacts_avec_echange,
       coalesce(pp.nb_appels_proprietaire, 0)                as nb_appels_proprietaire,
       pp.dernier_appel_proprietaire_at,
       pa.dernier_appel_at,
       pa.dernier_appel_par,
       coalesce(pa.nb_appels, 0)                             as nb_appels,
       coalesce(pa.situations, '{}'::text[])                 as situations,
       public.situation_chaude(pa.situations)                as situation_chaude,
       c.etat_des_lieux,
       c.etat_des_lieux_at,
       public.seuil_couverture_jours()                       as seuil_jours,
       (current_date - pp.dernier_appel_proprietaire_at::date) as jours_depuis_dernier_appel,
       case
         when pp.dernier_appel_proprietaire_at is null then 'jamais'
         when (current_date - pp.dernier_appel_proprietaire_at::date)
              >= public.seuil_couverture_jours() then 'vieux'
         else 'ok'
       end                                                   as etat
from public.companies c
join public.company_owners o on o.jarvi_company_id = c.jarvi_company_id
left join par_compte pa       on pa.company_id = c.jarvi_company_id
left join par_proprietaire pp on pp.company_id = c.jarvi_company_id
                             and pp.prospecteur = o.prospecteur
left join par_contact pc      on pc.company_id = c.jarvi_company_id
                             and pc.prospecteur = o.prospecteur
where c.archived_at is null;

comment on view public.v_comptes is
  'Une ligne par couple (société × prospecteur). `etat` vaut jamais / '
  'vieux / ok selon les seuls appels du propriétaire. Avec « Toute '
  'l''équipe », un compte partagé doit être dédoublonné sur company_id '
  'côté front (lot Sociétés §4).';

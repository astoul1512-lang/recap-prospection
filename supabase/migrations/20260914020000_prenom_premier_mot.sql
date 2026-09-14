-- =====================================================================
-- Récap prospection — reconnaître un prospecteur quel que soit le nom
--                     sous lequel sa ligne Ringover est enregistrée
--
-- Constaté par Adrien le 14 septembre 2026, sur les vraies données : avec le
-- filtre « Martin », la page affichait **167 comptes attribués et 167 jamais
-- contactés**, alors que vingt comptes portaient une situation. Or une
-- situation ne peut venir que d'un appel résumé : les appels étaient donc bien
-- là, bien rattachés à leurs contacts et à leurs sociétés.
--
-- La seule chose qui séparait les deux compteurs, c'est le rapprochement des
-- personnes. Jarvi nomme le responsable par son prénom — « Martin » — tandis
-- que `ringover_users.display_name` porte le nom tel qu'il a été saisi dans
-- Ringover, qui n'est pas le prénom seul. La comparaison ne trouvait jamais
-- rien, et « aucun appel du propriétaire » s'affiche exactement comme « compte
-- jamais travaillé ».
--
-- C'est la panne que `prenom_normalise` était censée empêcher : elle traitait
-- les accents et la casse, les deux différences qu'on avait imaginées, et
-- laissait passer la seule qui existait vraiment. Une comparaison de noms qui
-- échoue ne lève aucune erreur — elle rend zéro, et zéro est une réponse
-- plausible.
--
-- On compare désormais le **premier mot**, sans accent ni casse. « Martin
-- Benyekkou », « martin.benyekkou@cabinet-ekinox.fr » et « Martin » donnent
-- tous « martin ». C'est suffisant et sans risque à six collaborateurs, dont
-- trois prospecteurs aux prénoms distincts ; le jour où deux personnes
-- partageront un prénom, il faudra une vraie correspondance entre la ligne
-- Ringover et le compte Jarvi — pas une heuristique de plus.
-- =====================================================================

create or replace function public.prenom_normalise(nom text)
returns text language sql immutable parallel safe as $$
  -- L'ordre compte : on retire les accents d'abord, pour que « Rémy » devienne
  -- « remy » avant qu'on ne coupe au premier caractère non alphabétique — sinon
  -- l'accent lui-même servirait de coupure et « Rémy » donnerait « r ».
  select coalesce(
    substring(
      lower(translate(btrim(coalesce(nom, '')),
                      'àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ',
                      'aaaeeeeiioouuucAAAEEEEIIOOUUUC'))
      from '^[a-z]+'),
    '')
$$;

comment on function public.prenom_normalise(text) is
  'Prénom comparable entre Ringover et Jarvi : accents et casse retirés, et '
  'seul le premier mot retenu. « Martin Benyekkou » et « Martin » doivent '
  'désigner la même personne, sans quoi toutes les jauges de couverture '
  'restent à zéro sans lever la moindre erreur.';

# Lot « Sociétés » — piloter la couverture des comptes

Ce lot ajoute à Récap prospection une page **Sociétés** : une ligne par compte attribué à un prospecteur, avec les contacts Jarvi, qui a été joint et quand, et si tous les « opérationnels » ont été appelés. Il embarque aussi deux corrections en attente (§6).

La maquette validée par Adrien est la **proposition B « Registre »** du fichier `design/societes.html` (sélecteur en haut de page). Toute la page doit lui ressembler et se comporter pareil : bandeau de chiffres cliquables, pastilles prospecteur, recherche, tableau trié, fiche à droite. Les propositions A et C sont à ignorer.

Règles inchangées : `CLAUDE.md` (Adrien n'est pas développeur, tu commits et pousses toi-même, `scripts/verifier.sh` avant tout push, SQL d'abord, jamais « en ligne » avant `verifier-en-ligne` vert). Aucune donnée candidat nulle part.

---

## 1. Ce qu'Adrien doit faire dans Jarvi avant (à lui demander en premier, puis attendre)

Deux champs personnalisés n'existent pas encore dans Jarvi ; sans eux la page ne peut pas fonctionner. Guide Adrien pour les créer (Jarvi → Paramètres → Champs personnalisés) :

1. **Sur les sociétés (contexte CRM)** : un champ **« Prospecteur »**, type choix unique, valeurs `Martin`, `Julien`, `Rémy` (ajouter les autres membres si besoin). Un compte sans valeur n'apparaît pas dans la page.
2. **Sur les contacts (contexte CRM)** : un champ **« Opérationnel »**, type oui/non. Coché = personne à joindre absolument. C'est lui qui définit la couverture.

Une fois créés, récupère leurs identifiants avec l'API Jarvi (`getCustomFields`) et mets-les dans `docs/jarvi-champs.md`. Ne code rien en dur avant d'avoir les vrais identifiants.

## 2. Données : deux tables synchronisées depuis Jarvi

Migration `supabase/migrations/<date>_societes.sql` :

- `public.companies` : `jarvi_company_id` (clé), `name`, `sector` (champ « Secteur activité »), `prospecteur` (valeur du champ), `jarvi_url`, `etat_des_lieux text`, `etat_des_lieux_at timestamptz`, `synced_at`.
- `public.contacts` : `jarvi_profile_id` (clé), `company_id` → companies, `name`, `role` (poste tel qu'affiché dans Jarvi, tronqué à 120 car.), `is_operational boolean`, `phone_e164` (jamais affiché en entier côté front, règle §7.1 des specs), `jarvi_url`, `synced_at`.
- RLS identique à `calls` : lecture pour les utilisateurs invités, écriture réservée aux fonctions et à la routine.

Edge function `jarvi-sync` (clé `jarvi`, Deno, idempotente) :
- lit toutes les sociétés CRM dont le champ « Prospecteur » est renseigné, puis leurs contacts associés (`isContact`), avec le champ « Opérationnel » ;
- upsert dans les deux tables ; un contact ou une société disparue de Jarvi est marquée `archived_at`, jamais supprimée ;
- déclenchée par pg_cron chaque jour à 06:00 Paris **et** par un bouton « Resynchroniser Jarvi » sur l'écran d'administration (réutiliser le mécanisme `cron_token` / fonction `admin` existant) ;
- signe chaque passage avec `note_job_run('jarvi_sync', …)` (sociétés lues, contacts lus, erreurs).

Rapprochement appels ↔ contacts : d'abord `calls.jarvi_profile_id` (déjà renseigné par `classify`), sinon `calls.external_number = contacts.phone_e164`. Écrire ce lien dans `calls.contact_id` (nouvelle colonne, nullable) au moment de la synchro et dans `classify` pour les nouveaux appels.

## 3. Les vues qui font le calcul (SQL, pas le front)

- `v_comptes` : une ligne par société non archivée avec `prospecteur`, `nb_contacts`, `nb_operationnels`, `nb_operationnels_joints`, `nb_contacts_joints`, `dernier_appel_at`, `dernier_appel_par`, `situation_chaude` (la plus chaude des dernières situations par contact, ordre `rdv > ouvert > porte > relance > client > direct > besoin > bache`), `nb_appels`, `etat` (`complet` si tous les opérationnels sont joints, `vierge` si aucun appel, sinon `en_cours`).
- `v_compte_contacts` : une ligne par contact avec `dernier_appel_at`, `derniere_situation`, `nb_appels`.
- « Joint » = au moins un appel décroché ≥ 20 s (même règle que le reste de l'app), hors appels `hors_rapport`.

Les cinq chiffres du bandeau se calculent depuis `v_comptes` côté front, pour le filtre prospecteur choisi : comptes attribués · opérationnels à appeler (somme des `nb_operationnels − nb_operationnels_joints`) · comptes jamais entamés · sans appel depuis 3 jours et plus · comptes complets.

## 4. La page « Sociétés » (front, proposition B)

Nouvel onglet **Sociétés** dans la navigation, entre Semaine et À qualifier. Même design Registre, mêmes jetons, même comportement mobile que le reste (sur téléphone, la fiche s'ouvre en plein écran par-dessus la liste, avec un bouton Fermer).

- **Bandeau** : les cinq chiffres ci-dessus ; chacun est un bouton qui filtre le tableau (un second clic enlève le filtre).
- **Pastilles** « Comptes de » : Toute l'équipe + un bouton par prospecteur (valeurs distinctes du champ). Recherche libre sur nom de société et nom de contact.
- **Tableau** : Compte (nom en serif + secteur + nombre de contacts) · Prospecteur · Opérationnels (les points : un par contact, plein = joint, cerclé accent = opérationnel, cerclé clair = autre ; puis « 2/4 joints · 2 à appeler ») · Situation (pastille de la situation la plus chaude) · Dernier appel (date + « il y a N j », ou « jamais » en rouge). En-têtes cliquables : tri « À faire en premier » (défaut : opérationnels restants décroissant, puis ancienneté), Prospecteur, Dernier appel, Nom. Ligne sélectionnée marquée par un filet accent à gauche.
- **Fiche** à droite, collante : nom, secteur, « compte de Julien », N contacts, voyant Complet / En cours 2/4 / Jamais appelé ; trois petits chiffres (opérationnels joints, jours depuis le dernier appel, appels au total) ; bloc **Où on en est** (`etat_des_lieux`, ou « Pas encore d'état des lieux » tant que la routine n'est pas passée) ; bloc **À faire** (opérationnels jamais appelés + les `next_step` des derniers appels) ; **Les contacts** (nom + sigle OP + fonction + pastille de la dernière situation + date ou « jamais appelé » en rouge ; cliquer un contact filtre le fil, second clic enlève le filtre) ; **Le fil des appels** (date heure · collaborateur · pastille · résumé · étape suivante · liens Écouter et Fiche Jarvi).
- Un compte s'ouvre aussi depuis la page Jour : cliquer le nom d'une société dans un appel ouvre sa fiche.
- Rien de nominatif dans l'URL (`#societes` seulement, la sélection reste en mémoire).

## 5. L'état des lieux par société (routine Claude, pas du code)

La colonne `companies.etat_des_lieux` est écrite par la routine « résumés et tags » (Adrien la met à jour côté Claude). Prévoir seulement : la colonne, `etat_des_lieux_at`, et une vue `v_comptes_a_resumer` listant les sociétés dont un appel a été résumé après `etat_des_lieux_at` (ou jamais). Documenter dans `docs/tache-resumes.md` (nouvelle étape : « réécrire l'état des lieux des comptes touchés »).

## 6. Deux corrections en attente, dans le même lot

1. **Locuteurs inversés** : dans les transcriptions stockées, `Collaborateur :` et `Interlocuteur :` sont inversés sur la plupart des appels sortants (c'est le collaborateur Ekinox qui apparaît comme « Interlocuteur »). Corriger l'attribution dans `fetch-transcript` (vérifier avec `direction` et l'identité du canal Ringover), puis re-générer les transcriptions déjà en base.
2. **Hors rapport** : 16 appels portent `tags = ['hors_rapport']` (aucune information entreprise). Créer la colonne `calls.hors_rapport boolean not null default false` (+ `hors_rapport_motif text`), y basculer ces lignes, et exclure ces appels de la page Jour, des colonnes, de « À qualifier », des compteurs de l'entonnoir, de `v_a_resumer` et des vues §3. Les rendre visibles seulement dans un écran d'administration « Écartés du rapport », avec un bouton pour en réintégrer un. `kind_manual` continue de primer.

## 7. Livraison

Ordre : §1 avec Adrien → §6 (rapide, indépendant) → §2 migration + `jarvi-sync` + première synchro → §3 vues → §4 front → §5. Un compte rendu court à Adrien à chaque étape, en français simple. Version incrémentée, `verifier-en-ligne` vert avant d'annoncer quoi que ce soit.

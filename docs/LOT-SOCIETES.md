# Lot « Sociétés » — piloter la couverture des comptes

Ce lot ajoute à Récap prospection une page **Sociétés** : une ligne par compte attribué à un prospecteur, avec les contacts Jarvi, qui a été appelé et quand, ce qui s'est dit, et une phrase « où on en est » écrite par la routine. Il embarque aussi les corrections en attente (§7).

**La maquette validée par Adrien est `design/couverture.html`.** Elle fait foi pour la mise en page, les libellés, les couleurs et les comportements. Elle tourne sur de vraies données au 11 septembre 2026 : 9 sociétés, 139 contacts Jarvi, les appels réels et les 5 résumés réellement produits par la routine. Seules l'attribution aux prospecteurs et la phrase « Où on en est » y sont simulées, faute de la colonne (§6). `design/societes.html` est l'étude précédente, à ignorer.

Règles inchangées : `CLAUDE.md` (Adrien n'est pas développeur, tu commits et pousses toi-même, `scripts/verifier.sh` avant tout push, SQL d'abord, jamais « en ligne » avant `verifier-en-ligne` vert). Aucune donnée candidat nulle part, rien de nominatif dans les URL.

---

## 1. Rien à créer dans Jarvi

La version initiale du lot demandait un champ personnalisé « Prospecteur » sur les sociétés. **Abandonné** : Jarvi porte déjà un **responsable** natif sur la fiche société (`assignees`), déjà renseigné, qui dit exactement la même chose. Vérification et raisons dans `docs/decisions.md` **D9**.

- Le **prospecteur d'un compte = son responsable dans Jarvi**, à condition que ce responsable soit **Martin, Rémy ou Adrien**. Les comptes d'Alexandre (918) et de Julien (513), qui ne prospectent pas, n'entrent pas dans la page — sans ce filtre elle afficherait 1 971 sociétés au lieu d'environ 665.
- Une société **sans responsable n'apparaît pas** dans la page.
- Une société à **plusieurs responsables apparaît dans la liste de chacun** : `v_comptes` est une ligne par couple *(société × prospecteur)*, et la couverture se calcule pour chacun avec ses propres appels.
- Pas de champ « Opérationnel » non plus : Adrien appelle « opérationnels » l'ensemble des contacts rattachés à la société dans Jarvi. Tous comptent.

Champs et identifiants dans `docs/jarvi-champs.md` — jamais d'identifiant en dur ailleurs.

## 2. Les règles métier, à appliquer en SQL et nulle part ailleurs

Ces quatre règles ont été arbitrées par Adrien. Elles sont le cœur du lot ; tout le reste n'est que de l'affichage.

1. **« Appelé » = au moins un appel tenté.** Décroché ou non, long ou court. Un numéro composé compte comme un contact travaillé. (C'est différent du reste de l'app, où « échange » suppose un décroché ≥ 20 s — ici on mesure l'effort de prospection, pas le résultat.)
2. **Le compteur de couverture ne compte que les appels du propriétaire du compte.** Si Rémy appelle un contact d'un compte attribué à Martin, la jauge de Martin ne bouge pas. L'appel de Rémy reste visible (colonne « Dernier appel », groupe « Appelés par quelqu'un d'autre » dans la fiche), mais il ne crédite pas Martin.
3. **Le périmètre des appels** : les appels de prospection non écartés du rapport (`coalesce(kind_manual, kind) = 'prospection'` et `not hors_rapport`). Les tentatives sans décroché sont **incluses** — elles n'ont pas de résumé, c'est normal, la page affiche « Pas de décroché ».
4. **Seuil d'alerte : 14 jours.** Un compte dont le propriétaire n'a passé aucun appel depuis 14 jours ou plus passe en orange. Valeur à mettre dans une constante SQL unique, pas dispersée dans le front.

## 3. Données : deux tables synchronisées depuis Jarvi

Migration `supabase/migrations/<date>_societes.sql` :

- `public.companies` : `jarvi_company_id` (clé), `name`, `sector` (champ « Secteur activité »), `jarvi_url`, `etat_des_lieux text`, `etat_des_lieux_at timestamptz`, `archived_at`, `synced_at`.
- `public.company_owners` : `company_id` → companies, `prospecteur text` (prénom du responsable Jarvi), clé primaire sur le couple. Une ligne par responsable — c'est ce qui permet à un compte partagé d'apparaître chez chacun (§1).
- `public.contacts` : `jarvi_profile_id` (clé), `company_id` → companies, `name`, `role` (poste tel qu'affiché dans Jarvi, tronqué à 120 caractères), `phone_e164` (jamais affiché en entier côté front), `jarvi_url`, `archived_at`, `synced_at`.
- RLS identique à `calls` : lecture pour les utilisateurs invités, écriture réservée aux fonctions et à la routine.

Edge function `jarvi-sync` (secret `jarvi`, Deno, idempotente) :

- lit toutes les sociétés CRM ayant au moins un responsable, puis leurs contacts associés (`isContact`) ;
- upsert dans les trois tables ; une société, un responsable ou un contact disparu de Jarvi est marqué `archived_at` (ou retiré de `company_owners`), jamais supprimé ;
- déclenchée par pg_cron chaque jour à 06:00 Paris **et** par un bouton « Resynchroniser Jarvi » sur l'écran d'administration (réutiliser le mécanisme `cron_token` / fonction `admin` existant) ;
- signe chaque passage avec `note_job_run('jarvi_sync', …)` : sociétés lues, contacts lus, erreurs.

**Rapprochement appels ↔ contacts** : d'abord `calls.jarvi_profile_id` (déjà renseigné par `classify`), sinon `calls.external_number = contacts.phone_e164`. Écrire le lien dans `calls.contact_id` (nouvelle colonne, nullable) au moment de la synchro et dans `classify` pour les nouveaux appels.

## 4. Les vues qui font le calcul

- **`v_compte_appels`** : un appel par ligne, filtré selon la règle §2.3, avec `company_id`, `contact_id`, `day`, `started_at`, `user_name` (le collaborateur), `situation`, `summary`, `next_step`, `record_link`, et `echange boolean` (= `situation is not null`).
- **`v_compte_contacts`** : un contact par ligne **et par prospecteur du compte**, avec `nb_appels`, `dernier_appel_at`, `dernier_appel_par`, `derniere_situation`, `appele_par_proprietaire boolean`.
- **`v_comptes`** : une ligne par couple *(société non archivée × prospecteur)*, avec `prospecteur`, `nb_contacts`, `nb_contacts_appeles_par_proprietaire`, `nb_contacts_appeles_total`, `nb_contacts_avec_echange`, `dernier_appel_proprietaire_at`, `dernier_appel_at`, `dernier_appel_par`, `nb_appels`, `situations text[]` (toutes les situations rencontrées sur le compte), `situation_chaude`, `etat_des_lieux`, `etat_des_lieux_at`, et `etat` :
  - `jamais` — le propriétaire n'a jamais appelé un seul contact ;
  - `vieux` — son dernier appel date de 14 jours ou plus ;
  - `ok` — sinon.
- **`situation_chaude`** = la plus chaude des situations du compte, dans l'ordre `rdv > ouvert > porte > relance > client > direct > besoin > bache`.

Les cinq chiffres du bandeau se calculent depuis `v_comptes` côté front, pour le prospecteur sélectionné :
comptes attribués · jamais contactés par leur prospecteur · sans appel depuis 14 j et plus · contacts jamais appelés (somme de `nb_contacts − nb_contacts_appeles_par_proprietaire`) · comptes avec un échange.

Avec « Toute l'équipe », un compte partagé est compté **une fois** dans « comptes attribués » — dédoublonner sur `company_id`.

## 5. La page « Sociétés »

Nouvel onglet **Sociétés** dans la navigation, entre Semaine et À qualifier. Même design Registre, mêmes jetons, même comportement mobile que le reste (sur téléphone, la fiche s'ouvre en plein écran par-dessus la liste, avec un bouton Fermer). URL : `#societes`, rien de nominatif dedans, la sélection reste en mémoire.

**Barre d'outils, deux lignes** (voir maquette) :

1. « Comptes de » : Toute l'équipe + un bouton par prospecteur (responsables distincts réellement présents dans les données) · recherche libre sur nom de société et nom de contact.
2. « Situation » : Toutes + une pastille par situation, **avec le nombre de comptes concernés**, + « Aucun échange ». Une pastille à zéro est grisée et non cliquable. Un second clic sur une pastille active enlève le filtre. Ce filtre se combine avec le filtre prospecteur et avec les chiffres du bandeau.

**Bandeau** : les cinq chiffres du §4 ; chacun est un bouton qui filtre le tableau, un second clic enlève le filtre.

**Tableau**, cinq colonnes :

| Colonne | Contenu |
|---|---|
| Compte | nom en serif · secteur · **la phrase « où on en est » sur une ligne tronquée**, en italique, `title=` la phrase entière |
| Prospecteur | le responsable Jarvi (tous, si le compte est partagé) |
| Contacts appelés | jauge (rouge pleine si zéro) + « 4/13 contacts appelés » — **appelés par le propriétaire** |
| Dernier appel du prospecteur | « il y a N j » + date ; si jamais : **jamais** en rouge, et en dessous « Rémy y est allé le 11 sept. » quand quelqu'un d'autre est passé |
| Situation | pastille de la situation la plus chaude, ou « — » |

En-têtes cliquables : tri « À faire en premier » (défaut : `jamais` puis `vieux` puis `ok`, et à l'intérieur le plus de contacts restants d'abord), Prospecteur, Dernier appel, Nom. Ligne sélectionnée marquée par un filet accent à gauche.

**Fiche**, à droite, collante, **fermée par défaut** — le tableau occupe toute la largeur ; un clic sur une ligne l'ouvre, le × / la touche Échap / un nouveau clic sur la ligne la referment. De haut en bas :

1. Nom, secteur, « compte de Martin », nombre de contacts dans Jarvi.
2. **Où on en est** : la phrase de la routine dans un encadré accent, signée « réécrit par la routine le 11 sept. à 18h05 ». Tant que la routine n'est pas passée : « Pas encore d'état des lieux ».
3. Trois chiffres : contacts appelés par le propriétaire (sur le total), jours depuis son dernier appel, contacts avec un échange.
4. **Les contacts**, avec un champ de filtre par nom ou fonction, en trois groupes comptés : **Appelés par {prospecteur}** · **Appelés par quelqu'un d'autre** · **Jamais appelés** (ce dernier en rouge).
5. Sous chaque contact appelé, **le fil de ses appels** : pour chacun, date · collaborateur · pastille de situation (ou « Pas de décroché » en gris quand il n'y a pas eu d'échange) · le résumé · « À faire : » + `next_step` quand il existe. Les résumés sont ceux déjà produits par la routine, pas de nouveau calcul. Ajouter le lien « Écouter » (`record_link`) et « Fiche Jarvi » sur chaque ligne d'appel.

Un compte s'ouvre aussi depuis la page Jour : cliquer le nom d'une société dans un appel ouvre sa fiche.

## 6. L'état des lieux par société (écrit par la routine, pas par du code)

`companies.etat_des_lieux` est une phrase courte (deux phrases maximum, ~300 caractères) écrite par la routine « résumés et tags », dans la langue de l'app, factuelle : où en est la prospection du compte, ce qui bloque, ce qui reste à faire. Exemples réels produits pour la maquette :

> « Deux passages de Rémy (4 et 11 sept.) sur les quatre mêmes profils techniques, aucun décroché : le compte n'a encore produit aucun échange. Les fonctions RH et produit n'ont jamais été tentées. »

> « Deux salariés joints le 11 sept. : Hello Watt ne passe pas par des cabinets (job boards et cooptation) et ne recrute que des seniors. Le seul angle restant est Thibaud Halpern, côté RH, jamais appelé. »

La phrase porte sur **la société**, pas sur un prospecteur : un compte partagé a un seul état des lieux.

Côté code, prévoir seulement : les deux colonnes, et une vue **`v_comptes_a_resumer`** listant les sociétés dont un appel a été résumé après `etat_des_lieux_at` (ou dont `etat_des_lieux_at` est nul). Documenter la nouvelle étape dans `docs/tache-resumes.md` ; c'est Adrien qui met à jour le mode d'emploi de la routine côté Claude une fois la colonne livrée.

## 7. Les corrections en attente, dans le même lot

1. **Locuteurs inversés** : corrigé dans `fetch-transcript`, transcriptions déjà en base rattrapées (migration `20260905080000`, décision D8). **Reste** : les résumés rédigés avant la correction reposent sur une transcription inversée — les remettre en file.
2. **Hors rapport** : fait (colonne, exclusion partout, écran « Écartés du rapport » et réintégration). **Reste** : penser l'exclusion dans les vues du §4.
3. **Plus rien n'attend un humain sans raison.** Règle métier d'Adrien : un appel remonte dans le rapport seulement s'il y a eu un échange **et** que le numéro est dans la partie CRM de Jarvi ; sinon il est hors rapport. La routine applique déjà cette règle à chaque passage ; il faut la porter dans `classify` et dans une tâche pg_cron pour qu'elle ne dépende plus de Claude :
   - appel décroché de **moins de 20 s** → `outcome = 'tentative'`, `needs_review = false`, jamais dans « À qualifier » ;
   - numéro **absent de Jarvi** (`kind = 'inconnu'`) : revérification Jarvi automatique 24 h puis 72 h après l'appel ; toujours absent → `hors_rapport = true`, `hors_rapport_motif = 'numéro inconnu'`, `needs_review = false` ; trouvé côté ATS → `kind = 'hors_prospection'` ; trouvé côté CRM → `kind = 'prospection'` et la chaîne transcription → routine reprend ;
   - `fetch-transcript` : élargir la fenêtre de récupération de 7 à 14 jours, pour qu'un numéro requalifié tardivement ait encore sa transcription.

   « À qualifier » ne doit plus contenir que les appels que la routine a explicitement laissés à un humain. Le bouton « Revérifier dans Jarvi » reste, pour forcer une vérification.

⚠️ Rappel : la routine n'écrit **jamais** `kind_manual` ni `outcome_manual` (réservés à l'humain, ils priment), et `review_reason` n'accepte que `'inconnu'` ou `'court'` — jamais de texte libre.

## 8. Livraison

Ordre : §7 (rapide, indépendant) → §3 migration + `jarvi-sync` + première synchro → §4 vues → §5 front → §6. Un compte rendu court à Adrien à chaque étape, en français simple. Version incrémentée, `verifier-en-ligne` vert avant d'annoncer quoi que ce soit.

**Point de vigilance mesuré sur les vraies données** : sur les 9 comptes de la maquette, 5 appels seulement ont produit un échange, sur une quarantaine d'appels. La page doit rester lisible quand presque tout est « Pas de décroché » — c'est le cas nominal, pas un cas d'erreur.

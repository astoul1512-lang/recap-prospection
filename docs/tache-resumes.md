# La tâche planifiée qui écrit les résumés et pose les tags

Pourquoi une tâche planifiée plutôt qu'une fonction serveur : `docs/decisions.md`,
décision D1. Pourquoi elle qualifie aussi les appels courts : décision D6.
Ce document-ci est son mode d'emploi.

Elle tourne **deux fois par jour, à 12 h 40 et à 20 h**, du lundi au vendredi.
Le passage de midi traite la matinée ; celui du soir rattrape tout ce que Modjo
n'avait pas encore indexé.

## Ce qu'elle fait à chaque passage

1. **Demander le travail à faire.** La base expose une vue qui ne contient que
   ce qui l'attend, et rien d'autre :

   ```sql
   select * from public.v_a_resumer order by started_at desc;
   ```

   La vue filtre déjà : prospection confirmée par Jarvi, décroché, vingt
   secondes au moins, **sept derniers jours**, et aucun appel qu'un humain a
   déjà touché. Deux colonnes disent ce qu'on attend : `sans_resume` (il manque
   le résumé) et `needs_review` (il manque le tag). Souvent les deux.

2. **Récupérer la conversation dans Modjo**, par le connecteur Modjo :
   rapprochement sur le numéro (`external_number`) et l'heure de début
   (`started_at`, à trois minutes près).

   Modjo renvoie déjà un résumé rédigé : il suffit le plus souvent. La
   transcription complète ne sert qu'aux cas où ce résumé est trop vague pour
   trancher.

3. **Rédiger**, dans les formes du récap :
   - `summary` : 600 caractères maximum, cinq lignes au plus, en français, des
     faits seulement — jamais une impression, jamais une extrapolation ;
   - `next_step` : 160 caractères maximum, à l'impératif, une action concrète,
     datée si c'est une relance.

   Nommer le décideur et le besoin quand ils sont dits. **Ne jamais mentionner
   un candidat** : le rapport de prospection ne parle que de clients.

4. **Poser le tag** — une seule situation, et l'issue qui va avec :

   | Ce que dit la conversation | `situation` | `outcome` |
   |---|---|---|
   | Rendez-vous pris ou accepté | `rdv` | `rdv` |
   | Décideur ouvert, besoin à venir | `ouvert` | `conversation` |
   | Il nomme la bonne personne à appeler | `porte` | `conversation` |
   | Client actif, point d'étape | `client` | `conversation` |
   | Recrute en direct, pas de cabinet | `direct` | `conversation` |
   | Pas de besoin, déjà couvert | `besoin` | `conversation` |
   | Demande à être rappelé plus tard | `relance` | `conversation` |
   | Refus sec, sans échange | `bache` | `bache` |
   | Rien : erreur de numéro, mise en attente, standard | *aucune* | `tentative` |

   La dernière ligne compte autant que les autres : un appel où il ne s'est
   rien passé doit sortir de la file, avec une phrase qui le dit.

   **Le droit de ne pas trancher est une règle, pas une échappatoire.** Devant
   une conversation ambiguë : écrire le résumé, ne pas toucher au tag, ne pas
   toucher à `needs_review`. L'appel reste dans la file pour un humain. Mieux
   vaut une question posée qu'un tag inventé.

5. **Réécrire dans la base**, appel par appel :

   ```sql
   update public.calls
      set summary = $r$…$r$, next_step = $e$…$e$,
          situation = '…', outcome = '…',
          needs_review = false, review_reason = null,
          transcript_source = 'modjo'
    where call_id = '…';
   ```

   Guillemet-dollar obligatoire pour les textes : les résumés contiennent des
   apostrophes. `needs_review = false` seulement si le tag a été tranché.

   **Jamais dans `kind_manual` ni `outcome_manual`** : ces deux colonnes sont
   réservées aux humains, et ce sont elles qui priment sur la tâche.

6. **Signer son passage** — c'est la partie qu'on est tenté de sauter, et c'est
   la plus importante :

   ```sql
   select public.note_job_run('resumes', jsonb_build_object(
     'traites', <appels résumés>,
     'qualifies', <appels sortis de la file>,
     'laisses_en_file', <appels non tranchés>,
     'sans_transcription', <appels absents de Modjo>,
     'passage', 'midi' | 'soir'));
   ```

   L'écran d'administration affiche cette date. Sans elle, une tâche morte
   ressemble à une journée sans travail à faire.

## Les quatre règles à ne pas contourner

1. **Interroger « ce qui manque », pas « ce qui date d'hier ».** La fenêtre de
   sept jours de `v_a_resumer` fait qu'une journée manquée est rattrapée le
   lendemain, et qu'une panne de trois jours se répare sans intervention. Ne
   jamais remplacer ce critère par une date.
2. **Ne jamais écraser une correction humaine.** La vue les exclut déjà ; ne
   pas la court-circuiter par une requête directe sur `calls`.
3. **Ne traiter que ce qui le mérite.** La vue s'en charge : prospection,
   décroché, vingt secondes au moins.
4. **Rendre l'échec visible.** Signer chaque passage (point 6), y compris un
   passage qui n'a rien trouvé à faire.

## Quand un appel n'est pas dans Modjo

Ne rien écrire. L'appel gardera l'étiquette « Résumé à compléter » dans
l'application — ce qui est exact — et repassera dans la vue les jours suivants,
au cas où Modjo l'indexerait plus tard. Après sept jours il en sortira de
lui-même.

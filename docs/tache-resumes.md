# La tâche planifiée qui écrit les résumés

Pourquoi une tâche planifiée plutôt qu'une fonction serveur : `docs/decisions.md`,
décision D1. Ce document-ci est son mode d'emploi — à donner tel quel à la tâche
Claude qui tourne chaque soir.

## Ce qu'elle fait, une fois par soir

1. **Demander le travail à faire.** La base expose une vue qui ne contient que
   ce qui mérite un résumé, et rien d'autre :

   ```sql
   select * from public.v_a_resumer order by started_at desc;
   ```

   La vue filtre déjà : prospection, décroché, une minute au moins, pas encore
   de résumé, **sept derniers jours**, et aucun champ touché par un humain.

2. **Récupérer la conversation dans Modjo**, par le connecteur Modjo :
   rapprochement sur le numéro (`external_number`) et l'heure de début
   (`started_at`, à trois minutes près).

3. **Rédiger**, dans les formes du récap :
   - `summary` : 600 caractères maximum, cinq lignes au plus, en français, des
     faits seulement — jamais une impression, jamais une extrapolation ;
   - `situation` : **une seule** valeur parmi `rdv`, `ouvert`, `porte`,
     `client`, `direct`, `besoin`, `relance`, `bache` (définitions dans
     `SPECS.md` §1.3) ;
   - `next_step` : 160 caractères maximum, à l'impératif, une action concrète,
     datée si c'est une relance.

   Nommer le décideur et le besoin quand ils sont dits. **Ne jamais mentionner
   un candidat** : le rapport de prospection ne parle que de clients.

4. **Réécrire dans la base**, appel par appel :

   ```sql
   update public.calls
      set summary = $1, situation = $2, next_step = $3,
          transcript_source = 'modjo'
    where call_id = $4;
   -- si la situation vaut 'rdv', poser aussi outcome = 'rdv'
   ```

5. **Signer son passage** — c'est la partie qu'on est tenté de sauter, et c'est
   la plus importante :

   ```sql
   select public.note_job_run('resumes', jsonb_build_object(
     'traites', <nombre d'appels résumés>,
     'sans_transcription', <nombre d'appels non trouvés dans Modjo>));
   ```

   L'écran d'administration affiche cette date. Sans elle, une tâche morte
   ressemble à une journée sans appels à résumer.

## Les quatre règles à ne pas contourner

1. **Interroger « sans résumé », pas « d'hier ».** La fenêtre de sept jours de
   `v_a_resumer` fait qu'une journée manquée est rattrapée le lendemain, et
   qu'une panne de trois jours se répare sans intervention. Ne jamais remplacer
   ce critère par une date.
2. **Ne jamais écraser une correction humaine.** La vue les exclut déjà ; ne
   pas la court-circuiter par une requête directe sur `calls`.
3. **Ne résumer que ce qui le mérite.** La vue s'en charge : prospection,
   décroché, une minute au moins.
4. **Rendre l'échec visible.** Signer chaque passage (point 5), y compris un
   passage qui n'a rien trouvé à faire.

## Quand un appel n'est pas dans Modjo

Ne rien écrire. L'appel gardera l'étiquette « Résumé à compléter » dans
l'application — ce qui est exact — et repassera dans la vue les jours suivants,
au cas où Modjo l'indexerait plus tard. Après sept jours il en sortira de
lui-même.

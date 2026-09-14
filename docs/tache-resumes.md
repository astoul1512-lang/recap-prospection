# La routine qui écrit les résumés et pose les tags

Pourquoi une routine planifiée plutôt qu'une fonction serveur :
`docs/decisions.md`, décision D1. Pourquoi elle qualifie aussi les appels
courts : D6. D'où vient la transcription : **D7**.

Elle tourne **deux fois par jour, à 12 h 45 et à 20 h**, du lundi au vendredi,
et elle est créée dans l'application Claude par Adrien.

**Elle n'a besoin que du connecteur Supabase.** Tout ce qu'elle lit est en
base : plus de clé d'API, plus de rapprochement de numéros, plus de Modjo. Le
texte des appels y est déposé toutes les dix minutes par la fonction
`fetch-transcript`.

---

## 1. Demander le travail à faire

```sql
select call_id, day, started_at, duration_s, direction,
       company_name, contact_name, contact_role, user_name,
       needs_review, review_reason, sans_resume, transcript
from public.v_a_resumer
order by started_at desc
limit 40;
```

La vue filtre déjà tout, et c'est elle qui protège le travail de l'équipe :

- appels de prospection confirmés par le CRM, décrochés, vingt secondes au
  moins ;
- **qui ont leur transcription** — sans texte il n'y a rien à résumer ;
- sept derniers jours ;
- **aucun appel qu'un humain a déjà touché**, ni par la file, ni en corrigeant
  un champ.

Ne jamais la court-circuiter par une requête directe sur `public.calls`.

Deux colonnes disent ce qu'on attend : `sans_resume` (il manque le résumé) et
`needs_review` (il manque le tag). Souvent les deux.

S'il n'y a aucune ligne, passer directement à l'étape 3.

## 2. Rédiger, taguer, écrire

La colonne `transcript` contient l'échange, une réplique par ligne, préfixée
par `Collaborateur :` (Ekinox) ou `Interlocuteur :` (le prospect). Ces
étiquettes tiennent compte du sens de l'appel — c'est le collaborateur qui
compose sur un sortant, le prospect qui appelle sur un entrant.

**Le résumé.**

- `summary` : 600 caractères maximum, cinq lignes au plus, en français, **des
  faits seulement**. Jamais une impression, jamais une extrapolation. Nommer le
  décideur et le besoin quand ils sont dits. Dater les relances.
- `next_step` : 160 caractères maximum, à l'impératif, une action concrète.
  Vide s'il n'y a rien à faire.

**Interdit absolu : ne jamais mentionner un candidat.** Ce rapport ne parle que
de clients et de prospects. Si la conversation évoque des candidats, n'en
retenir que ce qui concerne le besoin du client.

**Le tag** — une seule situation, et l'issue qui va avec :

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

La dernière ligne compte autant que les autres : un appel où il ne s'est rien
passé doit sortir de la file, avec une phrase qui le dit.

**Et le cas qui n'est pas dans le tableau : l'appel n'a rien à faire dans le
rapport.** Une discussion interne, un rappel personnel, un échange sans aucun
contenu commercial — même quand Jarvi connaît le numéro. Il y a une colonne
pour ça :

```sql
update public.calls
   set hors_rapport = true,
       hors_rapport_motif = $m$…en une phrase, pourquoi…$m$,
       summary = $r$…le résumé de ce qui s'est dit…$r$,
       needs_review = false, review_reason = null
 where call_id = '…';
```

**Le motif n'est pas facultatif.** Un appel qui disparaît du rapport sans
justification est une décision qu'on ne peut pas discuter. Il s'affiche tel quel
sur l'écran d'administration, section « Écartés du rapport », où un
administrateur peut remettre l'appel dans le rapport d'un clic.

Ne jamais l'écrire dans `tags` : ce tableau est réservé aux étiquettes posées
dans Ringover. Un appel `hors_rapport` disparaît de la page du jour, des
colonnes, de la file, des compteurs et de ce plan de travail.

**Le droit de ne pas trancher est une règle, pas une échappatoire.** Devant une
conversation ambiguë : écrire le résumé, ne pas toucher au tag, ne pas toucher
à `needs_review`. L'appel reste dans la file pour un humain. Mieux vaut une
question posée qu'un tag inventé.

**L'écriture**, un appel à la fois :

```sql
update public.calls
   set summary = $r$…$r$,
       next_step = $e$…$e$,
       situation = '…',          -- omettre la ligne si aucune situation
       outcome = '…',
       needs_review = false,     -- seulement si le tag a été tranché
       review_reason = null,
       transcript_source = 'ringover_api'
 where call_id = '…';
```

Guillemet-dollar obligatoire pour les textes : les résumés contiennent des
apostrophes, et une apostrophe non échappée casse la requête.

**Jamais dans `kind_manual` ni `outcome_manual`** : ces deux colonnes sont
réservées aux humains, et ce sont elles qui priment sur la routine.

## 3. L'état des lieux des comptes

La page **Sociétés** montre, pour chaque compte attribué à Martin, Rémy ou
Adrien, une phrase qui dit où en est la prospection. Cette phrase n'est
calculable par aucune requête : elle demande de relire les résumés du compte
et d'en tirer le sens. C'est donc la routine qui l'écrit, au même passage.

Demander la liste :

```sql
select jarvi_company_id, name, etat_des_lieux, etat_des_lieux_at,
       dernier_appel_resume_at, nb_appels_resumes
from public.v_comptes_a_resumer
order by dernier_appel_resume_at desc
limit 15;
```

La vue ne renvoie que les comptes dont **un appel a été résumé depuis la
dernière rédaction** — ou qui n'en ont jamais eu. Même principe que
`v_a_resumer` : on demande ce qui manque, jamais ce qui date d'hier.

Pour chaque compte, relire ce qu'on sait de lui :

```sql
select ct.name as contact, ct.role, a.started_at, a.user_name,
       a.situation, a.summary, a.next_step, a.echange
from public.v_compte_appels a
join public.contacts ct on ct.jarvi_profile_id = a.contact_id
where a.company_id = '…'
order by a.started_at desc;
```

Puis écrire :

```sql
update public.companies
   set etat_des_lieux = $e$…$e$,
       etat_des_lieux_at = now()
 where jarvi_company_id = '…';
```

**La phrase porte sur la société, pas sur un prospecteur** : un compte partagé
entre deux responsables n'a qu'un seul état des lieux. Deux phrases au plus,
environ 300 caractères, factuelles : où en est la prospection, ce qui bloque,
ce qui reste à tenter. Nommer les fonctions jamais appelées quand c'est le
point saillant — c'est l'information qui fait agir.

Deux exemples réels :

> « Deux passages de Rémy (4 et 11 sept.) sur les quatre mêmes profils
> techniques, aucun décroché : le compte n'a encore produit aucun échange. Les
> fonctions RH et produit n'ont jamais été tentées. »

> « Deux salariés joints le 11 sept. : Hello Watt ne passe pas par des cabinets
> (job boards et cooptation) et ne recrute que des seniors. Le seul angle
> restant est Thibaud Halpern, côté RH, jamais appelé. »

Les mêmes interdits qu'au résumé : aucun candidat, aucune impression, rien qui
ne soit dans les résumés relus.

## 4. Signer le passage — ne jamais sauter cette étape

```sql
select public.note_job_run('resumes', jsonb_build_object(
  'traites', <appels résumés>,
  'qualifies', <appels sortis de la file>,
  'laisses_en_file', <appels non tranchés>,
  'candidats', <lignes renvoyées par la vue>,
  'etats_des_lieux', <comptes réécrits à l'étape 3>,
  'passage', 'midi'));          -- ou 'soir'
```

L'écran d'administration affiche cette date. Sans elle, une routine morte
ressemble à une journée sans travail à faire.

## 5. Rendre compte

Un compte rendu court, en français simple, sans jargon : combien d'appels
résumés, combien qualifiés, combien laissés à l'équipe et pourquoi, combien
d'états des lieux réécrits. Signaler
tout ce qui paraît anormal — une transcription vide, une situation impossible à
trancher, un appel qui revient à chaque passage.

---

## Les quatre règles à ne pas contourner

1. **Interroger « ce qui manque », pas « ce qui date d'hier ».** La fenêtre de
   quatorze jours de `v_a_resumer` fait qu'une journée manquée est rattrapée le
   lendemain, et qu'une panne d'une semaine se répare sans intervention. Ne
   jamais remplacer ce critère par une date. (Elle est passée de sept à
   quatorze jours le 13 septembre 2026 : un numéro requalifié en prospection
   trois jours après l'appel doit avoir le temps d'obtenir sa transcription
   puis son résumé — voir `docs/decisions.md` D10.)
2. **Ne jamais écraser une correction humaine.** La vue les exclut déjà ; ne
   pas la court-circuiter.
3. **Ne traiter que ce qui a une transcription.** La vue s'en charge. Sans
   texte, résumer revient à inventer.
4. **Rendre l'échec visible.** Signer chaque passage, y compris un passage qui
   n'a rien trouvé à faire.

## Quand un appel n'a pas de transcription

Il n'apparaît pas dans `v_a_resumer` — il n'y a donc rien à faire. Il porte
l'étiquette « Transcription en attente » dans l'application, et l'écran
d'administration en donne le compte. Si ce nombre ne descend jamais, c'est la
fonction `fetch-transcript` qu'il faut regarder, pas la routine.

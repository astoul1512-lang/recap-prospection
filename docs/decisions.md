# Décisions d'architecture

Les écarts assumés par rapport à `SPECS.md`, avec leur raison. À relire avant de
« corriger » quelque chose qui semble manquant : c'est peut-être délibéré.

---

## D1 — Pas de mise en forme des résumés par l'API Anthropic

**Décidé le 4 septembre 2026, par Adrien.**

### Ce que dit la spécification

`SPECS.md` §5.3 et §6.4 prévoient une fonction `summarize` qui appelle l'API
Anthropic (secret `anthropic`, modèle de classe Haiku) pour transformer la
transcription Modjo en `{summary, situation, next_step}`.

### Ce qui est fait à la place

**Une tâche Claude planifiée**, exécutée chaque soir sur l'abonnement d'Adrien,
via les connecteurs Modjo et Supabase déjà en place :

1. elle demande à la base les appels **sans résumé** des 7 derniers jours,
   filtrés sur `kind_eff = prospection`, `status = answered`, `duration_s ≥ 60` ;
2. elle récupère la transcription dans Modjo ;
3. elle rédige le résumé, choisit la situation, propose l'étape suivante ;
4. elle réécrit le tout dans Supabase.

Aucune fonction `summarize` côté serveur, aucun secret `anthropic`.

### Pourquoi

Modjo produit **déjà** un résumé, et Adrien le paie déjà. L'appel Anthropic ne
rédigeait pas : il remettait en forme. Payer une seconde IA pour reformater la
première n'a pas paru justifié — environ 3,50 $ par mois pour du confort de
présentation, sur un projet dont tout le reste est gratuit.

La valeur du projet ne tient pas là : elle tient à ce que les appels arrivent
seuls, soient classés prospection ou non, et que l'entonnoir soit juste. Tout
cela reste automatique et immédiat.

### Ce que ça coûte

Les résumés arrivent **le lendemain matin**, pas cinq minutes après l'appel. Les
paliers T+5 / T+15 / T+60 de `SPECS.md` §5.3 n'ont plus d'objet.

### Les quatre règles qui rendent ce choix tenable

Sans elles, une tâche planifiée est fragile. Avec elles, elle se répare seule.

1. **Interroger « sans résumé », pas « d'hier ».** Une fenêtre de 7 jours fait
   qu'une journée manquée est rattrapée automatiquement le lendemain. Une panne
   de trois jours se répare sans intervention. C'est la règle la plus importante
   du lot.
2. **Ne jamais écraser une correction humaine.** Si un membre a réécrit un
   résumé ou changé la situation, la tâche passe son chemin — la table
   `corrections` en garde la trace. Règle non négociable de `SPECS.md` §1.1.6.
3. **Ne résumer que ce qui le mérite.** Prospection, décroché, ≥ 60 s. Ni
   messageries, ni appels courts, ni appels internes.
4. **Rendre l'échec visible.** C'était la seule vraie objection à cette
   solution : une tâche qui cesse de tourner ne prévient personne, et l'absence
   de résumés se confond avec l'absence d'appels à résumer. Deux témoins :
   l'étiquette **« Résumé à compléter »** sur chaque appel concerné (déjà prévue
   par `SPECS.md` §1.3), et la **date du dernier remplissage** sur l'écran
   d'administration.

### Réversible

La mise en forme est traitée comme un emplacement vide, pas comme un rouage
manquant : l'application fonctionne sans elle. Y brancher plus tard l'API
Anthropic (résumés en 5 minutes, ~3,50 $/mois) est un ajout, pas une refonte.

### Conséquences sur `SPECS.md`

| Point | Statut |
|---|---|
| §5.3 `summarize` (fonction serveur) | **abandonnée** |
| §6.4 Anthropic Messages API | **abandonné** |
| Secret `anthropic` | **inutile** |
| §5.3.1 recherche Modjo par numéro + fenêtre ± 3 min | reporté à la tâche planifiée |
| §5.4.4 nouvelle tentative Modjo la nuit | sans objet (la fenêtre de 7 jours la remplace) |
| Colonne `summarize_attempts` | conservée, non utilisée pour l'instant |
| `transcript_source` | conservée : `modjo` ou `aucune` |

---

## D2 — Le jeton des tâches planifiées vit dans la base, pas dans un secret

**Décidé le 4 septembre 2026.**

### Ce que dit la spécification

`SPECS.md` §3.1 et §9.1 prévoient un secret `cron_token` créé à la main dans
Supabase, **et** la même valeur recopiée en base
(`alter database postgres set app.cron_token = '…'`). pg_cron l'envoie, la
fonction le compare à son secret.

### Ce qui est fait à la place

La valeur n'existe qu'à un seul endroit : une table `private.config`, illisible
depuis l'application, où **la base la tire au sort elle-même** au moment de la
migration. pg_cron l'y lit pour l'envoyer, la fonction demande à la base « ce
jeton est-il le bon ? » et n'obtient qu'un oui ou un non. Aucun secret
`cron_token` à créer dans Supabase, rien à recopier, rien à retenir.

### Pourquoi

Une valeur recopiée à deux endroits finit par être désynchronisée — et le jour
où elle l'est, les tâches planifiées s'arrêtent en silence, ce qui est
précisément le mode de panne le plus difficile à voir. Une seule source, pas de
recopie, pas de manipulation demandée à Adrien.

### Le détail qui coince, et sa réponse

Le portail Supabase exige un jeton valide **avant** d'atteindre la fonction
(`verify_jwt = true`, contrôle n°8 du vérificateur, qu'on ne contourne pas).
pg_cron envoie donc la **clé publique du projet** — celle que le site porte
déjà, qui ne donne aucun droit — pour passer la porte. Ce qui fait autorité
ensuite, c'est le jeton de tâche.

### Ce que ça coûte

Une requête de plus par exécution planifiée, quelques millisecondes. Rien
d'autre : une base reconstruite de zéro retire un nouveau jeton toute seule.

---

## D3 — `supabase-js` est servi par le dépôt, pas par un CDN

**Décidé le 4 septembre 2026.**

### Ce que dit la spécification

`SPECS.md` §2.1 et §7.1 : « `@supabase/supabase-js` v2 en UMD depuis **cdnjs**
(version épinglée + `integrity`) ».

### Ce qui est fait à la place

Le fichier est rangé dans `web/vendor/supabase-js-2.115.0.js` et servi par
GitHub Pages, comme le reste de l'application. La politique de sécurité du
contenu n'autorise donc **aucun** script venu d'ailleurs (`script-src 'self'`).

### Pourquoi

D'abord un fait : **`supabase-js` n'est pas sur cdnjs.** La consigne n'était pas
applicable telle quelle.

Ensuite, en cherchant l'équivalent ailleurs, la question s'est posée autrement :
qu'est-ce qu'un CDN apporte ici ? Une application privée, six personnes, une
page consultée quelques fois par jour. Aucun gain de vitesse mesurable. En
revanche, une dépendance de plus : le jour où le CDN répond mal, l'application
ne s'ouvre pas, et personne ne comprend pourquoi. Le fichier pesant 214 Ko —
environ 50 Ko une fois compressé par GitHub Pages — le servir soi-même ne coûte
rien.

Bénéfice de bord : `script-src 'self'` sans exception. Il n'y a plus de sujet
« intégrité du fichier distant », puisqu'il n'y a plus de fichier distant.

### Ce que ça coûte

Mettre à jour la bibliothèque devient un geste : télécharger la nouvelle
version, changer le nom du fichier dans `index.html`. C'est aussi ce qui la rend
visible — une mise à jour passe par un commit relu, pas par un numéro de version
changé dans une URL.

---

## D4 — Les numéros inconnus comptent dans l'entonnoir

**Décidé le 4 septembre 2026.**

`SPECS.md` §1.2 définit les tentatives comme « les appels **sortants** composés
(prospection + inconnus) », et la vue `v_funnel_day` fait de même. Le prototype,
lui, ne comptait que la prospection.

C'est la spécification qui l'emporte, pour une raison simple : un numéro qu'on
n'a pas su rattacher au CRM reste un numéro qu'on a bel et bien composé.
L'exclure ferait paraître l'effort plus faible qu'il n'est — et, plus
sournoisement, le taux de décroché plus flatteur qu'il n'est, puisqu'on
retirerait du dénominateur des appels souvent restés sans réponse.

Les quatre chiffres de l'entonnoir portent donc sur le même ensemble : les
appels du rapport, prospection et inconnus, hors internes et anonymes.

---

## D5 — « Personne eue » exige trente secondes

**Décidé le 4 septembre 2026, par Adrien, sur les chiffres du premier jour.**

### Ce que dit la spécification

`SPECS.md` §1.2 : « Personne eue = appel décroché (`status = answered`),
messageries exclues. »

### Ce qui a été constaté

Le premier vrai rapport annonçait **36 personnes eues sur 44 appels — 82 %**.
Sur ces 36, **24 avaient duré moins de dix secondes**.

Ringover marque « décroché » à la seconde où la ligne se connecte : un serveur
vocal, un raccrochage immédiat, une erreur de numéro entraient tous dans le
compte. Le deuxième chiffre de l'entonnoir — celui qu'on lit en premier, celui
qui dit si la journée a été bonne — était faux, et faux dans le sens flatteur.

### La règle retenue

Une personne a été eue si l'appel a été décroché **et** :

- qu'il a duré **trente secondes ou plus**, **ou**
- qu'un humain l'a qualifié `bache`, `conversation` ou `rdv` dans la file
  « À qualifier ».

La seconde branche n'est pas un détail : un refus sec de six secondes est un
refus qu'on a bel et bien entendu, et il doit compter. C'est l'application de
la règle §1.1.6 — la correction humaine prime toujours sur l'automatique.

### Ce que ça coûte

Un appel utile de vingt secondes ne compte pas tant que personne ne l'a
qualifié. C'est le bon sens du compromis : il vaut mieux un chiffre prudent
qu'un chiffre flatteur, et la file existe précisément pour rattraper les cas
limites.

### Où c'est écrit

Deux endroits, qui doivent rester d'accord : `web/format.js`
(`SEUIL_PERSONNE_EUE_S`, ce que l'écran affiche) et la vue `v_funnel_day`
(migration `20260904050000`). Changer l'un sans l'autre ferait diverger le
rapport et la base.

---

## D6 — La tâche du soir pose aussi les tags, pas seulement les résumés

**Décidé le 4 septembre 2026, par Adrien.**

### Ce qui était prévu

La décision D1 confiait à la tâche planifiée un seul travail : rédiger les
résumés des conversations d'une minute ou plus. La qualification des appels
courts restait entièrement manuelle, dans la file « À qualifier » (`SPECS.md`
§1.1.4).

### Ce qu'on a constaté en regardant Modjo

Modjo contient des appels de **52, 54, 56, 58 secondes** — avec transcription
**et résumé déjà rédigé**. Exactement ceux que la vue ne demandait pas, et
exactement ceux qui s'accumulent dans la file.

Et ces résumés suffisent à trancher. Trois exemples réels du 3 septembre :

- « recrutement géré en interne, nous sommes bien couverts » → *pas de besoin* ;
- « il recommande Clémentine, qui pilote le sujet » → *porte d'entrée* ;
- « erreur de numéro, ce n'était pas la bonne personne » → *rien*.

Faire trancher ça à la main, appel par appel, alors que le texte est déjà
écrit, c'est du travail donné pour rien. Le premier jour d'exploitation a
produit **34 appels en file** — à ce rythme, la file devient un arriéré que
personne n'ouvre, et le rapport perd sa raison d'être.

### La règle retenue

La vue `v_a_resumer` devient le plan de travail complet : ce qui manque un
résumé **et** ce qui attend un tag. Seuil abaissé de 60 à **20 secondes** — en
dessous, il n'y a pas de parole à transcrire, donc rien que Modjo puisse
apporter, et ces appels restent à l'équipe.

La tâche écrit `summary`, `next_step`, `situation`, `outcome`, et retire
l'appel de la file.

### Les deux garde-fous

1. **Le droit de ne pas trancher.** Devant une conversation ambiguë, la tâche
   écrit le résumé et laisse l'appel dans la file. Mieux vaut une question
   posée qu'un tag inventé — c'est une consigne explicite du prompt, pas un
   comportement espéré.
2. **Les colonnes `kind_manual` et `outcome_manual` lui sont interdites.**
   Elles sont réservées aux humains et priment sur elle. Un membre qui n'est
   pas d'accord corrige d'un clic, et sa correction sort l'appel de la vue pour
   toujours.

### Ce que ça coûte

La tâche décide à la place de l'équipe sur des appels qu'elle n'a pas
entendus. Le risque est réel, mais il est borné : chaque décision est visible
dans la fiche appel, chacune est corrigeable, et l'écran d'administration dit
quand la tâche est passée pour la dernière fois. À surveiller la première
semaine — en particulier le nombre d'appels qu'elle laisse en file, qui est le
bon indicateur de sa prudence.

---

## D7 — Les transcriptions viennent de l'API Ringover, et sont stockées en base

**Décidé le 4 septembre 2026, par Adrien. Remplace la source prévue par D1.**

### Ce que disaient D1 et D6

Que la matière des résumés venait de **Modjo**, et que la routine planifiée
irait l'y chercher par son connecteur.

### Pourquoi c'était une erreur

Deux raisons, l'une factuelle, l'autre documentée depuis juillet.

**La première :** le compte Ringover d'Ekinox a l'option de transcription
active. Le skill de préqualification du cabinet l'utilise en production depuis
juillet 2026 (`get_transcription`, statut `DONE`, `transcription_data.speeches[]`).
Il n'y a donc jamais eu besoin d'un tiers pour obtenir le texte des appels.

**La seconde :** ce même skill note noir sur blanc pourquoi Modjo n'est pas
utilisé — *« couverture partielle, et contient les visios hors périmètre »* —
et signale un piège d'identification daté du 24 juillet 2026 : *« Modjo expose
des outils aux noms proches (`get_calls`, `get_transcript`) — ce n'est pas
Ringover. »*

C'est exactement dans ce piège que la mise en place de D1 et D6 est tombée : le
connecteur interrogé était Modjo, pas Ringover. La couverture partielle
signifiait qu'une partie des appels de prospection n'aurait jamais eu de
résumé, sans que rien ne l'explique.

### Ce qui est fait

Ringover reste la source ; la base en est la copie de travail.

1. `fetch-transcript` interroge `GET /v2/transcriptions/{call_id}` toutes les
   dix minutes, pour les appels de prospection décrochés d'au moins vingt
   secondes des sept derniers jours. Six tentatives par appel, deux requêtes
   par seconde, texte borné à 60 000 caractères.
2. Le texte est assemblé depuis `speeches[]` — une réplique par ligne, avec
   qui parle — et rangé dans `calls.transcript`, provenance `ringover_api`.
3. `v_a_resumer` ne liste que les appels **qui ont leur transcription**. La
   routine planifiée n'a donc plus qu'un seul endroit où regarder, et aucune
   clé d'API à manipuler.
4. `v_sans_transcription` compte ce qui attend, affiché sur l'écran
   d'administration.

### Pourquoi stocker plutôt que lire à la demande

Parce que la routine tourne dans le cloud, sans accès aux secrets du projet. Et
parce que l'équipe peut alors relire l'échange depuis la fiche appel, sans
quitter l'application ni rouvrir Ringover.

### Vérifié, pas supposé

Sur onze appels réels : onze transcriptions récupérées, 653 à 32 526
caractères, disponibles en moins de vingt minutes après la fin de l'appel. Le
format exact et les codes de retour sont dans `docs/ringover-api.md`.

Un défaut a été trouvé au passage, et il valait le détour : **l'endpoint
renvoie un tableau JSON**, là où la documentation laissait attendre un objet.
Un code qui attend un objet ne lit rien, ne lève aucune erreur, et conclut
« pas encore prête » — il aurait attendu indéfiniment une transcription déjà
arrivée. C'est la sonde posée dans la fonction qui l'a révélé, pas un test.

### Ce que devient Modjo

Un recours manuel, plus une dépendance. Aucun code ne l'appelle.

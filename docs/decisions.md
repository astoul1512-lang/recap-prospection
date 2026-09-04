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

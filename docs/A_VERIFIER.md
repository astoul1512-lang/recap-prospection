# À vérifier avec les clés réelles avant de coder `summarize` et `reconcile`

| # | Sujet | Comment vérifier | Résultat |
|---|---|---|---|
| 1 | Noms exacts des événements webhook Ringover et présence de `duration_in_seconds` sur `hangup` | lire `private.webhook_events` après le premier vrai appel (lot 0) | en attente du premier appel réel |
| 2 | Endpoint Ringover qui expose le **résumé classique** d'un appel (sans Empower) pour un `call_id` | appeler l'API avec la clé `ringover` sur un appel récent ; regarder ce que renvoie `GET /v2/calls/{id}` ; tester `empower/call/:calluuid/summary` | |
| 3 | Paramètres exacts de `GET /v2/calls` (dates, pagination `last_id_call`, `limit_count`) | https://developer.ringover.com/ + un appel réel | |
| 4 | API Modjo : lister les appels par fenêtre de temps et numéro ; récupérer transcription et résumé | https://api.modjo.ai/v2/docs + un appel réel avec la clé `modjo` | |
| 5 | Format `phoneNumbers[].canonicalNumber` renvoyé par Jarvi (E.164 ?) | un `GET /rest/v2/profiles?where=…` sur un contact connu | |

Consigner ici les réponses (anonymisées) et les décisions prises.

---

## Comment la ligne 1 se vérifiera toute seule

`ringover-webhook` journalise **tout** événement dans `private.webhook_events`, y
compris ceux qu'il refuse (signature invalide, hors fenêtre) et ceux dont il ne
reconnaît pas le nom. Au premier appel réel, la colonne `payload` contient donc
la forme exacte des messages Ringover : noms d'événements, unité de
l'horodatage, présence de `duration_in_seconds`. Aucune manipulation à faire —
il suffira de lire la table.

## Décisions prises pour ne pas coder à l'aveugle (lot 0)

Trois points de `SPECS.md` reposaient sur des hypothèses non vérifiées. Plutôt
que de parier, le code accepte plusieurs formes et journalise celle qu'il a
rencontrée. À corriger — en resserrant — une fois la réalité connue.

### a. Unité de l'horodatage (`timestamp` de l'enveloppe)

`SPECS.md` §5.1.2 impose un contrôle anti-rejeu à ± 5 minutes. Si Ringover
envoie des millisecondes là où on attend des secondes, l'écart calculé vaut des
dizaines de milliers d'années et **100 % des appels légitimes seraient refusés**
— la panne serait totale et muette.

Décision : `analyserTemps()` (`_shared/dates.ts`) reconnaît les secondes, les
millisecondes et le texte ISO, et le journal note l'unité observée
(`unite_horodatage`). Si l'horodatage est illisible, l'événement est **accepté**
et non refusé : la signature HS512 reste le contrôle de sécurité réel,
l'anti-rejeu n'est qu'une défense supplémentaire. Ne jamais inverser ces deux
priorités.

### b. Format de la signature

`SPECS.md` §6.1 décrit un JWT HS512 dans `X-Ringover-Webhook-Signature`, sans
préciser ce que contient sa charge. Le code vérifie la **signature** du jeton
avec le secret `ringover_webhook` — ce qui suffit à prouver que l'émetteur
connaît le secret — sans rien exiger de la charge. L'algorithme annoncé dans
l'en-tête n'est jamais accepté tel quel : seul `HS512` passe.

À vérifier au premier appel : si la charge contient une empreinte du corps du
message, la comparer aussi (protection contre la réutilisation d'une signature
valide avec un corps différent).

### c. Statut d'un `hangup`

`SPECS.md` §5.1.5 demande `status = ended` si l'appel n'a pas été répondu,
`answered` sinon, sans dire quel champ le porte. Le code conclut « répondu » si
`answered_time` est présent, ou si `status = answered`, ou à défaut si la durée
est supérieure à zéro. Risque résiduel : si Ringover envoyait une durée non
nulle pour un appel non décroché (durée de sonnerie), l'appel serait compté à
tort comme décroché. À trancher sur pièce.

## Écarts assumés par rapport à `SPECS.md`

| Point | Ce que dit la spécification | Ce qui est fait | Pourquoi |
|---|---|---|---|
| §5.6 `erase` | journaliser l'effacement dans `corrections` | l'effacement renvoie et journalise le nombre de lignes supprimées, sans ligne `corrections` | `corrections.call_id` référence `calls` : la ligne d'audit serait supprimée en cascade avec l'appel qu'elle documente. Un vrai journal d'administration (hors `corrections`) est à prévoir au lot 2. |
| §7.3 journal d'usage | écrire dans `corrections` depuis le front (`export`, `listen`) | policy d'insertion ajoutée en migration `20260903010000` | la migration initiale n'accordait que la lecture : ces écritures auraient échoué en silence. |
| §3.3.6 sessions | expiration après 12 h d'inactivité | non appliqué | option réservée au forfait payant Supabase. À compenser côté application au lot 1 (déconnexion automatique). |

## Limites connues du lot 0

- **Plafond des signatures invalides** (20 / 5 min / IP) : compté en mémoire dans
  l'instance de la fonction, donc remis à zéro à chaque démarrage à froid et non
  partagé entre instances. Suffisant contre un martèlement simple, pas contre une
  attaque distribuée. Au plus 3 charges invalides sont enregistrées par IP et par
  fenêtre, pour que le journal ne devienne pas le levier d'une saturation.
- **Aucun appel n'est visible dans l'application** : la vue `v_calls` ne montre
  que les appels classés `prospection` ou `inconnu`, et `classify` n'arrive qu'au
  lot 1. Les appels sont bien en base, en `a_classer`. Ce n'est pas une panne.

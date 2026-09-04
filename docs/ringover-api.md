# API REST Ringover — ce qui est utilisé, et ce qui a été vérifié

Relevé le 4 septembre 2026 sur la spécification OpenAPI officielle
(`https://developer.ringover.com/web/openapi_public.yml`, version 2.1.0), qui
est la source dont le portail développeur est le rendu. Tout ce qui suit en est
tiré directement.

Ce document existe parce que `SPECS.md` §6.1 ter donnait des noms de paramètres
supposés. **Trois d'entre eux étaient faux.**

## Ce que la spécification annonçait, et la réalité

| `SPECS.md` §6.1 ter | Réalité |
|---|---|
| pagination `last_id_call` | **`last_id_returned`** (curseur sur `cdr_id`), et `limit_offset` pour la pagination ordinaire |
| `limit_count` plafonné à 100 | plafond **1 000** (défaut 100) |
| champs `duration`, `hangup_time` | **`incall_duration` / `total_duration`**, et **`end_time`** |
| `is_answered` | présent, mais c'est **`last_state`** qui fait foi |
| `is_internal`, `is_anonymous` | **absents** de l'API REST : ils n'existent que dans les webhooks |

## Ce qu'on utilise

```
GET https://public-api.ringover.com/v2/calls
    ?start_date=2026-09-03T00:00:00+02:00
    &end_date=2026-09-03T23:59:59+02:00
    &limit_count=1000&limit_offset=0
Authorization: <clé ringover>        ← la clé brute, SANS « Bearer »
```

- **Bornes de dates incluses**, obligatoires ensemble, écart maximum **15 jours**.
  On envoie l'heure de Paris avec son décalage (`+02:00` l'été, `+01:00`
  l'hiver) et non de l'UTC : sinon la journée serait décalée d'une ou deux
  heures et les appels du soir changeraient de jour.
- **204 quand il n'y a aucun appel** : le corps est vide, tenter de le lire
  comme du JSON lèverait une erreur. C'est le piège classique de cet endpoint.
- Réponse : `{ call_list: [...], call_list_count, total_call_count }`.
  Attention, `GET /calls/{id}` renvoie un autre schéma, avec `list` au lieu de
  `call_list`.
- **Débit limité à 2 requêtes par seconde et par clé** (429 au-delà) : une
  demi-seconde de pause entre deux pages.

## Deux modèles de données à ne jamais confondre

| | Webhook | API REST |
|---|---|---|
| Sens | `direction: inbound / outbound` | `direction: in / out` |
| Horodatages | epoch (secondes) | ISO 8601 avec décalage local |
| Durée | `duration_in_seconds` | `incall_duration`, `total_duration` |
| Fin d'appel | `hangup_time` | `end_time` |
| Répondeur | `answering_machine_detection` (`HUMAN`/`MACHINE`/`NOTSURE`) | `amd` (booléen) |
| Interne / anonyme | `is_internal`, `is_anonymous` | **absents** |
| Collaborateur | `user_id: "USER22673838"` | `user.user_id: 22673838` |

La dernière ligne est la plus dangereuse : sans remise en forme, le même
collaborateur existerait en double et la moitié de ses appels seraient
attribués à un inconnu. `_shared/ringover.ts` préfixe donc l'identifiant
numérique par `USER`.

## Un `call_id` peut apparaître plusieurs fois

Un transfert ou un passage par un serveur vocal découpe l'appel en segments qui
partagent le même `call_id` (le `cdr_id`, lui, est unique). On compte des
appels, pas des segments : la liste est dédoublonnée sur `call_id`, en gardant
le segment le plus long — celui où la conversation a eu lieu. Sans ça, la
journée serait déclarée incomplète tous les jours.

## `last_state` : les valeurs connues

`CANCELLED`, `ANSWERED`, `MISSED`, `FAILED`, `QUEUE_TIMEOUT`,
`BLIND_TRANSFERED`, `VOICEMAIL`, `PERMANENT_TRANSFERED`, `NOANSWER_TRANSFERED`,
`FAX_RECEIVED`, `FAX_FAILED`, `FAX_OUT_SENT`, `INCORRECT_PINCODE`,
`FAX_OUT_NOT_SENT`, `ANNOUNCE`.

La spécification présente cette liste comme un échantillon, pas comme une
énumération fermée. Le code traite donc **tout état inconnu comme « terminé
sans réponse »**, jamais comme une conversation : dans le doute, on ne gonfle
pas l'entonnoir.

## Résumés et transcriptions — pourquoi on n'y touche pas

La question de `SPECS.md` §6.1 bis (« quel endpoint expose le résumé classique
d'un appel ? ») est **close, et la réponse est : aucun**.

- `GET /calls/{id}` ne contient ni résumé ni transcription.
- Les résumés sont derrière **Empower** (`GET /empower/call/{uuid}/summary`),
  qui exige la permission `Empower R` et un rôle Empower adéquat. Piège
  documenté : le champ `summary` de premier niveau est un vestige et vaut
  **toujours `null`** ; le vrai texte est dans `recap.summary`.
- `GET /transcriptions/{callId}` existe, mais dépend d'une option d'équipe et
  répond 401 si elle n'est pas active.

Sans objet de toute façon : les résumés viennent de Modjo, par une tâche Claude
planifiée (`docs/decisions.md`, D1).

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

## Transcriptions — vérifié sur le trafic réel le 4 septembre 2026

L'option de transcription est **active** sur le compte Ekinox. Relevé sur onze
appels réels, tous récupérés du premier coup.

```
GET https://public-api.ringover.com/v2/transcriptions/{call_id}
Authorization: <clé ringover>        ← la clé brute, sans « Bearer »
```

### La réponse est un TABLEAU, pas un objet

C'est le piège, et il coûte cher parce qu'il est muet : un code qui attend un
objet ne lit rien, ne lève aucune erreur, et conclut simplement « pas encore
prête ». Il attendrait indéfiniment une transcription déjà arrivée.

```jsonc
[
  {
    "id": …, "team_id": …, "user_id": …, "standard_id": …,
    "cdr_id": …, "call_id": "10126872918086418832", "channel_id": …,
    "provider": …, "user": {…}, "contact": {…},
    "transcription_status": "DONE",
    "creation_date": …,
    "transcription_data": {
      "duration": …,
      "num_channels": 2,
      "text": "…",              // tout l'échange d'un bloc, sans les locuteurs
      "prediction_time": …,
      "speeches": [             // le même échange, découpé et attribué
        { "speaker_id": 0, "content": "…" },   // 0 = le collaborateur
        { "speaker_id": 1, "content": "…" }    // 1 = l'interlocuteur
      ]
    }
  }
]
```

### Ce qu'on lit, et pourquoi

- **`transcription_status` doit valoir `DONE`.** C'est la seule garantie que le
  texte est complet. Une transcription partielle produirait un résumé faux — et
  un résumé faux ne se voit pas, personne ne relit la conversation pour
  vérifier.
- **On assemble `speeches[]`, pas `text`.** Le champ `text` donne l'échange
  d'un bloc ; `speeches[]` dit qui parle. Pour juger « il nous a envoyé
  promener » ou « c'est nous qui n'avons pas su répondre », savoir qui dit quoi
  change tout.
- **Pas de champ de langue** à ce niveau : `langue` reste nul dans nos relevés.

### Volumes et délais observés

| | Constaté |
|---|---|
| Répliques par appel | 14 à 94 |
| Texte assemblé | 653 à 32 526 caractères |
| Délai après la fin de l'appel | prête en moins de vingt minutes |
| Taux de réussite | 11 sur 11 |

Le plafond de stockage est fixé à 60 000 caractères : près du double du plus
long appel observé, assez bas pour qu'une anomalie ne gonfle pas la base.

### Codes de retour à gérer

| Code | Signification | Ce qu'on fait |
|---|---|---|
| 200 + `DONE` | prête | on stocke |
| 200 sans `DONE` | en cours de transcription | on compte l'essai, on repassera |
| 404 | aucune transcription pour cet appel | idem, six essais puis abandon |
| 401 / 403 | option fermée côté API | **on arrête la boucle** : insister trente fois userait le quota sans rien apprendre |

## Résumés Empower — pourquoi on n'y touche pas

La question de `SPECS.md` §6.1 bis (« quel endpoint expose le résumé classique
d'un appel ? ») est **close, et la réponse est : aucun**.

- `GET /calls/{id}` ne contient ni résumé ni transcription.
- Les résumés tout faits sont derrière **Empower**
  (`GET /empower/call/{uuid}/summary`), qui exige la permission `Empower R` et
  un rôle Empower adéquat. Piège documenté : le champ `summary` de premier
  niveau est un vestige et vaut **toujours `null`** ; le vrai texte est dans
  `recap.summary`.

Sans objet : on ne veut pas un résumé tout fait, on veut la matière brute. La
transcription (section précédente) est récupérée par `fetch-transcript`, et
c'est la routine planifiée qui rédige — elle seule connaît le vocabulaire du
récap et les huit situations (`docs/decisions.md`, D7).

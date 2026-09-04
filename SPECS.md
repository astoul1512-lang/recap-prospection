# Récap prospection — spécifications de développement

Version 1.1 · 3 septembre 2026 · Cabinet Ekinox · propriétaire : Adrien Astoul

Ce document est écrit pour être donné tel quel à Claude Code. Il décrit **quoi** construire, **comment**, et **comment déployer**. Les points marqués `À VÉRIFIER` doivent être confirmés contre l'API réelle avant d'écrire le code concerné (voir §11).

Références livrées avec ce document :

- `design/prototype.html` — prototype cliquable v0.8, **fait foi pour tous les écrans** (ouvrir dans un navigateur ; bouton « Aperçu téléphone » pour la version mobile).
- `web/tokens.css` — jetons de design (couleurs, typographie), source de vérité.
- `supabase/migrations/20260903000000_init.sql` — schéma initial complet (tables, enums, RLS, triggers, vues, purge).
- `.github/workflows/*.yml` + `scripts/verifier.sh` — déploiement automatique avec contrôles bloquants et vérification en ligne (système repris de Mes Séries).
- `CLAUDE.md` — conventions de travail dans le dépôt.

---

## 1. Objectif et règles métier

Une application web privée qui reçoit chaque appel Ringover à la seconde où il se termine, décide s'il s'agit de prospection en interrogeant le CRM Jarvi, résume les conversations, et donne à l'équipe un état des lieux quotidien fiable — sans dépendre du Mac d'Adrien ni d'une tâche Claude planifiée.

### 1.1 Règles métier (non négociables)

1. **Prospection = le numéro externe est dans le CRM Jarvi** (`isContact = true`). Rien d'autre n'entre dans le rapport.
2. **Aucune information candidat** : un numéro trouvé uniquement comme talent (`isTalent` seul), un appel interne ou anonyme → `hors_prospection`, exclu du rapport et des compteurs.
3. **Numéro absent de Jarvi → `inconnu`**, affiché dans le rapport du jour avec l'étiquette « À qualifier » tant qu'il n'est pas tranché.
4. **Appel décroché < 60 s → issue `court`**, à qualifier (répondeur ? bâché ? vraie conversation ?).
5. **Résumés** : appel présent dans **Modjo** → transcription + résumé Modjo ; sinon → **résumé Ringover classique**. Claude met en forme (résumé 5 lignes, situation, étape suivante). Jamais d'audio stocké.
6. **Une correction humaine prime toujours** sur la valeur automatique et est journalisée (qui, quand, quoi).
7. **Ringover est la source de vérité** du volume d'appels : la réconciliation nocturne compare la base à l'API Ringover et marque chaque journée complète ou incomplète.

### 1.2 Vocabulaire de l'entonnoir (définitions figées)

| Étape | Définition |
|---|---|
| Tentatives | appels **sortants** composés (prospection + inconnus) |
| Personne eue | appel décroché (`status = answered`), messageries exclues |
| Vraie conversation | issue `conversation` ou `rdv` (par défaut : décroché ≥ 60 s ; corrigeable) |
| Rendez-vous | issue `rdv` (tag Ringover « RDV », situation `rdv`, ou correction) |
| Bâché | refus sec sans échange (issue `bache`) |

### 1.3 Situations (liste fermée)

| code | libellé | couleur |
|---|---|---|
| `rdv` | Rendez-vous pris | good |
| `ouvert` | Décideur ouvert | acc |
| `porte` | Porte d'entrée nommée | acc |
| `client` | Client actif | good |
| `direct` | Recrute en direct | crit |
| `besoin` | Pas de besoin | neu |
| `relance` | Relance à prévoir | warn |
| `bache` | Bâché | crit |

États techniques affichés comme des étiquettes mais qui ne sont pas des situations : **Résumé à compléter** (conversation sans `summary`), **À qualifier** (`needs_review = true`).

### 1.4 Utilisateurs

Rôles `admin` (Adrien) et `member`. Comptes initiaux : Adrien (admin), Alexandre, Rémy, Pablo, Floryanne, Sarah. Aucune inscription libre.

---

## 2. Architecture

```
Ringover ──webhooks signés HS512──▶ edge fn ringover-webhook ─▶ Postgres (calls)
Ringover ◀──GET /v2/calls (veille)── edge fn reconcile        │
Jarvi    ◀──GET /rest/v2/profiles── edge fn classify ◀────────┤ (à l'insert, en batch, à la demande)
Modjo    ◀──API (transcript/résumé)─ edge fn summarize ◀──────┤ (T+5/15/60 min, puis nuit)
Ringover ◀──résumé classique ────────┘        │
Anthropic◀──Messages API ────────────────────┘
Slack    ◀──webhook entrant ──────── edge fn notify-slack (08:45)

Application web (GitHub Pages, statique) ──supabase-js + JWT──▶ PostgREST (RLS) / edge fns
Supabase Auth : invitation seule, lien magique + Google Workspace, MFA admin
```

### 2.1 Stack

| Couche | Choix | Pourquoi |
|---|---|---|
| Base + auth + fonctions | Supabase (projet `mwbwgnulwfyuqgdgwhqg`, Paris) | déjà créé, gratuit, RLS, edge functions, pg_cron |
| Edge functions | Deno / TypeScript, `Deno.serve`, deps via `npm:`/`jsr:` épinglées | standard Supabase |
| Front | HTML/CSS/JS **sans framework ni build**, ES modules, `@supabase/supabase-js` v2 en UMD depuis cdnjs (version épinglée + `integrity`) | même approche que Mes Séries, déploiement = push |
| Hébergement front | GitHub Pages depuis le dossier `web/` (workflow Actions) | gratuit, HTTPS |
| Déploiement back | GitHub Actions → Supabase CLI (`db push`, `functions deploy`) | Claude Code pousse, GitHub déploie, Adrien n'a rien à lancer |
| IA | Anthropic Messages API, modèle économique (classe Haiku), sortie JSON | coût négligeable |

### 2.2 Arborescence du dépôt `astoul1512-lang/recap-prospection`

```
.
├── CLAUDE.md
├── README.md
├── SPECS.md                      ← ce document
├── .env.example                  ← noms des secrets, jamais de valeurs
├── .gitignore
├── .github/workflows/
│   ├── supabase.yml              ← contrôles → migrations → edge functions
│   └── pages.yml                 ← contrôles → publication → vérification en ligne
├── scripts/verifier.sh           ← contrôles bloquants (repris de Mes Séries)
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   ├── 20260903000000_init.sql
│   │   └── 2026…_cron.sql        ← planifications pg_cron (après déploiement des fonctions)
│   └── functions/
│       ├── _shared/              ← clients Ringover, Jarvi, Modjo, Anthropic, utilitaires (E.164, dates Paris, log)
│       ├── ringover-webhook/index.ts
│       ├── classify/index.ts
│       ├── summarize/index.ts
│       ├── reconcile/index.ts
│       ├── notify-slack/index.ts
│       └── admin/index.ts        ← invitations, désactivation, effacement RGPD
├── web/
│   ├── index.html                ← application (SPA à routage par hash)
│   ├── app.js                    ← état, routage, rendu des vues
│   ├── api.js                    ← accès Supabase (auth, vues, RPC, edge fns)
│   ├── tokens.css                ← jetons de design (fourni)
│   ├── app.css
│   ├── config.js                 ← SUPABASE_URL + clé publishable (public, sans danger avec RLS)
│   ├── manifest.webmanifest, icons/
│   └── version.js                ← `export const VERSION = 'v1.0.0'` affiché en pied de page
└── design/
    └── prototype.html            ← référence visuelle et fonctionnelle
```

---

## 3. Secrets et configuration

### 3.1 Secrets Supabase (Edge Functions → Secrets) — **noms en minuscules, tels que créés par Adrien**

| Nom | Contenu | État |
|---|---|---|
| `ringover` | clé API Ringover (Dashboard → Développeur → API) | en place |
| `jarvi` | clé **privée** Jarvi (Préférences → API) | en place |
| `modjo` | clé API Modjo (Paramètres → Intégrations) | en place |
| `anthropic` | clé API Anthropic | à ajouter (lot 1) |
| `ringover_webhook` | secret du webhook Ringover (créé au lot 0) | à ajouter (lot 0) |
| `slack_webhook` | URL du webhook entrant Slack (DM Alexandre) | à ajouter (lot 2) |
| `cron_token` | jeton aléatoire (32 octets hex) partagé entre pg_cron et les fonctions planifiées | à ajouter (lot 0) |

Les fonctions les lisent avec `Deno.env.get('ringover')` etc. `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (ou `SUPABASE_SECRET_KEYS`) sont injectés automatiquement.

### 3.2 Secrets GitHub (Settings → Secrets and variables → Actions)

| Nom | Contenu |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | jeton personnel Supabase (Account → Access Tokens) |
| `SUPABASE_DB_PASSWORD` | mot de passe base du projet (Project Settings → Database) |
| `SUPABASE_PROJECT_ID` | `mwbwgnulwfyuqgdgwhqg` |

### 3.3 Réglages manuels du dashboard Supabase (lot 0, une fois)

1. Authentication → Sign In / Providers → **désactiver « Allow new users to sign up »**.
2. Authentication → Providers → Email : activer, **magic link** ; désactiver « confirm email » n'est pas nécessaire (invitation).
3. Authentication → Providers → Google : Client ID / secret d'un client OAuth Google Cloud (écran de consentement interne, domaine `cabinet-ekinox.fr`). Facultatif au lot 0.
4. Authentication → URL Configuration : Site URL `https://astoul1512-lang.github.io/recap-prospection/`, Redirect URLs idem + `http://localhost:*` pour le dev.
5. Authentication → MFA : activer TOTP.
6. Auth → Sessions : durée du JWT 1 h, refresh token rotation activée, inactivity timeout 12 h.
7. Database → Extensions : `pg_cron`, `pg_net` (la migration les crée aussi).
8. Data API : schémas exposés = `public` uniquement (jamais `private`).

---

## 4. Base de données

Le schéma complet est dans `supabase/migrations/20260903000000_init.sql` (à appliquer tel quel, puis à faire évoluer par nouvelles migrations, jamais en éditant l'ancienne). Résumé :

| Table / vue | Rôle | Accès |
|---|---|---|
| `public.app_users` | liste blanche des utilisateurs (rôle, actif) | chacun lit sa ligne ; admin (MFA `aal2`) lit et modifie tout |
| `private.invitations` | emails invités **avant** création du compte ; le trigger `on_auth_user_created` refuse tout autre email | service role |
| `public.ringover_users` | ligne Ringover → collaborateur affiché | lecture membres, écriture admin |
| `public.jarvi_cache` | résultat Jarvi par numéro E.164 (30 j) | service role |
| `public.calls` | un appel = une ligne, clé `call_id` Ringover | lecture membres ; update membres limité par le trigger `calls_guard` aux colonnes `kind_manual`, `outcome_manual`, `situation`, `summary`, `next_step`, `needs_review` (journalisé dans `corrections`) |
| `private.webhook_events` | journal brut append-only (90 j) | service role |
| `public.corrections` | audit des corrections humaines | lecture membres, insert par trigger |
| `public.day_status` | complétude par jour | lecture membres |
| `public.v_calls` | appels du rapport (prospection + inconnus, hors internes/anonymes) avec `kind_eff`, `outcome_eff`, `user_name` | security_invoker |
| `public.v_funnel_day` | entonnoir par jour et collaborateur | security_invoker |

Conventions : timestamps en `timestamptz`, `day` = date Paris (`(started_at at time zone 'Europe/Paris')::date`), numéros en E.164 (`+33…`), ids Ringover/Jarvi en `text`.

Migration `0002_cron.sql` (après premier déploiement des fonctions) :

```sql
select cron.schedule('reconcile_nightly', '0 0 * * *',  -- 02:00 Paris (été) ; ajuster à '0 1 * * *' en hiver ou utiliser un job qui calcule
  $$ select net.http_post(url := 'https://mwbwgnulwfyuqgdgwhqg.functions.supabase.co/reconcile',
     headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_token'))) $$);
select cron.schedule('summarize_batch', '*/5 * * * *', $$ …/summarize?mode=batch … $$);
select cron.schedule('classify_batch',  '*/15 * * * *', $$ …/classify?mode=batch … $$);
select cron.schedule('notify_slack',    '45 6 * * 1-5', $$ …/notify-slack … $$);  -- 08:45 Paris (été)
```

Le `cron_token` est stocké côté base via `alter database postgres set app.cron_token = '…'` (exécuté une fois par Adrien dans l'éditeur SQL, jamais dans une migration versionnée).

---

## 5. Edge functions

Règles communes :

- `verify_jwt = false` **uniquement** pour `ringover-webhook` (signature HS512 maison) et pour les appels pg_cron (contrôle du `cron_token`). Toutes les autres exigent un JWT utilisateur actif (`is_active_user`) ; `admin` exige `is_admin()` (donc MFA).
- Client Supabase **service role** côté fonction ; jamais la clé service dans le front.
- Réponses minimales, aucun détail interne en erreur ; logs structurés (`console.log(JSON.stringify({fn, call_id, step, ms}))`).
- Toute écriture dans `calls` est idempotente (`upsert` sur `call_id` + comparaison `last_event_ts`).
- Timeouts externes 8 s, 2 tentatives avec backoff ; jamais de boucle infinie.

### 5.1 `ringover-webhook` (POST)

Entrée : événement Ringover (voir §6.1). Étapes :

1. Lire l'en-tête `X-Ringover-Webhook-Signature` (JWT HS512). Vérifier avec le secret `ringover_webhook`. Absent/invalide → **401**, insérer dans `private.webhook_events` avec `signature_ok = false`, compter (rate-limit 20/5 min/IP → 429).
2. Vérifier `timestamp` à ± 5 min de `now()` (anti-rejeu) → sinon 401.
3. Valider le JSON (taille ≤ 64 Ko, champs attendus par `event`) → sinon 400.
4. Insérer l'événement brut (`signature_ok = true`).
5. Upsert `calls` selon l'événement (ignorer si `timestamp` < `last_event_ts` sauf `record_available`, `tags_updated`, `comments_updated`) :
   - `ringing` : créer si absent — `direction`, numéros, `ringover_user_id` (upsert `ringover_users` avec `user.firstname` etc.), `started_at`, `is_internal`, `is_anonymous`, `status = ringing`, `day`.
   - `answered` : `status = answered`, `answered_at`.
   - `hangup` : `ended_at`, `duration_s`, `status = ended` si non répondu sinon `answered`, `record_link = data.record` ; calcul `outcome` auto (§5.7) ; puis appeler `classify` (interne, même runtime) ; si prospection et `duration_s ≥ 60` → planifier `summarize` (colonne `summarize_attempts = 0`, le batch T+5 s'en charge).
   - `missed` : `status = missed`, `ended_at`.
   - `voicemail` : `status = voicemail`, `duration_s`.
   - `record_available` : `record_link = data.record_link`.
   - `tags_updated` / `comments_updated` : `tags`, `comments` ; si tag « RDV » → `outcome = rdv`, `situation = rdv` (si pas de manuel).
6. Répondre **204**.

Numéro externe : `to_number` si `direction = outbound`, `from_number` sinon ; normaliser en E.164 (`+33…`, retirer espaces/points ; `0X…` → `+33X…`).

### 5.2 `classify`

Modes : interne (appelée par le webhook), `?mode=batch` (pg_cron : tous les `a_classer` + relances), `POST {call_ids:[…], force:true}` (utilisateur, « Revérifier dans Jarvi »).

1. Si `is_internal` ou `is_anonymous` → `kind = hors_prospection`, fin.
2. Chercher `jarvi_cache` (sauf `force`) ; si trouvé et `fetched_at` < 30 j → utiliser.
3. Sinon appeler Jarvi (§6.2). Aucun résultat → `found = false`.
4. Décision : `isContact` → `prospection` (+ `jarvi_profile_id`, `jarvi_company_id`, `contact_name`, `contact_role = headline`, `company_name`) ; plusieurs profils → prendre celui `isContact`, sinon le plus récent ; trouvé mais pas contact → `hors_prospection` ; non trouvé → `inconnu`, `needs_review = true`, `review_reason = inconnu`.
5. Mettre à jour `jarvi_checked_at`, `jarvi_check_count += 1` ; en mode utilisateur, insérer dans `corrections` (`field = jarvi_recheck`, `author_id`) et appliquer la limite **60 revérifications / heure / utilisateur** (compter dans `corrections`) → 429 au-delà.
6. Jarvi injoignable → laisser `a_classer`, le batch réessaie.

Réponse (mode utilisateur) : `{updated:[{call_id, kind, contact_name, company_name}]}`.

### 5.3 `summarize`

Déclenchée par pg_cron toutes les 5 min (`mode=batch`) : sélectionne les appels `kind_eff = prospection`, `status = answered`, `duration_s ≥ 60`, `summary is null`, `summarize_attempts < 4`, dont l'âge correspond aux paliers T+5, +15, +60 min ou > 6 h.

1. **Modjo** (§6.3) : chercher l'appel par numéro externe et fenêtre `started_at ± 3 min`. Trouvé avec transcription → `transcript_source = modjo`, matériau = transcription + résumé Modjo.
2. Sinon, si tentative ≥ 3 (T+60) : **résumé Ringover classique** (§6.1 bis, `À VÉRIFIER`) → `transcript_source = ringover`.
3. Sinon : `summarize_attempts += 1`, attendre le palier suivant.
4. Avec un matériau : appel Anthropic (§6.4) → `{summary, situation, next_step}` ; écrire (sans écraser une valeur déjà corrigée à la main : vérifier l'absence de ligne `corrections` sur ces champs) ; `outcome = rdv` si `situation = rdv`.
5. Sans matériau après 4 tentatives : `transcript_source = aucune`, laisser `summary` null (l'app affiche « Résumé à compléter »).
6. La nuit (`reconcile`) : pour les appels `transcript_source = ringover` de la veille, retenter Modjo une dernière fois et remplacer si trouvé (sauf correction manuelle).

### 5.4 `reconcile` (pg_cron, 02:00 Paris)

1. `GET /v2/calls` Ringover pour la veille (§6.1 ter), paginer avec `last_id_call`.
2. Pour chaque appel absent de `calls` → insérer avec `source = api` puis `classify`.
3. `day_status` : `webhook_count` (lignes `source = webhook`), `api_count` (total Ringover), `complete = (api_count = count(*))`, `checked_at`.
4. Retenter Modjo (§5.3.6). Purger les `jarvi_cache` périmés.
5. Si incomplet → notification Slack à Adrien (`slack_webhook`), message court.

### 5.5 `notify-slack` (pg_cron, 08:45 Paris, lun–ven)

Dernier jour ouvré (lundi → vendredi) : entonnoir, 3 à 5 signaux chauds (situations `rdv`, `ouvert`, `porte` : entreprise · contact · étape suivante), nombre à qualifier, lien vers `…/#jour?d=YYYY-MM-DD`. Envoi par webhook entrant Slack (DM Alexandre). Ne rien envoyer si la journée n'a aucun appel.

### 5.6 `admin` (JWT admin + MFA)

- `POST /invite {email, display_name, role}` : email doit finir par `@cabinet-ekinox.fr` ; insérer `private.invitations` ; `auth.admin.inviteUserByEmail(email, {redirectTo})`.
- `POST /deactivate {user_id}` / `POST /activate` : `app_users.active` (coupe l'accès à la prochaine requête grâce à `is_active_user()`).
- `POST /erase {phone}` : supprimer `calls`, `corrections`, `jarvi_cache` pour ce numéro (droit d'effacement RGPD) ; journaliser dans `corrections` (`field = erase`).
- `POST /webhook-test` : renvoie l'heure du dernier événement reçu et le nombre de signatures invalides sur 7 jours.

### 5.7 Calcul automatique de l'issue (`outcome`)

```
status ∈ {missed, voicemail, ringing, ended sans answered} → tentative
answered et duration_s < 60                                → court  (+ needs_review, review_reason = court, si prospection)
answered et duration_s ≥ 60                                → conversation
tag Ringover « RDV » ou situation rdv                      → rdv
```
`bache` n'est jamais posé automatiquement (correction humaine ou Claude via situation `bache`).

---

## 6. Intégrations externes

### 6.1 Ringover — webhooks

Configuration (Adrien, lot 0) : Dashboard Ringover → Développeur → Webhooks → créer un webhook « appels » avec l'URL `https://mwbwgnulwfyuqgdgwhqg.functions.supabase.co/ringover-webhook`, cocher les événements ci-dessous, copier le secret dans `ringover_webhook`. Format : POST JSON, en-tête `X-Ringover-Webhook-Signature` = JWT signé **HS512** avec le secret (référence : dépôt officiel `ringover/ringover-webhooks`, dossier `node/src`).

| `event` | `data.*` utiles |
|---|---|
| `ringing` | `id`, `call_id`, `channel_id`, `start_time` (epoch s), `direction` (`inbound`/`outbound`), `from_number`, `to_number`, `user_id`, `user{firstname,lastname,email}`, `is_internal`, `is_anonymous`, `is_ivr` |
| `answered` | idem + `status` |
| `hangup` | + `hangup_time`, `duration_in_seconds`, `record` |
| `missed` | + `reason`, `status` |
| `voicemail` | + `answered_time`, `duration_in_seconds` |
| `record_available` | `call_id`, `record_link`, `record_duration` |
| `tags_updated` | `call_id`, `tags[]` |
| `comments_updated` | `call_id`, `tags[]`, `comments` |

Enveloppe : `{event, resource, timestamp, data, attempt}`. `À VÉRIFIER` sur le premier webhook réel : noms exacts des événements et présence de `duration_in_seconds` sur `hangup` (le journal brut sert à ça).

**6.1 bis — résumé Ringover classique** `À VÉRIFIER` : le connecteur Ringover local d'Adrien affiche des résumés d'appel sans Empower ; identifier avec la clé `ringover` l'endpoint qui les expose pour un `call_id` (candidats : champ dans `GET /v2/calls/{id}`, ou endpoints `empower/call/:calluuid/summary` si accessibles). Documenter le résultat dans `docs/ringover-summary.md` avant de coder `summarize`.

**6.1 ter — API REST** : base `https://public-api.ringover.com/v2`, en-tête `Authorization: <clé ringover>`, `GET /calls` avec filtres de dates (`start_date`, `end_date` ISO), `limit_count`, pagination `last_id_call` ; champs `call_id`, `direction`, `duration`, `from_number`, `to_number`, `user`, `start_time`, `is_answered`, `record`. `À VÉRIFIER` : noms exacts des paramètres dans https://developer.ringover.com/.

### 6.2 Jarvi — API publique

- Base : `https://functions.prod.jarvi.tech/v1/public-api`
- En-tête : `X-API-KEY: <clé jarvi>` (clé **privée** ; la publique ne permet pas de lire).
- Recherche par numéro : `GET /rest/v2/profiles?where={"phones":{"_search":"<chiffres du numéro>"}}&limit=5` — Jarvi compare sur les chiffres seuls (le suffixe suffit) ; confirmer la correspondance avec `phoneNumbers[].canonicalNumber`.
- Champs utiles : `id`, `firstName`, `lastName`, `headline`, `isContact`, `isTalent`, `phoneNumbers[{number, canonicalNumber, type}]`, `associations.company{id, name}`, `positions[]`.
- Liens dans l'app : contact `https://app.jarvi.tech/#/crm/profiles/{profile_id}`, société `https://app.jarvi.tech/#/crm/companies/{company_id}`.
- Aucune écriture dans Jarvi en v1.

### 6.3 Modjo — API `À VÉRIFIER`

Clé dans `modjo` (Paramètres → Intégrations → API). Documentation : `https://api.modjo.ai/v2/docs` (à lire avant de coder). Besoin : lister les appels d'une fenêtre de temps avec le numéro de téléphone du contact, puis récupérer transcription et résumé IA d'un appel. Correspondance avec Ringover : numéro externe + `started_at ± 3 min` (+ durée ± 15 %). Écrire un client `_shared/modjo.ts` avec `findCall({phone, startedAt})` et `getTranscript(id)`, et un `docs/modjo-api.md` qui note les endpoints réellement utilisés et un exemple de réponse anonymisé.

### 6.4 Anthropic — mise en forme des résumés

`POST https://api.anthropic.com/v1/messages`, en-têtes `x-api-key: <anthropic>`, `anthropic-version: 2023-06-01`. Modèle : le plus économique de la génération courante (classe Haiku), `max_tokens: 600`, `temperature: 0`. Forcer une sortie JSON (tool use avec un schéma, ou consigne stricte + validation) :

```json
{"summary":"string ≤ 600 caractères, français, faits uniquement, 5 lignes max",
 "situation":"rdv|ouvert|porte|client|direct|besoin|relance|bache",
 "next_step":"string ≤ 160 caractères, impératif, une action concrète"}
```

Consigne système (à placer dans `_shared/prompts.ts`) : rôle « assistant du cabinet de recrutement Ekinox », matériau = transcription/résumé fourni, règles du récap 1.1 : ne rien inventer, nommer le décideur et le besoin si présents, dater les relances, choisir **une** situation selon les définitions §1.3, ne jamais mentionner de candidat. Valider la réponse (enum, longueurs) ; en cas d'échec de parsing, une seconde tentative puis abandon (`summarize_attempts` max).

### 6.5 Slack

Webhook entrant (URL dans `slack_webhook`), message en blocs `mrkdwn`, une ligne par signal chaud, lien vers l'app.

---

## 7. Application web (`web/`)

### 7.1 Principes

- **Le prototype `design/prototype.html` fait foi** : mêmes écrans, mêmes libellés, mêmes comportements. Le refaire avec des données réelles, pas le copier tel quel (le prototype embarque des données générées).
- Pas de framework, pas de build : `index.html` + modules ES. `supabase-js` v2 chargé depuis cdnjs avec version épinglée et `integrity`.
- Routage par hash : `#login`, `#jour`, `#jour?d=2026-09-02`, `#jour?from=…&to=…`, `#semaine?w=2026-08-31`, `#qualifier`, `#equipe`, `#admin`.
- État en mémoire ; seules les préférences d'affichage (vue Colonnes/Tableau/Liste, filtre collaborateur, thème) vont en `localStorage` (try/catch). **Aucune donnée d'appel en localStorage.**
- Rien dans l'URL qui soit nominatif (pas de numéro, pas de nom).
- Thèmes clair/sombre via `tokens.css` (auto + bascule).

### 7.2 Authentification (front)

- Écran de connexion : email → `signInWithOtp({email, options:{shouldCreateUser:false, emailRedirectTo}})` ; bouton Google → `signInWithOAuth({provider:'google', options:{queryParams:{hd:'cabinet-ekinox.fr'}}})`. Flux PKCE.
- Après session : charger `app_users` (sa ligne) ; si absent/inactif → écran « Adresse non invitée, demandez l'accès à Adrien » + `signOut()`.
- Admin : si `aal` ≠ `aal2` → écran d'inscription/vérification TOTP (`mfa.enroll` / `mfa.challenge` / `mfa.verify`) avant d'accéder à `#admin`.
- Déconnexion, expiration : sur `SIGNED_OUT`/`TOKEN_REFRESHED` échoué → retour à `#login` sans « flash » de données (l'app ne rend rien tant que la session n'est pas vérifiée).

### 7.3 Accès aux données

| Besoin | Source |
|---|---|
| appels d'un jour / d'une plage | `from('v_calls').select('*').gte('day', from).lte('day', to)` (+ `eq('ringover_user_id', …)`) |
| entonnoir | calculé côté client depuis `v_calls` (petits volumes) ou `v_funnel_day` |
| complétude | `day_status` |
| collaborateurs | `ringover_users` (actifs) |
| fiche appel / corrections | `from('calls').update({kind_manual, outcome_manual, situation, summary, next_step, needs_review}).eq('call_id', id)` — le trigger journalise |
| historique | `corrections` par `call_id` |
| revérifier Jarvi | `functions.invoke('classify', {body:{call_ids, force:true}})` |
| admin | `functions.invoke('admin', …)` |
| export CSV | généré côté client depuis les données affichées (séparateur `;`, UTF-8 BOM) ; l'action est journalisée via `corrections` (`field = export`) |

### 7.4 Écrans (voir prototype pour le détail visuel)

**Jour** (`#jour`)
1. En-tête : eyebrow (« Semaine 36 · mercredi » ou « Plage de dates · N jours ouvrés »), titre serif (date longue ou `du → au`), pastille de complétude (complète / incomplète / en cours), menu collaborateur, bouton Exporter.
2. Barre des jours : ‹ › semaine, `S36`, cinq puces lun→ven avec point de complétude (vert/rouge/orange), jours futurs grisés, « Aujourd'hui », bouton « Plage de dates » qui bascule vers `Du [date] au [date]` + raccourcis (cette semaine, semaine dernière, 30 jours) + « Retour au jour ».
3. **Bandeau état des lieux** : 4 chiffres reliés par des flèches (appels passés → personnes eues (%) → vraies conversations (%) → rendez-vous (noms des sociétés)), barre de proportion (sans réponse / courts-bâchés / conversations / rdv), puis les **situations en compteurs cliquables** (filtre, un seul actif, re-clic = tout).
4. **Échanges** : titre + compte + sélecteur de vue (Colonnes · Tableau · Liste). Contenu = conversations (`status = answered`, `duration_s ≥ 60`, `kind_eff = prospection`) :
   - *Colonnes* (défaut) : 5 colonnes « Rendez-vous & clients » (rdv, client) · « Décideur ouvert » · « Porte d'entrée & relance » (porte, relance) · « Refus · pas de besoin » (direct, besoin, bache) · « À qualifier » (conversations sans résumé + appels `needs_review`, cartes en pointillés avec bouton Qualifier). Carte : société, contact · fonction, étiquette, résumé (4 lignes max), « → étape suivante », pied : avatar + prénom, heure · durée, 3 icônes. Colonne vide : « Aucun échange sur la période ». Sur mobile : colonnes empilées.
   - *Tableau* : Entreprise · contact | Qui · heure | Situation | Résumé (large) | Étape suivante | actions ; cartes sur mobile.
   - *Liste* : lignes compactes groupées par situation (ordre §1.3 puis « Résumé à compléter »), résumé sur une ligne, puis groupe « À qualifier ».
5. **Autres appels** (replié, bouton Afficher) : messageries, non décrochés, appels courts : tableau Entreprise · Contact · Qui · Heure · Durée · État · actions.
6. **Fiche appel** : panneau latéral droit (330 px) sur bureau, feuille depuis le bas sur mobile (< 1100 px). Contenu : titre société, contact · fonction, boutons [Revérifier dans Jarvi si inconnu] [Enregistrement] [Contact Jarvi] [Société Jarvi] ; grille sens / collaborateur / heure / durée / numéro / source ; type (Prospection / Hors prospection) ; issue (Tentative / Bâché / Conversation / Rendez-vous) ; situation (8 boutons) ; résumé (textarea) ; étape suivante (input) ; Enregistrer ; historique (date · auteur · changement).
7. **Trois boutons par appel**, partout : enregistrement (ouvre `record_link` dans un nouvel onglet ; grisé si non décroché ; le clic est journalisé `field = listen`), contact Jarvi (grisé si pas de `jarvi_profile_id`), société Jarvi (grisé si pas de `jarvi_company_id`).

**Semaine** (`#semaine`) : ‹ › « Cette semaine », menu collaborateur, Exporter ; pastille journées complètes ; 4 tuiles (tentatives avec Δ S-1, personnes eues %, conversations %, rendez-vous Δ S-1) ; barres par jour (deux segments : personne eue / sans réponse, légende, tooltip, clic = ouvrir le jour) ; entreprises touchées ; rendez-vous de la semaine.

**À qualifier** (`#qualifier`) : bandeau explicatif + bouton « Revérifier les N inconnus dans Jarvi » + filtres (Tous / Numéro inconnu / Appel court). Liste : par appel, date · heure · collaborateur · sens, société ou « Numéro inconnu », numéro masqué (`+33 6 12 34 •• ••`) · durée, étiquette raison (+ « revérifié »), [Revérifier dans Jarvi si inconnu] + 3 icônes ; « 1. Est-ce de la prospection ? » (Prospection / Hors prospection) ; « 2. Ce que ça a donné » (Répondeur / rien, Bâché, Vraie conversation, Rendez-vous) ; note ; **Valider** (actif seulement si type ≠ inconnu et issue ≠ court) ; « Plus tard ». Valider → `needs_review = false` (+ `kind_manual`, `outcome_manual`). File = `needs_review = true` sur les 7 derniers jours.

**Collaborateurs** (`#equipe`) : tableau par personne (tentatives avec mini-barre, personnes eues, taux, conversations, RDV, appels de prospection), ‹ › semaine ; clic = `#semaine` filtré.

**Administration** (`#admin`, admin + MFA) : utilisateurs (rôle, actif, inviter), lignes Ringover → collaborateur, état de la collecte (dernier webhook, Jarvi, réconciliation, signatures invalides ; boutons relancer la réconciliation, tester le webhook), données et sécurité (rétention en lecture, MFA, écoute des enregistrements, effacement RGPD avec confirmation).

### 7.5 Design

- Jetons : `web/tokens.css`. Polices Google Fonts : `Newsreader` (400/500, italique) et `Instrument Sans` (400/500/600), avec fallbacks Georgia / system-ui.
- Composants (classes du prototype à reprendre) : `.btn` (38 px, `.primary`, `.sm` 32 px), `.chip`, `.pill` (`neu good warn crit acc out`), `.card`, `.seg` (segmenté), `.daychip`, `.glance/.stats/.stat`, `.schip`, `.kboard/.kcol/.kc`, `.xt` (tableau), `.xrow`, `.qitem`, `.detail`, `.tabs` (mobile), `.toast`, `.modal`.
- Responsive : paliers **900 px** (rail → onglets bas, tableaux → cartes, colonnes → empilées) et **1100 px** (fiche → feuille). Cibles tactiles ≥ 44 px. `prefers-reduced-motion` respecté.
- Accessibilité : focus visible, `aria-pressed` sur les bascules, `aria-live` pour les toasts, contrastes AA sur les deux thèmes.
- Performance : une requête par vue, pas d'image, < 150 Ko transférés hors polices.

### 7.6 PWA

`manifest.webmanifest` (nom « Récap prospection », `display: standalone`, icône SVG), pas de service worker de cache de données (données sensibles) — au plus un SW « network-only ».

---

## 8. Sécurité (checklist de mise en production)

- [ ] Inscription libre désactivée ; trigger `on_auth_user_created` actif ; test : un email non invité ne peut pas créer de compte.
- [ ] RLS activée sur 100 % des tables ; `private` non exposé ; test négatif : clé publishable seule → 0 ligne partout.
- [ ] Test négatif : utilisateur `active = false` → 0 ligne ; membre ne peut pas modifier `kind`, `duration_s`, etc. (trigger `calls_guard`).
- [ ] Webhook : POST sans signature → 401 et rien en base ; rejeu d'un événement de plus de 5 min → 401 ; 20 signatures invalides → 429.
- [ ] `verify_jwt = true` sur `classify`, `summarize`, `reconcile`, `notify-slack`, `admin` (les appels cron passent par `cron_token`).
- [ ] Secrets présents dans Supabase, absents du dépôt ; GitHub secret scanning + push protection activés ; `.env` ignoré.
- [ ] MFA activée sur le compte admin ; policies admin exigent `aal2`.
- [ ] Supabase Advisors (sécurité) à zéro après chaque migration.
- [ ] CSP en `<meta>` dans `index.html` : `default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src https://mwbwgnulwfyuqgdgwhqg.supabase.co https://mwbwgnulwfyuqgdgwhqg.functions.supabase.co; img-src 'self' data:; frame-ancestors 'none'`.
- [ ] Purge `pg_cron` planifiée et testée ; rétention 24 mois / 90 jours / 30 jours.
- [ ] Parcours complet validé sur iPhone (Safari) et Android (Chrome).

---

## 9. Déploiement

Le système reprend celui de Mes Séries (contrôles bloquants, version vérifiée en ligne, SQL avant le front), mais **dans GitHub Actions** : personne n'a à lancer de script, et un contrôle qui échoue empêche le déploiement.

### 9.1 Une seule fois (Adrien)

1. GitHub → Settings → Secrets → ajouter `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_ID`.
2. GitHub → Settings → Pages → Source : **GitHub Actions**.
3. Supabase → Edge Functions → Secrets : ajouter `anthropic`, `ringover_webhook`, `cron_token` (+ `slack_webhook` au lot 2).
4. Réglages Auth (§3.3).
5. Éditeur SQL : `alter database postgres set app.cron_token = '<même valeur que cron_token>';`
6. Ringover → Développeur → Webhooks : créer le webhook avec l'URL de la fonction (§6.1).

### 9.2 À chaque livraison : push sur `main`, et c'est tout

Deux workflows, chacun en trois temps :

| Workflow | Déclenché par | 1. Contrôles bloquants | 2. Déploiement | 3. Vérification |
|---|---|---|---|---|
| `supabase.yml` | changement dans `supabase/` | `scripts/verifier.sh` + tests Deno des fonctions | `supabase db push` (**SQL d'abord**) puis `supabase functions deploy` | échec = rien n'est touché |
| `pages.yml` | changement dans `web/` | `scripts/verifier.sh` | publication de `web/` | **relit le site en ligne jusqu'à 5 min** et échoue tant que la `<meta name="version">` servie n'est pas celle du commit |

Règle héritée de Mes Séries : **on ne dit jamais « c'est en prod » avant de l'avoir constaté en ligne** — ici c'est le job `verifier-en-ligne` qui le constate, et l'onglet Actions montre deux coches vertes.

### 9.3 Les contrôles bloquants (`scripts/verifier.sh`)

| # | Contrôle | Ce qu'il évite |
|---|---|---|
| 1 | Syntaxe JS de `web/` (`node --check`) | un fichier qui ne parse pas = application morte |
| 2 | Troncature (JS/TS/HTML/CSS/SQL doivent se terminer proprement) | une génération coupée, parfois encore valide, amputée de ses fonctions — **le risque n°1 avec du code généré** |
| 3 | Scripts référencés par `index.html` présents | un fichier manquant = page blanche |
| 4 | Version identique dans `web/version.js`, `<meta name="version">` d'`index.html` et `README.md` | version oubliée = code en ligne que personne ne reçoit, et impossible de vérifier ce qui est servi |
| 5 | Aucun secret dans le dépôt (motifs `sb_secret_`, `service_role`, `sk-ant-`, JWT) ; pas de `.env` | le dépôt et `web/` sont publics |
| 6 | Frontière de publication : rien de sensible dans `web/` | un document interne glissé dans `web/` devient public |
| 7 | Migrations : pas de `DROP TABLE` sur les tables de données ; `CREATE POLICY` accompagné d'un `DROP POLICY IF EXISTS` (vigilance) | une policy recréée sans DROP s'ajoute à la stricte au lieu de la remplacer |
| 8 | `verify_jwt = false` réservé à `ringover-webhook` | une fonction ouverte à tous par erreur |

Sortie 0 : on déploie. Sortie 1 : bloqué, on corrige, on relance — **jamais de contournement**. Sortie 2 : vigilance, à exposer à Adrien en français simple avant de continuer. Claude Code lance `bash scripts/verifier.sh .` localement avant de préparer chaque lot.

### 9.4 Poser la version (à chaque lot)

Trois endroits, toujours la même valeur `vN.N.N` : `web/version.js` (`VERSION`), `web/index.html` (`<meta name="version">`), `README.md` (ligne « Version en production »). Le marqueur d'`index.html` est ce que le job de vérification relit en ligne.

### 9.5 Rendre compte à Adrien

Court, en français, sans jargon, sur le modèle de Mes Séries :

> **v1.2.0 en ligne.** Vérifié sur le site : c'est bien la v1.2.0 qui est servie. Modifié : la file « À qualifier » et la revérification Jarvi. S'il y a eu un blocage : ce qui a été attrapé et ce que ça aurait cassé.

### 9.6 Développement local (facultatif)

`supabase start` (Docker), `supabase db reset`, `supabase functions serve --env-file .env`, front servi par `python3 -m http.server 8080 -d web` avec `config.js` pointant sur l'instance locale.

## 10. Recette (scénarios à automatiser au minimum en tests d'intégration des fonctions)

1. Webhook `ringing` → `hangup` (sortant, 8 min, numéro contact Jarvi) → ligne `calls` `prospection`, `conversation`, `needs_review = false` ; `summarize` produit résumé + situation.
2. Même chose avec un numéro inconnu → `inconnu`, `needs_review = true`, visible dans Jour (À qualifier) et dans la file ; « Revérifier » après création du contact dans Jarvi → reclassé.
3. Appel 40 s décroché → `court`, `needs_review` ; validation « Prospection / Bâché » → sort de la file, `corrections` contient 3 lignes.
4. `voicemail` → `tentative`, dans « Autres appels », pas de résumé.
5. Appel interne → absent de `v_calls`.
6. Réconciliation avec un appel manquant → inséré `source = api`, `day_status.complete = false` puis `true` après rattrapage.
7. Membre désactivé → 401/0 ligne immédiatement.
8. Export CSV : colonnes `jour;heure;sens;collaborateur;entreprise;contact;fonction;issue;situation;duree_s;resume;etape_suivante`.

---

## 11. Plan de livraison

| Lot | Contenu | Fait quand |
|---|---|---|
| **0 — Fondations** | migration init, `ringover-webhook`, `admin/invite`, workflows GitHub, réglages Auth, secrets, webhook Ringover configuré, 6 invitations envoyées | un vrai appel apparaît dans `calls` ; checklist §8 lignes 1–6 vertes |
| **1 — Lecture** | `classify`, `summarize` (après `À VÉRIFIER` 6.1 bis, 6.3), `reconcile`, cron, front complet (connexion, Jour 3 vues, Semaine, À qualifier, fiche, collaborateurs), Pages | la page remplace le récap actuel ; arrêt de la tâche planifiée `resume-call-veille` pour la collecte |
| **2 — Équipe** | `notify-slack`, admin complet, alertes, PWA | Alexandre reçoit son DM à 08:45 |
| **3 — Confort** | sous-domaine `cabinet-ekinox.fr`, export avancé, finitions | — |

### Ordre de travail recommandé pour Claude Code

1. Lire `CLAUDE.md`, ce document, ouvrir `design/prototype.html`.
2. Lot 0 : vérifier la migration (`supabase db lint`), écrire `ringover-webhook` avec ses tests (signature valide/invalide/rejeu, chaque événement), `admin/invite`, workflows.
3. Préparer un `docs/A_VERIFIER.md` listant ce qui doit être confirmé avec les clés réelles (6.1, 6.1 bis, 6.1 ter, 6.3) et **s'arrêter pour demander à Adrien** de lancer les requêtes de vérification (ou de fournir un exemple de réponse) avant d'écrire `summarize` et `reconcile`.
4. Lot 1 front : partir du prototype, remplacer les données générées par `api.js`.
5. Livrer par lots : commits poussés sur `main` par Claude Code depuis le Mac d'Adrien, contrôles bloquants avant chaque push, vérification en ligne après ; compte rendu court à Adrien.

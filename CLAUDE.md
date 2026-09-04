# CLAUDE.md — Récap prospection

Application web privée du Cabinet Ekinox : monitoring des appels de prospection (Ringover → Supabase → page GitHub Pages), classification via le CRM Jarvi, résumés Modjo / Ringover mis en forme par Claude.

## Lire d'abord

1. `SPECS.md` — la spécification complète (métier, base, edge functions, front, sécurité, déploiement). Elle fait foi.
2. `design/prototype.html` — le prototype cliquable : **tous les écrans doivent lui ressembler et se comporter pareil**. Ouvrir dans un navigateur ; « Aperçu téléphone » pour le mobile.
3. `web/tokens.css` — jetons de design, à importer tels quels.
4. `supabase/migrations/20260903000000_init.sql` — schéma initial ; ne jamais le modifier après application, ajouter des migrations.

## Règles de travail

- **Adrien n'est pas développeur et n'aime pas le terminal.** Tu es son guide : chaque fois que tu lui demandes une action (cliquer dans un site, coller une clé, répondre à une question), explique en français simple *pourquoi*, *où* (chemin de menu exact) et *quoi faire*, une action à la fois, puis attends sa réponse. Ne lui montre jamais de code, de SHA ou de sorties brutes sans qu'il le demande ; dis-lui ce que ça change pour lui.
- **C'est toi qui utilises git.** Tu commits et tu pousses sur `main` toi-même (`git add`, `git commit`, `git push`) depuis son Mac, avec son accès GitHub. Un commit par lot (ou par étape logique d'un lot), message en français : intitulé, puis ce qui change et pourquoi. Avant tout push : `bash scripts/verifier.sh .` doit sortir 0. Après le push : suivre les workflows GitHub Actions (`gh run watch` si `gh` est installé, sinon lui dire d'ouvrir l'onglet Actions) et **ne jamais annoncer « c'est en ligne » avant que le job `verifier-en-ligne` soit vert**. Mise en production : **SQL d'abord** (les migrations partent avant les fonctions et le front, le workflow s'en charge).
- **Secrets** : uniquement dans Supabase (Edge Functions → Secrets) sous les noms **en minuscules** `ringover`, `jarvi`, `modjo`, `anthropic`, `ringover_webhook`, `slack_webhook`, `cron_token`. Jamais de valeur dans le dépôt, jamais dans le chat. `.env.example` ne contient que les noms.
- **Points `À VÉRIFIER`** dans `SPECS.md` (§6.1, 6.1 bis, 6.1 ter, 6.3) : ne pas coder à l'aveugle. Écrire `docs/A_VERIFIER.md`, demander à Adrien un exemple de réponse réelle (ou lancer la requête avec sa clé depuis une fonction de test), documenter dans `docs/`, puis coder.
- **Métier** : prospection = numéro présent dans le CRM Jarvi (`isContact`). Aucune donnée candidat ne doit apparaître nulle part (ni compteur, ni tableau, ni export).
- **Sécurité** : RLS sur toute table ; `private` jamais exposé ; `verify_jwt = false` seulement pour `ringover-webhook` (signature HS512) ; la clé service role ne quitte jamais les edge functions ; rien de nominatif dans les URL ; aucune donnée d'appel en `localStorage`.
- **Front** : HTML/CSS/JS sans framework ni build, modules ES, `supabase-js` v2 UMD depuis cdnjs épinglé avec `integrity`. Incrémenter `web/version.js` à chaque livraison.
- **Edge functions** : Deno, dépendances épinglées, timeouts 8 s, idempotence sur `call_id`, logs JSON structurés, réponses minimales.
- **Langue** : interface, libellés, commits et documentation en français ; identifiants de code en anglais.
- **Avant chaque lot** : `bash scripts/verifier.sh .` doit sortir 0 (contrôles bloquants repris de Mes Séries : syntaxe, troncature, version, secrets, migrations). Un blocage ne se contourne jamais : on corrige, on relance. Poser la version aux trois endroits (`web/version.js`, `<meta name="version">`, README).
- **Jamais « c'est en prod » sans l'avoir constaté** : le job `verifier-en-ligne` du workflow Pages relit la version servie ; s'il est rouge, ce n'est pas en ligne.
- **Tests** : chaque edge function a des tests (Deno test) sur ses cas de `SPECS.md` §10 ; les migrations passent `supabase db lint` ; Supabase Advisors sécurité à zéro.

## Commandes utiles

```
supabase link --project-ref mwbwgnulwfyuqgdgwhqg
supabase db push                       # migrations
supabase functions deploy              # toutes les fonctions (config.toml gère verify_jwt)
supabase functions serve --env-file .env
deno test supabase/functions
python3 -m http.server 8080 -d web     # front local
```

## Livraison par lots

Lot 0 fondations → lot 1 lecture → lot 2 équipe → lot 3 confort (voir `SPECS.md` §11). Un lot = une série de commits sur `main` poussés par toi, un compte rendu court à Adrien à la fin (modèle en `SPECS.md` §9.5).

## Au premier lancement (première session dans ce dépôt)

1. Vérifie l'outillage : `git`, `node` ≥ 20, `supabase` (CLI), `deno`, `gh` (facultatif). Ce qui manque : propose la commande d'installation (Homebrew sur Mac) et attends qu'Adrien confirme avant de l'exécuter.
2. Vérifie que le dépôt est bien `astoul1512-lang/recap-prospection` (`git remote -v`) et que tu peux pousser (`git push --dry-run`). Sinon, guide Adrien pour se connecter à GitHub (`gh auth login` ou identifiants git).
3. Fais l'état des lieux de `SPECS.md` §9.1 (réglages à faire une fois) sous forme de checklist, demande à Adrien lesquels sont déjà faits, et guide-le pour les autres, un par un.
4. Ensuite seulement, commence le lot 0.

# Démarrage — à lire par Adrien (5 minutes)

Tu n'as que trois choses à faire toi-même. Tout le reste, Claude Code le fait ou te guide.

## 1. Installer Claude Code (une fois)

Dans le Terminal du Mac (Applications → Utilitaires → Terminal), colle :

```
curl -fsSL https://claude.ai/install.sh | bash
```

puis ferme et rouvre le Terminal. (Si tu utilises déjà Claude Code dans l'app Claude ou VS Code, saute cette étape.)

## 2. Mettre le kit dans le dépôt (une fois)

Dans le Terminal, colle ces trois lignes (elles clonent le dépôt dans `~/Projets`, y copient le kit, et ouvrent Claude Code dedans) :

```
mkdir -p ~/Projets && cd ~/Projets && git clone https://github.com/astoul1512-lang/recap-prospection.git && cd recap-prospection
unzip -o ~/Downloads/recap-prospection-kit.zip -d . && rm -f DEMARRAGE.md.bak
claude
```

Si le zip n'est pas dans Téléchargements, adapte le chemin `~/Downloads/recap-prospection-kit.zip`.

## 3. Coller ce prompt dans Claude Code

```
Lis CLAUDE.md, SPECS.md et docs/A_VERIFIER.md, et ouvre design/prototype.html dans mon navigateur.
Je ne suis pas développeur et je n'aime pas le terminal : guide-moi pas à pas, une action à la fois, en m'expliquant où cliquer et pourquoi. C'est toi qui fais les commits et les push.
Commence par la section « Au premier lancement » de CLAUDE.md (outillage, accès GitHub, checklist des réglages à faire une fois), puis attaque le lot 0.
```

Ensuite, tu réponds à ses questions. Quand il dit qu'un lot est en ligne, vérifie sur https://astoul1512-lang.github.io/recap-prospection/ que la version en pied de page est celle qu'il annonce.

## Ce qu'il va te demander (prépare-les)

- Les trois secrets GitHub (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_ID`) — il te dira où les trouver.
- Les secrets Supabase manquants : `anthropic`, `cron_token`, puis `ringover_webhook`.
- Les réglages d'authentification Supabase (inscriptions fermées, lien magique, MFA).
- Cinq vérifications d'API (docs/A_VERIFIER.md) : il te demandera de lancer une requête ou de lui coller un exemple de réponse.
- La création du webhook dans le dashboard Ringover, avec l'URL qu'il te donnera.

#!/usr/bin/env bash
# Contrôles bloquants avant tout déploiement — Récap prospection
# Repris du système de mise en prod de Mes Séries (chaque contrôle vise une panne déjà vue).
# Sortie 0 : ok · 1 : bloquant (on corrige, on relance) · 2 : vigilance (à exposer à Adrien)
set -u
ROOT="${1:-.}"; cd "$ROOT" || exit 1
KO=0; WARN=0
ko(){ echo "✗ $1"; KO=1; }
ok(){ echo "✓ $1"; }
warn(){ echo "! $1"; WARN=1; }

# 1. Syntaxe JS du front (un fichier qui ne parse pas = application morte)
for f in web/*.js; do
  [ -f "$f" ] || continue
  if node --check "$f" 2>/dev/null; then :; else ko "syntaxe JS invalide : $f"; fi
done
[ $KO -eq 0 ] && ok "syntaxe JS du front"

# 2. Troncature (le risque n°1 avec du code généré) : un fichier doit se terminer proprement
#    (on ignore les commentaires et lignes vides de fin ; un fichier vide est toléré)
T=0
for f in web/*.js web/*.html web/*.css supabase/functions/*/index.ts supabase/migrations/*.sql; do
  [ -f "$f" ] || continue
  [ -s "$f" ] || continue
  case "$f" in
    *.js|*.ts) last=$(grep -vE '^\s*(//|\*|/\*|\*/)' "$f" | grep -vE '^\s*$' | tail -n 1 | sed 's/\s*\/\/.*$//' | tr -d '[:space:]' | tail -c 1)
               [ -z "$last" ] || echo "$last" | grep -q '[;})]' || { echo "✗ fin de fichier suspecte (tronqué ?) : $f"; T=1; } ;;
    *.html)    tail -c 300 "$f" | grep -q '</html>' || { echo "✗ index.html ne se termine pas par </html> (tronqué ?) : $f"; T=1; } ;;
    *.css)     last=$(perl -0pe 's:/\*.*?\*/::gs' "$f" | grep -vE '^\s*$' | tail -n 1 | tr -d '[:space:]' | tail -c 1)
               [ -z "$last" ] || [ "$last" = "}" ] || { echo "✗ fin de fichier CSS suspecte : $f"; T=1; } ;;
    *.sql)     last=$(grep -vE '^\s*--' "$f" | grep -vE '^\s*$' | tail -n 1 | sed 's/--.*$//' | tr -d '[:space:]' | tail -c 1)
               [ "$last" = ";" ] || { echo "✗ migration sans point-virgule final (tronquée ?) : $f"; T=1; } ;;
  esac
done
[ $T -eq 0 ] && ok "aucune troncature détectée" || KO=1

# 3. Cohérence des scripts référencés par index.html (fichier manquant = app qui ne charge pas)
if [ -f web/index.html ]; then
  for s in $(grep -o 'src="[^"]*\.js"' web/index.html | sed 's/src="//;s/"//' | grep -v '^http'); do
    [ -f "web/$s" ] || ko "index.html référence un fichier absent : web/$s"
  done
  ok "scripts référencés présents"
fi

# 4. Version : web/version.js, <meta name="version"> et README doivent dire la même chose
V1=$(grep -o "VERSION *= *'[^']*'" web/version.js 2>/dev/null | grep -o "v[0-9][^']*")
V2=$(grep -o '<meta name="version" content="[^"]*"' web/index.html 2>/dev/null | grep -o 'v[0-9][^"]*')
V3=$(grep -o 'Version en production *: *v[0-9][^ ]*' README.md 2>/dev/null | grep -o 'v[0-9][^ ]*')
if [ -z "$V1" ] || [ -z "$V2" ]; then ko "version absente (web/version.js: '${V1:-∅}', meta index.html: '${V2:-∅}')";
elif [ "$V1" != "$V2" ] || { [ -n "$V3" ] && [ "$V3" != "$V1" ]; }; then ko "versions désynchronisées : version.js=$V1 index.html=$V2 README=${V3:-∅}";
else ok "version $V1 cohérente"; fi

# 5. Secrets : le front et le dépôt sont publics (on cherche des VALEURS, pas les mots)
if grep -rnE 'sb_secret_[A-Za-z0-9_]{8,}|sk-ant-[A-Za-z0-9_-]{12,}|eyJhbGciOi[A-Za-z0-9._-]{30,}|-----BEGIN (RSA |EC )?PRIVATE KEY' --include='*.js' --include='*.html' --include='*.ts' --include='*.sql' --include='*.md' --include='*.yml' --include='*.toml' --include='*.json' . 2>/dev/null | grep -v 'scripts/verifier.sh'; then
  ko "une valeur ressemblant à un secret est présente dans le dépôt"; else ok "aucun secret dans le dépôt"; fi
grep -rnE 'service_role' --include='*.js' --include='*.html' web/ 2>/dev/null && ko "référence à la clé service_role dans le front"
[ -f .env ] && ko ".env présent dans l'arborescence (doit rester hors dépôt)"

# 6. Frontière de publication : rien de sensible dans web/ (tout web/ est servi publiquement)
for f in web/*.sql web/*.md web/.env*; do [ -e "$f" ] && ko "fichier non destiné au public dans web/ : $f"; done
ok "web/ ne contient que ce qui doit être servi"

# 7. Migrations rejouables et sûres
for f in supabase/migrations/*.sql; do
  [ -f "$f" ] || continue
  grep -qiE 'drop (table|schema) (public\.)?(calls|app_users|corrections)' "$f" && ko "migration destructive sur une table de données : $f"
  if grep -qiE '^\s*create policy' "$f" && [ "$(basename "$f")" != "20260903000000_init.sql" ]; then
    grep -qiE 'drop policy if exists' "$f" || warn "policy créée sans DROP POLICY IF EXISTS (risque de doublon permissif) : $f"
  fi
done
ok "migrations contrôlées"

# 8. Config des fonctions : verify_jwt=false réservé au webhook
if [ -f supabase/config.toml ]; then
  bad=$(awk '/^\[functions\./{name=$0} /verify_jwt *= *false/{print name}' supabase/config.toml | grep -v 'ringover-webhook')
  [ -n "$bad" ] && ko "verify_jwt=false sur une fonction autre que ringover-webhook : $bad"
  ok "verify_jwt conforme"
fi

echo
if [ $KO -eq 1 ]; then echo "BLOQUÉ — corriger puis relancer."; exit 1; fi
if [ $WARN -eq 1 ]; then echo "VIGILANCE — à exposer à Adrien avant de continuer."; exit 2; fi
echo "OK — déploiement autorisé."; exit 0

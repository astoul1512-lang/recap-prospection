# Champs personnalisés Jarvi utilisés par Récap prospection

Relevé avec `getCustomFields` — **ne jamais écrire un identifiant en dur ailleurs
que dans ce fichier.** Un champ renommé dans Jarvi garde son identifiant ; un
champ supprimé puis recréé en change. C'est ici qu'on le corrige, en un endroit.

## Sociétés (contexte CRM)

| Champ | Type | Identifiant | Usage |
|---|---|---|---|
| **Prospecteur** | choix unique | *à créer — §1 du lot* | Qui est responsable du compte. **Sans valeur, la société n'apparaît pas dans la page Sociétés.** Valeurs : `Adrien`, `Alexandre`, `Julien`, `Martin`, `Rémy`. |
| Secteur activité | choix multiple | `3665fb39-820b-4f19-a876-0899ec1e7a4d` | Alimente `companies.sector`. Déjà en place, rien à créer. |

Les autres champs société existants et non utilisés ici : Priorisée, À enrichir,
Environnement technique, Statut de prospection, Informations commerciales,
Recommandation, Adresse.

## Contacts (contexte CRM)

| Champ | Type | Identifiant | Usage |
|---|---|---|---|
| **Opérationnel** | oui / non | *à créer — §1 du lot* | Personne à joindre absolument. C'est ce champ, et lui seul, qui définit la couverture d'un compte. |

Les autres champs contact existants et non utilisés ici : informations
complémentaires, Vous gérez une équipe de combien de personnes ?, Outils et
langages techniques utilisés, recrutement via cabinet.

## Les cinq prospecteurs

Arrêté avec Adrien le 5 septembre 2026, et recoupé avec les lignes Ringover
réellement actives — Pablo, Floryanne et Sarah ont quitté le cabinet et n'ont
plus de ligne.

| Valeur du champ | Ligne Ringover | Appels enregistrés |
|---|---|---|
| `Rémy` | Rémy Basdim | 227 |
| `Julien` | Julien Fravallo | 153 |
| `Adrien` | Adrien Astoul | 104 |
| `Alexandre` | Alexandre mesnier | 59 |
| `Martin` | Martin Benyekkou | 3 |

Prénom seul : l'équipe compte cinq personnes, aucune ambiguïté, et c'est ce que
la page affiche. Le rapprochement avec la ligne Ringover se fait sur le prénom.

## État

Relevé du 5 septembre 2026 : **les deux champs à créer n'existent pas encore.**
Tant qu'ils ne sont pas là, `jarvi-sync` ne peut rien lire et la page Sociétés
n'a rien à afficher.

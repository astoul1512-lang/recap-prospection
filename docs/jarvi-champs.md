# Champs Jarvi utilisés par Récap prospection

Relevé avec `getCustomFields` — **ne jamais écrire un identifiant en dur ailleurs
que dans ce fichier.** Un champ renommé dans Jarvi garde son identifiant ; un
champ supprimé puis recréé en change. C'est ici qu'on le corrige, en un endroit.

## Rien à créer

Relevé du 13 septembre 2026 : **aucun champ personnalisé n'est à créer pour le
lot « Sociétés »**. Le lot en demandait deux ; aucun n'est nécessaire.

- **« Prospecteur »** → remplacé par le **responsable natif** de la société
  (`assignees`), déjà renseigné dans Jarvi. Voir `docs/decisions.md` D9.
- **« Opérationnel »** → abandonné. Adrien appelle « opérationnels » l'ensemble
  des contacts rattachés à la société dans Jarvi : tous comptent, il n'y a donc
  rien à cocher.

## Sociétés (contexte CRM)

| Donnée | Où la lire | Usage |
|---|---|---|
| **Responsable** | champ natif `assignees[].user.displayName` | Le prospecteur. **Sans responsable, la société n'apparaît pas dans la page Sociétés.** Plusieurs responsables possibles : le compte apparaît alors dans la liste de chacun. |
| Secteur activité | champ personnalisé `3665fb39-820b-4f19-a876-0899ec1e7a4d` (choix multiple) | Alimente `companies.sector`. |

Les autres champs société existants et non utilisés ici : Priorisée, À enrichir,
Environnement technique, Statut de prospection, Informations commerciales,
Recommandation, Adresse.

## Contacts (contexte CRM)

Aucun champ personnalisé utilisé. Tout contact rattaché à la société et marqué
`isContact` entre dans le calcul de couverture.

Les champs contact existants et non utilisés : informations complémentaires,
Vous gérez une équipe de combien de personnes ?, Outils et langages techniques
utilisés, recrutement via cabinet.

## Les prospecteurs

Le rapprochement entre le responsable Jarvi et la ligne Ringover se fait sur le
**prénom** — l'équipe est petite, aucune ambiguïté. Jarvi écrit le nom complet
sans accent (`Remy Basdim`), l'application affiche le prénom accentué (`Rémy`).

Les trois qui prospectent aujourd'hui, arrêté avec Adrien le 13 septembre 2026 :

| Affiché | Responsable Jarvi | Ligne Ringover | Appels enregistrés |
|---|---|---|---|
| `Rémy` | Remy Basdim | Rémy Basdim | 227 |
| `Adrien` | Adrien Astoul | Adrien Astoul | 104 |
| `Martin` | Martin Benyekkou | Martin Benyekkou | 3 |

Julien Fravallo (153 appels) ne fait plus partie de l'effectif ; Alexandre
Mesnier (59 appels) ne prospecte pas. Leurs appels passés restent dans le
rapport — la liste ci-dessus dit qui **attribue** des comptes, pas qui a
téléphoné. La page n'affiche donc pas de liste de prospecteurs en dur : elle
prend les responsables réellement rencontrés dans les données.

// Point d'entrée de l'application.
// Lot 0 : la page d'attente est écrite en dur dans index.html — si ce script
// échoue, la page reste lisible plutôt que blanche. Ici on ne fait qu'afficher
// la version réellement chargée, ce qui permet de vérifier d'un coup d'œil ce
// qui est servi en ligne.
// Lot 1 : routage par hash, connexion Supabase, vues Jour / Semaine / À qualifier.

import { VERSION } from "./version.js";

const cible = document.getElementById("version");
if (cible) cible.textContent = VERSION;

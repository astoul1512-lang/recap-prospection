// classify — dit si un appel est de la prospection, en interrogeant Jarvi.
//
// Trois entrées (SPECS §5.2) :
//  - `?mode=batch`  : rattrapage, appelé par pg_cron avec le jeton de tâche ;
//  - POST {call_ids} : bouton « Revérifier dans Jarvi », appelé par un membre ;
//  - en direct depuis `ringover-webhook`, sans passer par HTTP (classer.ts).
//
// La porte d'entrée est fermée par le portail Supabase (verify_jwt = true) :
// il faut déjà un jeton valide pour arriver ici. Ce fichier vérifie ensuite
// QUI parle — une tâche planifiée ou un membre actif — et refuse le reste.

import { log, logErreur } from "../_shared/log.ts";
import { reponse } from "../_shared/http.ts";
import {
  appelsAClasser,
  appelsParIdentifiants,
  compterRevisitesJarvi,
  configurationPresente,
  jetonCronValide,
  journaliserCorrection,
  utilisateurActif,
} from "../_shared/db.ts";
import { classerAppels } from "../_shared/classer.ts";
import { cleJarviPresente } from "../_shared/jarvi.ts";

const FN = "classify";
// Un lot borné : la fonction doit finir bien avant son délai d'exécution, et
// Jarvi est limité à quelques requêtes par seconde. Ce qui dépasse attend le
// passage suivant, un quart d'heure plus tard.
const LOT_MAX = 60;
const REVISITES_MAX_PAR_HEURE = 60;
const APPELS_MAX_PAR_DEMANDE = 25;

function identifiantsDemandes(corps: unknown): string[] {
  if (!corps || typeof corps !== "object") return [];
  const brut = (corps as Record<string, unknown>).call_ids;
  if (!Array.isArray(brut)) return [];
  return brut
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => v.trim())
    .slice(0, APPELS_MAX_PAR_DEMANDE);
}

Deno.serve(async (req: Request): Promise<Response> => {
  const debut = Date.now();
  if (req.method !== "POST" && req.method !== "GET") return reponse(405);
  if (!configurationPresente() || !cleJarviPresente()) {
    logErreur({ fn: FN, etape: "configuration", jarvi: cleJarviPresente() });
    return reponse(500);
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "";
  const jetonCron = req.headers.get("x-cron-token") ?? "";

  // --- Rattrapage planifié ---------------------------------------------------
  if (mode === "batch") {
    if (!(await jetonCronValide(jetonCron))) {
      log({ fn: FN, etape: "refus", motif: "jeton_tache_invalide" });
      return reponse(401);
    }
    const bruts = await appelsAClasser(LOT_MAX);
    const resultats = await classerAppels(bruts, { origine: "batch" });
    const tranches = resultats.filter((r) => r.kind !== null).length;
    log({
      fn: FN,
      etape: "batch",
      candidats: bruts.length,
      tranches,
      restants: resultats.length - tranches,
      ms: Date.now() - debut,
    });
    return reponse(200, { classes: tranches, restants: resultats.length - tranches });
  }

  // --- Revérification demandée par un membre ---------------------------------
  const autorisation = req.headers.get("Authorization") ?? "";
  const userId = autorisation ? await utilisateurActif(autorisation) : null;
  if (!userId) {
    log({ fn: FN, etape: "refus", motif: "non_authentifie" });
    return reponse(401);
  }

  let corps: unknown = null;
  try {
    corps = await req.json();
  } catch {
    corps = null;
  }
  const ids = identifiantsDemandes(corps);
  if (!ids.length) return reponse(400, { erreur: "call_ids requis" });

  // Le plafond protège Jarvi d'un clic répété, et la facture de personne :
  // c'est un garde-fou d'usage, pas une punition. Compté sur une heure glissante.
  const deja = await compterRevisitesJarvi(userId);
  if (deja + ids.length > REVISITES_MAX_PAR_HEURE) {
    log({ fn: FN, etape: "refus", motif: "plafond_revisites", deja });
    return reponse(429, { erreur: "trop de revérifications, réessayez dans une heure" });
  }

  const bruts = await appelsParIdentifiants(ids);
  const resultats = await classerAppels(bruts, { force: true, origine: "utilisateur" });

  // Journal d'usage : qui a redemandé quoi, et quand (SPECS §5.2.5).
  for (const resultat of resultats) {
    await journaliserCorrection({
      call_id: resultat.call_id,
      field: "jarvi_recheck",
      new_value: resultat.kind,
      author_id: userId,
    });
  }

  log({
    fn: FN,
    etape: "utilisateur",
    demandes: ids.length,
    traites: resultats.length,
    ms: Date.now() - debut,
  });
  return reponse(200, { updated: resultats });
});

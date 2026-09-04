// reconcile — la nuit, Ringover a le dernier mot.
//
// Un webhook peut se perdre : coupure réseau, fonction indisponible, événement
// jamais renvoyé. Sans contrôle, ces trous seraient invisibles — le rapport
// paraîtrait juste, simplement plus maigre. Cette fonction compare donc chaque
// journée écoulée à ce que dit l'API Ringover, rapatrie ce qui manque, et
// marque la journée complète ou incomplète (SPECS §1.1.7 et §5.4).
//
// Elle ne corrige jamais un appel existant : le webhook a vu l'appel de plus
// près (il connaît `is_internal`, la durée exacte, le tag posé après coup).
// Elle ne fait qu'ajouter ce qui n'existait pas.

import { log, logErreur } from "../_shared/log.ts";
import { reponse } from "../_shared/http.ts";
import { estJourValide, veilleParis } from "../_shared/dates.ts";
import {
  appelantEstAdmin,
  appelsAClasser,
  compterAppelsDuJour,
  configurationPresente,
  enregistrerJourneeVerifiee,
  enregistrerRingoverUser,
  insererAppelSiAbsent,
  jetonCronValide,
  noterPassageTache,
} from "../_shared/db.ts";
import { appelsDuJour, cleRingoverPresente, collaborateur } from "../_shared/ringover.ts";
import { classerAppels } from "../_shared/classer.ts";
import { ligneAppel } from "./ligne.ts";

const FN = "reconcile";
const A_CLASSER_MAX = 200;

Deno.serve(async (req: Request): Promise<Response> => {
  const debut = Date.now();
  if (req.method !== "POST" && req.method !== "GET") return reponse(405);
  if (!configurationPresente() || !cleRingoverPresente()) {
    logErreur({ fn: FN, etape: "configuration", ringover: cleRingoverPresente() });
    return reponse(500);
  }

  // Deux appelants légitimes : la tâche planifiée, et Adrien depuis l'écran
  // d'administration (« relancer la réconciliation »).
  const jetonCron = req.headers.get("x-cron-token") ?? "";
  const autorisation = req.headers.get("Authorization") ?? "";
  const parCron = await jetonCronValide(jetonCron);
  if (!parCron && !(autorisation && await appelantEstAdmin(autorisation))) {
    log({ fn: FN, etape: "refus", motif: "non_autorise" });
    return reponse(401);
  }

  const demande = new URL(req.url).searchParams.get("day");
  const jour = estJourValide(demande) ? demande : veilleParis();

  const resultat = await appelsDuJour(jour);
  if (resultat.etat === "injoignable") {
    // On ne touche pas à `day_status` : une journée dont on n'a pas pu
    // demander le compte n'est ni complète ni incomplète, elle est inconnue.
    // La marquer incomplète ferait passer une panne de Ringover pour une perte
    // d'appels.
    logErreur({ fn: FN, etape: "ringover", jour, motif: resultat.motif });
    return reponse(502, { erreur: "ringover_injoignable" });
  }

  let ajoutes = 0;
  for (const appel of resultat.appels) {
    const ligne = ligneAppel(appel);
    if (!ligne) continue;
    const equipier = collaborateur(appel);
    if (equipier) await enregistrerRingoverUser(equipier);
    ajoutes += await insererAppelSiAbsent(ligne);
  }

  // Les nouveaux venus n'ont pas été soumis à Jarvi : on les classe maintenant,
  // avec tout ce qui traînait encore en attente.
  const enAttente = await appelsAClasser(A_CLASSER_MAX);
  const classes = await classerAppels(enAttente, { origine: "reconcile" });

  const enBase = await compterAppelsDuJour(jour);
  const parWebhook = await compterAppelsDuJour(jour, "webhook");
  const attendus = resultat.appels.length;
  const complete = enBase >= attendus;

  await enregistrerJourneeVerifiee({
    day: jour,
    webhook_count: parWebhook,
    api_count: attendus,
    complete,
    checked_at: new Date().toISOString(),
  });

  const bilan = {
    jour,
    attendus,
    en_base: enBase,
    par_webhook: parWebhook,
    ajoutes,
    classes: classes.filter((c) => c.kind !== null).length,
    complete,
  };
  await noterPassageTache(FN, bilan);
  log({ fn: FN, etape: "termine", ...bilan, ms: Date.now() - debut });

  return reponse(200, bilan);
});

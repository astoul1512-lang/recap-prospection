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
import { ajouterJoursParis, estJourValide, veilleParis } from "../_shared/dates.ts";
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
import { ligneAppel, lignesDuCabinet } from "./ligne.ts";

const FN = "reconcile";
const A_CLASSER_MAX = 200;
// Rattrapage : Ringover n'accepte qu'une fenêtre de quinze jours, et la vue de
// travail de la routine n'en regarde que sept. Au-delà, on rapatrierait des
// appels que plus rien ne viendrait résumer.
const JOURS_MAX = 7;

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

  const parametres = new URL(req.url).searchParams;
  const demande = parametres.get("day");
  // `?jours=N` rattrape N journées d'affilée, la plus récente en premier.
  const demandeJours = Number(parametres.get("jours") ?? "1");
  const nombreJours = Number.isFinite(demandeJours)
    ? Math.min(Math.max(Math.trunc(demandeJours), 1), JOURS_MAX)
    : 1;
  const premierJour = estJourValide(demande) ? demande : veilleParis();
  const jours = Array.from({ length: nombreJours }, (_, i) => ajouterJoursParis(premierJour, -i));

  let ajoutes = 0;
  let attendusTotal = 0;
  const journees: Record<string, unknown>[] = [];

  for (const jour of jours) {
    const resultat = await appelsDuJour(jour);
    if (resultat.etat === "injoignable") {
      // On ne touche pas à `day_status` : une journée dont on n'a pas pu
      // demander le compte n'est ni complète ni incomplète, elle est inconnue.
      // La marquer incomplète ferait passer une panne de Ringover pour une
      // perte d'appels.
      logErreur({ fn: FN, etape: "ringover", jour, motif: resultat.motif });
      if (journees.length === 0) return reponse(502, { erreur: "ringover_injoignable" });
      break;
    }

    // Les lignes du cabinet se déduisent des appels de la journée : c'est ce
    // qui permet de reconnaître un appel interne, que l'API REST ne signale pas.
    const internes = lignesDuCabinet(resultat.appels);

    for (const appel of resultat.appels) {
      const ligne = ligneAppel(appel, internes);
      if (!ligne) continue;
      const equipier = collaborateur(appel);
      if (equipier) await enregistrerRingoverUser(equipier);
      ajoutes += await insererAppelSiAbsent(ligne);
    }

    const enBase = await compterAppelsDuJour(jour);
    const parWebhook = await compterAppelsDuJour(jour, "webhook");
    const attendus = resultat.appels.length;
    attendusTotal += attendus;
    const complete = enBase >= attendus;

    await enregistrerJourneeVerifiee({
      day: jour,
      webhook_count: parWebhook,
      api_count: attendus,
      complete,
      checked_at: new Date().toISOString(),
    });
    journees.push({ jour, attendus, en_base: enBase, par_webhook: parWebhook, complete });
  }

  // Les nouveaux venus n'ont pas été soumis à Jarvi : on les classe maintenant,
  // avec tout ce qui traînait encore en attente.
  const enAttente = await appelsAClasser(A_CLASSER_MAX);
  const classes = await classerAppels(enAttente, { origine: "reconcile" });

  const bilan = {
    jours: journees.length,
    du: journees[journees.length - 1]?.jour ?? premierJour,
    au: premierJour,
    attendus: attendusTotal,
    ajoutes,
    classes: classes.filter((c) => c.kind !== null).length,
    complete: journees.every((j) => j.complete === true),
    journees,
  };
  await noterPassageTache(FN, bilan);
  log({ fn: FN, etape: "termine", ...bilan, ms: Date.now() - debut });

  return reponse(200, bilan);
});

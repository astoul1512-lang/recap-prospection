// fetch-transcript — rapatrie les transcriptions Ringover dans la base.
//
// Pourquoi les stocker plutôt que de les lire à la demande (docs/decisions.md,
// D7) : la routine du soir n'a alors qu'un seul endroit où regarder, elle ne
// dépend d'aucune clé d'API, et l'équipe peut relire un échange depuis la
// fiche appel. Ringover reste la source, la base en est la copie de travail.
//
// Deux prudences qui gouvernent tout ce fichier :
//  - on ne prend que les transcriptions annoncées terminées (`DONE`). Une
//    transcription partielle produirait un résumé faux, et un résumé faux ne
//    se voit pas ;
//  - un refus d'accès (401) arrête la boucle immédiatement. Insister trente
//    fois sur une option désactivée ne fait qu'user le quota et brouiller le
//    journal.

import { log, logErreur } from "../_shared/log.ts";
import { reponse } from "../_shared/http.ts";
import {
  appelantEstAdmin,
  appelsSansTranscription,
  configurationPresente,
  jetonCronValide,
  modifierAppel,
  noterPassageTache,
} from "../_shared/db.ts";
import { cleRingoverPresente, type SondeTranscription, transcription } from "../_shared/ringover.ts";

const FN = "fetch-transcript";
const LOT_MAX = 30;
const ESSAIS_MAX = 6;
// Ringover accepte deux requêtes par seconde et par clé.
const PAUSE_MS = 500;
// Une transcription d'une heure d'appel tient largement là-dedans ; au-delà,
// c'est une anomalie qu'on ne veut pas voir grossir la base.
const CARACTERES_MAX = 60_000;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req: Request): Promise<Response> => {
  const debut = Date.now();
  if (req.method !== "POST" && req.method !== "GET") return reponse(405);
  if (!configurationPresente() || !cleRingoverPresente()) {
    logErreur({ fn: FN, etape: "configuration", ringover: cleRingoverPresente() });
    return reponse(500);
  }

  const jetonCron = req.headers.get("x-cron-token") ?? "";
  const autorisation = req.headers.get("Authorization") ?? "";
  const parCron = await jetonCronValide(jetonCron);
  if (!parCron && !(autorisation && await appelantEstAdmin(autorisation))) {
    log({ fn: FN, etape: "refus", motif: "non_autorise" });
    return reponse(401);
  }

  const attente = await appelsSansTranscription(LOT_MAX, ESSAIS_MAX);

  let recuperees = 0;
  let enCours = 0;
  let absentes = 0;
  let refus = 0;
  let injoignable: string | null = null;
  // Les premières sondes sont conservées telles quelles : c'est ce qui permet
  // de documenter la forme réelle des réponses sans jamais faire transiter la
  // clé ni le contenu des conversations (docs/ringover-api.md).
  const sondes: SondeTranscription[] = [];

  for (const brut of attente) {
    const callId = typeof brut.call_id === "string" ? brut.call_id : "";
    if (!callId) continue;
    const essais = typeof brut.transcript_attempts === "number" ? brut.transcript_attempts : 0;

    const resultat = await transcription(callId);
    if (resultat.etat !== "injoignable" && sondes.length < 3) sondes.push(resultat.sonde);

    if (resultat.etat === "injoignable") {
      injoignable = resultat.motif;
      break;
    }
    if (resultat.etat === "refuse") {
      refus++;
      break;
    }

    if (resultat.etat === "prete") {
      const texte = resultat.texte.slice(0, CARACTERES_MAX);
      await modifierAppel(callId, {
        transcript: texte,
        transcript_source: "ringover_api",
        transcript_fetched_at: new Date().toISOString(),
        transcript_attempts: essais + 1,
      }, null);
      recuperees++;
    } else {
      // Pas encore prête, ou introuvable : on compte l'essai et on repassera.
      if (resultat.etat === "absente") absentes++;
      else enCours++;
      await modifierAppel(callId, { transcript_attempts: essais + 1 }, null);
    }

    await pause(PAUSE_MS);
  }

  const bilan = {
    candidats: attente.length,
    recuperees,
    en_cours: enCours,
    absentes,
    refus,
    injoignable,
    sondes,
  };
  await noterPassageTache("transcripts", bilan);
  log({ fn: FN, etape: "termine", ...bilan, sondes: sondes.length, ms: Date.now() - debut });

  // Un refus d'accès n'est pas une panne de la fonction : elle a fait son
  // travail et rapporte ce qu'elle a vu. C'est l'écran d'administration qui
  // doit alerter, pas un code d'erreur que personne ne lit.
  return reponse(200, { ...bilan, sondes: sondes.length });
});

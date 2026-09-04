// Point d'entrée des webhooks Ringover — la seule fonction ouverte sans JWT.
// Sa sécurité tient à un seul contrôle : la signature HS512 (SPECS §5.1).
//
// Ordre volontaire des contrôles : d'abord ce qui ne coûte rien (méthode,
// taille), puis la signature, et seulement ensuite la moindre écriture en base.
// Un point d'entrée public qui écrit avant d'avoir vérifié qui l'appelle est
// une invitation à remplir la base gratuitement.

import { log, logErreur, numeroMasque } from "../_shared/log.ts";
import { reponse } from "../_shared/http.ts";
import { verifierJwtHs512 } from "../_shared/signature.ts";
import { analyserTemps, ecartMinutes } from "../_shared/dates.ts";
import {
  configurationPresente,
  enregistrerRingoverUser,
  insererAppelSiAbsent,
  journaliserEvenement,
  modifierAppel,
} from "../_shared/db.ts";
import { construirePlan, lireEnveloppe } from "./plan.ts";

const FN = "ringover-webhook";
const TAILLE_MAX = 64 * 1024;
const FENETRE_REJEU_MIN = 5;
const INVALIDES_MAX = 20;
const FENETRE_INVALIDES_MS = 5 * 60 * 1000;
// Au-delà, on refuse toujours mais on cesse d'écrire : le journal ne doit pas
// devenir le levier d'une saturation de la base.
const INVALIDES_JOURNALISEES_MAX = 3;

const invalidesParIp = new Map<string, number[]>();

function compterInvalide(ip: string): number {
  const maintenant = Date.now();
  const recentes = (invalidesParIp.get(ip) ?? []).filter((t) => maintenant - t < FENETRE_INVALIDES_MS);
  recentes.push(maintenant);
  invalidesParIp.set(ip, recentes);
  // Ménage : sans ça la carte grossit indéfiniment sur une instance longue.
  if (invalidesParIp.size > 500) {
    for (const [autre, dates] of invalidesParIp) {
      if (dates.every((t) => maintenant - t >= FENETRE_INVALIDES_MS)) invalidesParIp.delete(autre);
    }
  }
  return recentes.length;
}

function adresse(req: Request): string {
  const entete = req.headers.get("x-forwarded-for");
  return entete ? entete.split(",")[0].trim() : "inconnue";
}

Deno.serve(async (req: Request): Promise<Response> => {
  const debut = Date.now();

  if (req.method !== "POST") return reponse(405);

  const ip = adresse(req);
  const secret = Deno.env.get("ringover_webhook");
  if (!secret || !configurationPresente()) {
    logErreur({ fn: FN, etape: "configuration", secret_present: Boolean(secret) });
    return reponse(500);
  }

  // 1. Taille : refusée avant toute lecture JSON et toute écriture.
  const brut = await req.text();
  if (brut.length > TAILLE_MAX) {
    log({ fn: FN, etape: "refus", motif: "charge_trop_grande", octets: brut.length });
    return reponse(400);
  }

  let corps: unknown = null;
  try {
    corps = JSON.parse(brut);
  } catch {
    corps = null;
  }
  const enveloppe = lireEnveloppe(corps);

  // 2. Signature — le contrôle qui compte.
  const jeton = req.headers.get("X-Ringover-Webhook-Signature") ??
    req.headers.get("x-ringover-webhook-signature") ?? "";
  const controle = await verifierJwtHs512(jeton, secret);

  if (!controle.valide) {
    const nb = compterInvalide(ip);
    if (nb <= INVALIDES_JOURNALISEES_MAX) {
      await journaliserEvenement(enveloppe?.event ?? "inconnu", null, enveloppe?.attempt ?? null, false, corps ?? {});
    }
    log({
      fn: FN,
      etape: "refus",
      motif: controle.motif,
      alg_recu: controle.alg,
      invalides_5min: nb,
      journalise: nb <= INVALIDES_JOURNALISEES_MAX,
      ms: Date.now() - debut,
    });
    return reponse(nb > INVALIDES_MAX ? 429 : 401);
  }

  // 3. Forme du message.
  if (!enveloppe) {
    await journaliserEvenement("illisible", null, null, true, corps ?? {});
    log({ fn: FN, etape: "refus", motif: "enveloppe_illisible" });
    return reponse(400);
  }

  // 4. Anti-rejeu. L'unité de `timestamp` n'est pas encore confirmée contre la
  // vraie API (docs/A_VERIFIER.md n°1) : si l'horodatage est illisible on
  // journalise et on continue, plutôt que de refuser tous les appels
  // légitimes. La signature, elle, a déjà été vérifiée.
  const analyse = analyserTemps(enveloppe.timestamp);
  const ecart = ecartMinutes(enveloppe.timestamp);
  if (ecart !== null && ecart > FENETRE_REJEU_MIN) {
    await journaliserEvenement(enveloppe.event, null, enveloppe.attempt, true, corps ?? {});
    log({ fn: FN, etape: "refus", motif: "hors_fenetre", ecart_min: Math.round(ecart), unite: analyse.unite });
    return reponse(401);
  }
  const horodatageMs = analyse.date ? analyse.date.getTime() : Date.now();

  // 5. Journal brut : toujours, avant traitement. C'est lui qui permettra de
  // comprendre le premier vrai appel et de remplir docs/A_VERIFIER.md.
  const plan = construirePlan(enveloppe, horodatageMs);
  await journaliserEvenement(enveloppe.event, plan.callId, enveloppe.attempt, true, corps ?? {});

  if (plan.ignore) {
    log({ fn: FN, etape: "ignore", evenement: enveloppe.event, motif: plan.ignore, ms: Date.now() - debut });
    return reponse(204);
  }

  // 6. Écritures. Le collaborateur d'abord : calls.ringover_user_id est une
  // clé étrangère, l'insertion de l'appel échouerait sinon.
  try {
    if (plan.ringoverUser) await enregistrerRingoverUser(plan.ringoverUser);
    if (plan.insertion) await insererAppelSiAbsent(plan.insertion);

    let lignes = 0;
    if (plan.modification && plan.callId) {
      lignes = await modifierAppel(plan.callId, plan.modification, plan.ordonne ? horodatageMs : null);
    }

    log({
      fn: FN,
      etape: "traite",
      evenement: enveloppe.event,
      call_id: plan.callId,
      numero: numeroMasque(plan.insertion?.external_number as string | undefined),
      lignes_modifiees: lignes,
      unite_horodatage: analyse.unite,
      tentative: enveloppe.attempt,
      ms: Date.now() - debut,
    });
  } catch (erreur) {
    // On répond quand même 204 : l'événement est déjà dans le journal brut,
    // et faire réessayer Ringover en boucle sur une panne base n'aide personne.
    logErreur({
      fn: FN,
      etape: "ecriture",
      evenement: enveloppe.event,
      call_id: plan.callId,
      erreur: erreur instanceof Error ? erreur.message : "inconnue",
    });
  }

  return reponse(204);
});

// Orchestration du classement : cache, appel à Jarvi, écriture en base.
// Partagée entre `ringover-webhook` (classement immédiat, dans le même
// exécutable) et `classify` (rattrapage par lots, revérification manuelle).
//
// Principe de prudence : quand Jarvi ne répond pas, on ne conclut rien et on
// laisse l'appel en `a_classer`. Le traitement par lots repassera. Conclure
// « inconnu » sur une panne réseau remplirait la file « À qualifier » de faux
// inconnus, et le rapport serait faux sans que personne ne le voie.

import { chercherParNumero, type ProfilJarvi } from "./jarvi.ts";
import {
  type AppelAClasser,
  choisirProfil,
  classer,
  type Genre,
  ligneCache,
  profilDepuisCache,
} from "./classement.ts";
import { ecrireCacheJarvi, lireCacheJarvi, modifierAppel } from "./db.ts";
import { log, numeroMasque } from "./log.ts";

const CACHE_VALIDE_MS = 30 * 24 * 3600 * 1000;

export type Resultat = {
  call_id: string;
  kind: Genre | null; // null : non tranché, Jarvi injoignable
  contact_name?: string | null;
  company_name?: string | null;
};

export type Options = {
  // « Revérifier dans Jarvi » : on ignore le cache, le contact vient peut-être
  // d'être créé — c'est tout l'intérêt du bouton.
  force?: boolean;
  origine: string;
};

export function lireAppel(brut: Record<string, unknown>): AppelAClasser | null {
  const callId = typeof brut.call_id === "string" ? brut.call_id : "";
  if (!callId) return null;
  const chaine = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    call_id: callId,
    external_number: chaine(brut.external_number) ?? "",
    is_internal: brut.is_internal === true,
    is_anonymous: brut.is_anonymous === true,
    status: chaine(brut.status) ?? "",
    duration_s: typeof brut.duration_s === "number" ? brut.duration_s : null,
    outcome: chaine(brut.outcome) ?? "tentative",
    outcome_manual: chaine(brut.outcome_manual),
    kind_manual: chaine(brut.kind_manual),
    machine_detection: chaine(brut.machine_detection),
    reviewed_at: chaine(brut.reviewed_at),
  };
}

type Consultation = { profil: ProfilJarvi | null; trouve: boolean } | null;

// Une seule recherche par numéro et par exécution : un même prospect est
// souvent rappelé plusieurs fois dans la journée, et Jarvi est limité en débit.
async function consulter(
  e164: string,
  force: boolean,
  memoire: Map<string, Consultation>,
): Promise<Consultation> {
  if (memoire.has(e164)) return memoire.get(e164) ?? null;

  if (!force) {
    const cache = await lireCacheJarvi(e164);
    const age = cache?.fetched_at ? Date.now() - Date.parse(String(cache.fetched_at)) : Infinity;
    if (cache && age < CACHE_VALIDE_MS) {
      const resultat = { profil: profilDepuisCache(cache), trouve: cache.found === true };
      memoire.set(e164, resultat);
      return resultat;
    }
  }

  const reponse = await chercherParNumero(e164);
  if (reponse.etat === "injoignable") {
    memoire.set(e164, null);
    return null;
  }

  const profil = reponse.etat === "trouve" ? choisirProfil(reponse.profils, e164) : null;
  await ecrireCacheJarvi(ligneCache(e164, profil));
  const resultat = { profil, trouve: reponse.etat === "trouve" && profil !== null };
  memoire.set(e164, resultat);
  return resultat;
}

export async function classerAppels(
  bruts: Record<string, unknown>[],
  options: Options,
): Promise<Resultat[]> {
  const memoire = new Map<string, Consultation>();
  const resultats: Resultat[] = [];

  for (const brut of bruts) {
    const appel = lireAppel(brut);
    if (!appel) continue;

    const horsJarvi = appel.is_internal || appel.is_anonymous ||
      !appel.external_number.startsWith("+");

    let consultation: Consultation = { profil: null, trouve: false };
    if (!horsJarvi) {
      consultation = await consulter(appel.external_number, options.force === true, memoire);
      if (consultation === null) {
        // Jarvi muet : l'appel reste `a_classer`, on n'écrit rien.
        resultats.push({ call_id: appel.call_id, kind: null });
        continue;
      }
    }

    const decision = classer({
      appel,
      profil: consultation.profil,
      trouve: consultation.trouve,
    });

    const compte = typeof brut.jarvi_check_count === "number" ? brut.jarvi_check_count : 0;
    await modifierAppel(appel.call_id, {
      ...decision.champs,
      jarvi_checked_at: new Date().toISOString(),
      jarvi_check_count: compte + 1,
    }, null);

    log({
      fn: "classer",
      origine: options.origine,
      call_id: appel.call_id,
      numero: numeroMasque(appel.external_number),
      kind: decision.kind,
      force: options.force === true,
    });

    resultats.push({
      call_id: appel.call_id,
      kind: decision.kind,
      contact_name: (decision.champs.contact_name as string | null) ?? null,
      company_name: (decision.champs.company_name as string | null) ?? null,
    });
  }

  return resultats;
}

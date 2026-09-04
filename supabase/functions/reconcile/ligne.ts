// Traduction d'un appel de l'API REST Ringover en ligne de la table `calls` —
// logique pure, testable sans réseau.
//
// Ces lignes-là arrivent par rattrapage : le webhook les a manquées. Elles
// doivent être indiscernables de celles qu'il aurait écrites, sinon les
// compteurs diffèreraient selon le chemin qu'un appel a pris pour arriver.

import { jourParis, versISO } from "../_shared/dates.ts";
import { numeroExterneOuDefaut, sensRingover } from "../_shared/phone.ts";
import {
  collaborateur,
  dureeAppel,
  etatDepuisRingover,
  identifiant,
  type AppelRingover,
} from "../_shared/ringover.ts";
import { SEUIL_CONVERSATION_S } from "../ringover-webhook/plan.ts";

export function etiquettes(appel: AppelRingover): string[] {
  if (!Array.isArray(appel.tags)) return [];
  return appel.tags
    .map((t) => {
      if (typeof t === "string") return t;
      if (t && typeof t === "object") {
        const nom = (t as Record<string, unknown>).name;
        return typeof nom === "string" ? nom : "";
      }
      return "";
    })
    .filter((t) => t !== "");
}

function rdv(tags: string[]): boolean {
  return tags.some((t) => /(^|[^a-z])rdv([^a-z]|$)/i.test(t));
}

// L'API REST ne dit pas si un appel est anonyme : on le déduit de l'absence de
// numéro chez l'interlocuteur.
export function estAnonyme(appel: AppelRingover): boolean {
  const numero = String(appel.from_number ?? "").trim().toLowerCase();
  return numero === "" || numero === "anonymous" || numero === "anonyme";
}

export function ligneAppel(appel: AppelRingover): Record<string, unknown> | null {
  const callId = identifiant(appel);
  if (!callId) return null;

  const debutISO = versISO(appel.start_time);
  if (!debutISO) return null; // sans date de début, la ligne serait inexploitable

  const direction = String(appel.direction ?? "");
  const duree = dureeAppel(appel);
  const tags = etiquettes(appel);
  const repondeur = appel.amd === true && duree < SEUIL_CONVERSATION_S;
  const etat = repondeur ? "voicemail" : etatDepuisRingover(appel);

  let issue: string;
  if (rdv(tags)) issue = "rdv";
  else if (etat !== "answered") issue = "tentative";
  else issue = duree >= SEUIL_CONVERSATION_S ? "conversation" : "court";

  const anonyme = estAnonyme(appel);
  const ligne: Record<string, unknown> = {
    call_id: callId,
    channel_id: typeof appel.channel_id === "string" ? appel.channel_id : null,
    direction: sensRingover(direction),
    external_number: numeroExterneOuDefaut(direction, appel.from_number, appel.to_number),
    ringover_user_id: collaborateur(appel)?.ringover_user_id ?? null,
    started_at: debutISO,
    answered_at: versISO(appel.answered_time),
    ended_at: versISO(appel.end_time),
    duration_s: duree,
    status: etat,
    // L'API REST ne porte pas `is_internal` : seuls les webhooks le donnent.
    // Un appel interne rattrapé par ce chemin sera donc soumis à Jarvi, qui ne
    // le connaîtra pas, et finira « à qualifier ». Rare et sans danger : mieux
    // vaut une question de trop qu'un appel perdu.
    is_internal: false,
    is_anonymous: anonyme,
    outcome: issue,
    machine_detection: appel.amd === true ? "MACHINE" : null,
    record_link: typeof appel.record === "string" && appel.record ? appel.record : null,
    tags,
    source: "api",
    day: jourParis(new Date(debutISO)),
    last_event_ts: 0, // un webhook tardif reste prioritaire sur ce rattrapage
  };

  if (issue === "rdv") ligne.situation = "rdv";
  if (issue === "court" && !anonyme) {
    ligne.needs_review = true;
    ligne.review_reason = "court";
  }
  return ligne;
}

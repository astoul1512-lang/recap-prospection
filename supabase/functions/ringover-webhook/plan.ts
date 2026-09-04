// Traduction d'un événement Ringover en écritures base — logique pure, sans
// réseau ni base, pour être testable intégralement (SPECS §10).
// `index.ts` se contente d'exécuter le plan produit ici.

import { jourParis, versISO } from "../_shared/dates.ts";
import { numeroExterneOuDefaut, sensRingover } from "../_shared/phone.ts";

export type Enveloppe = {
  event: string;
  timestamp: unknown;
  data: Record<string, unknown>;
  attempt: number | null;
};

export type Plan = {
  callId: string | null;
  ringoverUser: { ringover_user_id: string; display_name: string; email: string | null } | null;
  insertion: Record<string, unknown> | null;
  modification: Record<string, unknown> | null;
  // Les événements « tardifs » (enregistrement disponible, tags, commentaires)
  // arrivent après le raccrochage : ils ne doivent pas être écartés par le
  // contrôle d'ordre, sinon on perdrait le tag « RDV ».
  ordonne: boolean;
  ignore: string | null;
};

const EVENEMENTS_CONNUS = [
  "ringing",
  "answered",
  "hangup",
  "missed",
  "voicemail",
  "record_available",
  "tags_updated",
  "comments_updated",
] as const;

export function evenementConnu(nom: string): boolean {
  return (EVENEMENTS_CONNUS as readonly string[]).includes(nom);
}

export function lireEnveloppe(corps: unknown): Enveloppe | null {
  if (!corps || typeof corps !== "object") return null;
  const o = corps as Record<string, unknown>;
  const event = typeof o.event === "string" ? o.event.trim() : "";
  if (!event) return null;
  const data = (o.data && typeof o.data === "object") ? o.data as Record<string, unknown> : {};
  const attempt = typeof o.attempt === "number" ? o.attempt : null;
  return { event, timestamp: o.timestamp, data, attempt };
}

export function identifiantAppel(data: Record<string, unknown>): string | null {
  for (const clef of ["call_id", "callId", "id"]) {
    const v = data[clef];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

// Un tag « RDV » posé dans Ringover vaut rendez-vous (SPECS §5.7).
export function tagRdv(tags: unknown): boolean {
  if (!Array.isArray(tags)) return false;
  return tags.some((t) => typeof t === "string" && /(^|[^a-z])rdv([^a-z]|$)/i.test(t));
}

export type Issue = "tentative" | "court" | "conversation" | "rdv";

export function issueAutomatique(
  statut: string,
  dureeS: number | null,
  tags: unknown,
): Issue {
  if (tagRdv(tags)) return "rdv";
  if (statut !== "answered") return "tentative";
  return (dureeS ?? 0) >= 60 ? "conversation" : "court";
}

function duree(data: Record<string, unknown>): number | null {
  for (const clef of ["duration_in_seconds", "duration", "total_duration"]) {
    const v = data[clef];
    if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.round(v));
    if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  }
  return null;
}

function booleen(v: unknown): boolean {
  return v === true || v === "true" || v === 1;
}

function collaborateur(data: Record<string, unknown>): Plan["ringoverUser"] {
  const id = data.user_id;
  const identifiant = (typeof id === "string" && id.trim())
    ? id.trim()
    : (typeof id === "number" && Number.isFinite(id) ? String(id) : null);
  if (!identifiant) return null;
  const u = (data.user && typeof data.user === "object") ? data.user as Record<string, unknown> : {};
  const prenom = typeof u.firstname === "string" ? u.firstname.trim() : "";
  const nom = typeof u.lastname === "string" ? u.lastname.trim() : "";
  const affiche = [prenom, nom].filter(Boolean).join(" ") || `Ringover ${identifiant}`;
  return {
    ringover_user_id: identifiant,
    display_name: affiche,
    email: typeof u.email === "string" && u.email.trim() ? u.email.trim() : null,
  };
}

// Ligne minimale, suffisante pour que l'appel existe même si `ringing` n'est
// jamais arrivé ou arrive après : on ne perd jamais un appel à cause de l'ordre.
export function insertionMinimale(
  callId: string,
  data: Record<string, unknown>,
  horodatageMs: number,
): Record<string, unknown> {
  const direction = String(data.direction ?? "");
  const debut = versISO(data.start_time) ?? versISO(data.answered_time) ??
    new Date(horodatageMs).toISOString();
  return {
    call_id: callId,
    channel_id: typeof data.channel_id === "string" ? data.channel_id : null,
    direction: sensRingover(direction),
    external_number: numeroExterneOuDefaut(direction, data.from_number, data.to_number),
    ringover_user_id: collaborateur(data)?.ringover_user_id ?? null,
    started_at: debut,
    status: "ringing",
    is_internal: booleen(data.is_internal),
    is_anonymous: booleen(data.is_anonymous),
    source: "webhook",
    day: jourParis(new Date(debut)),
    last_event_ts: horodatageMs,
  };
}

export function construirePlan(enveloppe: Enveloppe, horodatageMs: number): Plan {
  const { event, data } = enveloppe;
  const callId = identifiantAppel(data);
  const base: Plan = {
    callId,
    ringoverUser: collaborateur(data),
    insertion: null,
    modification: null,
    ordonne: true,
    ignore: null,
  };

  if (!evenementConnu(event)) return { ...base, ignore: "evenement_inconnu" };
  if (!callId) return { ...base, ignore: "call_id_absent" };

  base.insertion = insertionMinimale(callId, data, horodatageMs);

  switch (event) {
    case "ringing":
      // L'insertion minimale contient déjà tout ce que porte `ringing`.
      return base;

    case "answered":
      base.modification = {
        status: "answered",
        answered_at: versISO(data.answered_time) ?? new Date(horodatageMs).toISOString(),
      };
      return base;

    case "hangup": {
      const dureeS = duree(data);
      const repondu = data.answered_time !== undefined && data.answered_time !== null
        ? true
        : String(data.status ?? "").toLowerCase() === "answered" || (dureeS ?? 0) > 0;
      const statut = repondu ? "answered" : "ended";
      const issue = issueAutomatique(statut, dureeS, data.tags);
      const modification: Record<string, unknown> = {
        status: statut,
        ended_at: versISO(data.hangup_time) ?? new Date(horodatageMs).toISOString(),
        duration_s: dureeS,
        outcome: issue,
      };
      if (typeof data.record === "string" && data.record) modification.record_link = data.record;
      if (issue === "rdv") modification.situation = "rdv";
      // Un appel décroché de moins d'une minute doit être tranché à la main
      // (répondeur ? bâché ? vraie conversation ?) — SPECS §1.1.4.
      // Les appels internes et anonymes sortent du rapport : on ne les met pas
      // dans la file, ils n'y ont pas leur place.
      if (issue === "court" && !booleen(data.is_internal) && !booleen(data.is_anonymous)) {
        modification.needs_review = true;
        modification.review_reason = "court";
      }
      base.modification = modification;
      return base;
    }

    case "missed":
      base.modification = {
        status: "missed",
        ended_at: versISO(data.hangup_time) ?? new Date(horodatageMs).toISOString(),
        outcome: "tentative",
      };
      return base;

    case "voicemail":
      base.modification = {
        status: "voicemail",
        duration_s: duree(data),
        ended_at: versISO(data.hangup_time) ?? new Date(horodatageMs).toISOString(),
        outcome: "tentative",
      };
      return base;

    case "record_available": {
      const lien = typeof data.record_link === "string" && data.record_link
        ? data.record_link
        : (typeof data.record === "string" ? data.record : null);
      if (!lien) return { ...base, ignore: "lien_enregistrement_absent" };
      base.modification = { record_link: lien };
      base.ordonne = false;
      // Ces événements ne portent ni sens, ni numéro, ni collaborateur : créer
      // une ligne à partir d'eux fabriquerait un appel faux. S'ils arrivent
      // pour un appel inconnu, on les journalise et la réconciliation nocturne
      // rattrapera l'appel depuis l'API Ringover.
      base.insertion = null;
      return base;
    }

    case "tags_updated":
    case "comments_updated": {
      const modification: Record<string, unknown> = {};
      if (Array.isArray(data.tags)) {
        modification.tags = data.tags.filter((t) => typeof t === "string");
      }
      if (event === "comments_updated" && typeof data.comments === "string") {
        modification.comments = data.comments;
      }
      if (tagRdv(data.tags)) {
        modification.outcome = "rdv";
        modification.situation = "rdv";
      }
      if (Object.keys(modification).length === 0) return { ...base, ignore: "rien_a_modifier" };
      base.modification = modification;
      base.ordonne = false;
      base.insertion = null;
      return base;
    }
  }

  return { ...base, ignore: "evenement_inconnu" };
}

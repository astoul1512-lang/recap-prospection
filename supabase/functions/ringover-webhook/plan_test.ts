// Scénarios de recette de SPECS §10, joués sur la logique pure du webhook.
import { estEgal, estFaux, estVrai } from "../_shared/verifs.ts";
import { construirePlan, issueAutomatique, lireEnveloppe, tagRdv } from "./plan.ts";

const DEBUT_S = Math.floor(Date.UTC(2026, 8, 3, 14, 0, 0) / 1000); // 3 sept. 2026, 16 h à Paris
const DEBUT_ISO = new Date(DEBUT_S * 1000).toISOString();
const HORODATAGE_MS = DEBUT_S * 1000;

const COLLABORATEUR = {
  user_id: 42,
  user: { firstname: "Alexandre", lastname: "Durand", email: "alexandre@cabinet-ekinox.fr" },
};

function enveloppe(event: string, data: Record<string, unknown>) {
  const lue = lireEnveloppe({ event, resource: "call", timestamp: DEBUT_S, data, attempt: 1 });
  estVrai(lue, "l'enveloppe doit être lisible");
  return lue!;
}

Deno.test("enveloppe : un message sans événement est rejeté", () => {
  estEgal(lireEnveloppe(null), null);
  estEgal(lireEnveloppe({ data: {} }), null);
  estEgal(lireEnveloppe({ event: "   " }), null);
  const sansData = lireEnveloppe({ event: "hangup" });
  estEgal(sansData?.data, {}, "l'absence de data ne fait pas planter");
});

Deno.test("§10.1 — appel sortant décroché de 8 minutes : conversation", () => {
  const sonnerie = construirePlan(
    enveloppe("ringing", {
      call_id: "c-001",
      channel_id: "ch-1",
      direction: "outbound",
      from_number: "+33123456789",
      to_number: "0612345678",
      start_time: DEBUT_S,
      is_internal: false,
      is_anonymous: false,
      ...COLLABORATEUR,
    }),
    HORODATAGE_MS,
  );
  estEgal(sonnerie.callId, "c-001");
  estEgal(sonnerie.insertion?.direction, "out");
  estEgal(sonnerie.insertion?.external_number, "+33612345678", "le numéro appelé, normalisé");
  estEgal(sonnerie.insertion?.started_at, DEBUT_ISO);
  estEgal(sonnerie.insertion?.day, "2026-09-03");
  estEgal(sonnerie.insertion?.status, "ringing");
  estEgal(sonnerie.ringoverUser?.display_name, "Alexandre Durand");
  estEgal(sonnerie.ringoverUser?.ringover_user_id, "42", "l'identifiant numérique devient du texte");

  const raccroche = construirePlan(
    enveloppe("hangup", {
      call_id: "c-001",
      direction: "outbound",
      from_number: "+33123456789",
      to_number: "0612345678",
      start_time: DEBUT_S,
      answered_time: DEBUT_S + 12,
      hangup_time: DEBUT_S + 492,
      duration_in_seconds: 480,
      record: "https://exemple/enregistrement",
      ...COLLABORATEUR,
    }),
    HORODATAGE_MS,
  );
  estEgal(raccroche.modification?.status, "answered");
  estEgal(raccroche.modification?.duration_s, 480);
  estEgal(raccroche.modification?.outcome, "conversation");
  estEgal(raccroche.modification?.record_link, "https://exemple/enregistrement");
  estEgal(raccroche.modification?.needs_review, undefined, "une vraie conversation ne va pas dans la file");
  estVrai(raccroche.ordonne, "le raccrochage respecte l'ordre des événements");
});

Deno.test("§10.3 — appel décroché de 40 secondes : court, à qualifier", () => {
  const plan = construirePlan(
    enveloppe("hangup", {
      call_id: "c-002",
      direction: "outbound",
      from_number: "+33123456789",
      to_number: "0612345678",
      answered_time: DEBUT_S + 5,
      hangup_time: DEBUT_S + 45,
      duration_in_seconds: 40,
      ...COLLABORATEUR,
    }),
    HORODATAGE_MS,
  );
  estEgal(plan.modification?.status, "answered");
  estEgal(plan.modification?.outcome, "court");
  estEgal(plan.modification?.needs_review, true);
  estEgal(plan.modification?.review_reason, "court");
});

Deno.test("§10.4 — messagerie : tentative, jamais de résumé", () => {
  const plan = construirePlan(
    enveloppe("voicemail", {
      call_id: "c-003",
      direction: "outbound",
      to_number: "0612345678",
      duration_in_seconds: 22,
      ...COLLABORATEUR,
    }),
    HORODATAGE_MS,
  );
  estEgal(plan.modification?.status, "voicemail");
  estEgal(plan.modification?.outcome, "tentative");
  estEgal(plan.modification?.needs_review, undefined);
});

Deno.test("appel non décroché : tentative, et pas de statut « décroché » usurpé", () => {
  const manque = construirePlan(
    enveloppe("missed", { call_id: "c-004", direction: "outbound", to_number: "0612345678", ...COLLABORATEUR }),
    HORODATAGE_MS,
  );
  estEgal(manque.modification?.status, "missed");
  estEgal(manque.modification?.outcome, "tentative");

  const raccrocheSansReponse = construirePlan(
    enveloppe("hangup", {
      call_id: "c-005",
      direction: "outbound",
      to_number: "0612345678",
      duration_in_seconds: 0,
      hangup_time: DEBUT_S + 30,
      ...COLLABORATEUR,
    }),
    HORODATAGE_MS,
  );
  estEgal(raccrocheSansReponse.modification?.status, "ended");
  estEgal(raccrocheSansReponse.modification?.outcome, "tentative");
});

Deno.test("§10.5 — appel interne : marqué comme tel, et jamais mis dans la file", () => {
  const plan = construirePlan(
    enveloppe("ringing", {
      call_id: "c-006",
      direction: "outbound",
      from_number: "+33123456789",
      to_number: "+33123456780",
      start_time: DEBUT_S,
      is_internal: true,
      ...COLLABORATEUR,
    }),
    HORODATAGE_MS,
  );
  estEgal(plan.insertion?.is_internal, true, "la vue v_calls s'appuie dessus pour l'exclure");

  const court = construirePlan(
    enveloppe("hangup", {
      call_id: "c-006",
      direction: "outbound",
      to_number: "+33123456780",
      answered_time: DEBUT_S + 2,
      duration_in_seconds: 30,
      is_internal: true,
      ...COLLABORATEUR,
    }),
    HORODATAGE_MS,
  );
  estEgal(court.modification?.outcome, "court");
  estEgal(court.modification?.needs_review, undefined, "un appel interne n'a rien à faire dans « À qualifier »");
});

Deno.test("appel anonyme : enregistré quand même, jamais perdu", () => {
  const plan = construirePlan(
    enveloppe("ringing", {
      call_id: "c-007",
      direction: "inbound",
      from_number: "",
      to_number: "+33123456789",
      start_time: DEBUT_S,
      is_anonymous: true,
      ...COLLABORATEUR,
    }),
    HORODATAGE_MS,
  );
  estEgal(plan.insertion?.external_number, "anonyme");
  estEgal(plan.insertion?.is_anonymous, true);
  estEgal(plan.insertion?.direction, "in");
});

Deno.test("tag « RDV » : rendez-vous, sans écraser l'ordre des événements", () => {
  estVrai(tagRdv(["RDV"]));
  estVrai(tagRdv(["client", "RDV pris"]));
  estVrai(tagRdv(["rdv"]));
  estFaux(tagRdv(["rdvpris"]), "un mot qui contient rdv n'est pas le tag RDV");
  estFaux(tagRdv([]));
  estFaux(tagRdv(undefined));

  const plan = construirePlan(
    enveloppe("tags_updated", { call_id: "c-008", tags: ["RDV", "à rappeler"] }),
    HORODATAGE_MS,
  );
  estEgal(plan.modification?.outcome, "rdv");
  estEgal(plan.modification?.situation, "rdv");
  estEgal(plan.modification?.tags, ["RDV", "à rappeler"]);
  estFaux(plan.ordonne, "un tag posé plus tard ne doit pas être écarté par le contrôle d'ordre");
  estEgal(plan.insertion, null, "un tag ne suffit pas à fabriquer un appel");
});

Deno.test("enregistrement disponible : on complète, on n'invente pas d'appel", () => {
  const plan = construirePlan(
    enveloppe("record_available", { call_id: "c-009", record_link: "https://exemple/rec", record_duration: 480 }),
    HORODATAGE_MS,
  );
  estEgal(plan.modification, { record_link: "https://exemple/rec" });
  estEgal(plan.insertion, null);
  estFaux(plan.ordonne);

  const sansLien = construirePlan(enveloppe("record_available", { call_id: "c-009" }), HORODATAGE_MS);
  estEgal(sansLien.ignore, "lien_enregistrement_absent");
});

Deno.test("messages inattendus : ignorés proprement, jamais d'écriture au hasard", () => {
  estEgal(construirePlan(enveloppe("inconnu_du_bataillon", { call_id: "c-010" }), HORODATAGE_MS).ignore, "evenement_inconnu");
  estEgal(construirePlan(enveloppe("hangup", {}), HORODATAGE_MS).ignore, "call_id_absent");
  estEgal(construirePlan(enveloppe("tags_updated", { call_id: "c-011" }), HORODATAGE_MS).ignore, "rien_a_modifier");
});

Deno.test("issue automatique : la règle de SPECS §5.7, cas par cas", () => {
  estEgal(issueAutomatique("missed", null, []), "tentative");
  estEgal(issueAutomatique("voicemail", 20, []), "tentative");
  estEgal(issueAutomatique("ended", 0, []), "tentative");
  estEgal(issueAutomatique("answered", 59, []), "court", "la limite est à 60 secondes");
  estEgal(issueAutomatique("answered", 60, []), "conversation");
  estEgal(issueAutomatique("answered", 3600, []), "conversation");
  estEgal(issueAutomatique("answered", 12, ["RDV"]), "rdv", "le tag prime sur la durée");
  estEgal(issueAutomatique("missed", null, ["RDV"]), "rdv");
});

Deno.test("durée : acceptée sous les différents noms possibles de l'API", () => {
  const avecDuration = construirePlan(
    enveloppe("hangup", { call_id: "c-012", direction: "outbound", to_number: "0612345678", duration: 300, answered_time: DEBUT_S }),
    HORODATAGE_MS,
  );
  estEgal(avecDuration.modification?.duration_s, 300, "duration seul, si duration_in_seconds manque");

  const texte = construirePlan(
    enveloppe("hangup", { call_id: "c-013", direction: "outbound", to_number: "0612345678", duration_in_seconds: "90", answered_time: DEBUT_S }),
    HORODATAGE_MS,
  );
  estEgal(texte.modification?.duration_s, 90, "durée transmise en texte");
});

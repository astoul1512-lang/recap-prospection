// Tests de la traduction API REST → ligne d'appel — SPECS §10, scénario 6.
// Le piège que ces tests surveillent : l'API REST et les webhooks ne décrivent
// pas un appel de la même façon. Une confusion entre les deux modèles produit
// des lignes plausibles mais fausses — le pire des défauts, parce qu'il ne se
// voit pas.

import { estEgal, estVrai } from "../_shared/verifs.ts";
import { ligneAppel } from "./ligne.ts";
import {
  bornesJournee,
  decalageParis,
  dedoublonner,
  etatDepuisRingover,
  identifiantCollaborateur,
} from "../_shared/ringover.ts";

const APPEL_TYPE = {
  cdr_id: 19479170,
  call_id: "13399767559614784019",
  channel_id: "ch-1",
  direction: "out",
  is_answered: true,
  last_state: "ANSWERED",
  start_time: "2026-09-03T15:27:36+02:00",
  answered_time: "2026-09-03T15:27:44+02:00",
  end_time: "2026-09-03T15:33:10+02:00",
  incall_duration: 326,
  total_duration: 334,
  from_number: "33176350000",
  to_number: "33612345678",
  user: { user_id: 22673838, firstname: "Adrien", lastname: "Astoul", email: "a@ekinox.fr" },
  record: "https://cdn.ringover.com/records/x.mp3",
  amd: false,
  tags: [{ id: 1, name: "Suivi" }],
};

Deno.test("appel sortant décroché : conversation, sens et numéro externe justes", () => {
  const ligne = ligneAppel(APPEL_TYPE)!;
  estEgal(ligne.direction, "out");
  estEgal(ligne.external_number, "+33612345678");
  estEgal(ligne.status, "answered");
  estEgal(ligne.outcome, "conversation");
  estEgal(ligne.duration_s, 326);
  estEgal(ligne.source, "api");
  estEgal(ligne.day, "2026-09-03");
  estEgal(ligne.last_event_ts, 0);
  estEgal(ligne.tags, ["Suivi"]);
});

Deno.test("le collaborateur reçoit la même clé que par le webhook", () => {
  estEgal(identifiantCollaborateur(APPEL_TYPE), "USER22673838");
  estEgal(identifiantCollaborateur({ user: { user_id: "USER22673838" } }), "USER22673838");
  estEgal(identifiantCollaborateur({}), null);
});

Deno.test("appel entrant : le numéro externe est celui de l'appelant", () => {
  const ligne = ligneAppel({ ...APPEL_TYPE, direction: "in" })!;
  estEgal(ligne.external_number, "+33176350000");
});

Deno.test("appel court : mis en file à qualifier, comme par le webhook", () => {
  const ligne = ligneAppel({ ...APPEL_TYPE, incall_duration: 30, total_duration: 30 })!;
  estEgal(ligne.outcome, "court");
  estEgal(ligne.needs_review, true);
  estEgal(ligne.review_reason, "court");
});

Deno.test("répondeur détecté : messagerie, hors entonnoir, sans question posée", () => {
  const ligne = ligneAppel({ ...APPEL_TYPE, amd: true, incall_duration: 22 })!;
  estEgal(ligne.status, "voicemail");
  estEgal(ligne.outcome, "tentative");
  estEgal(ligne.machine_detection, "MACHINE");
  estVrai(!("needs_review" in ligne), "un répondeur n'a rien à qualifier");
});

Deno.test("répondeur annoncé sur un appel long : la conversation l'emporte", () => {
  const ligne = ligneAppel({ ...APPEL_TYPE, amd: true, incall_duration: 300 })!;
  estEgal(ligne.status, "answered");
  estEgal(ligne.outcome, "conversation");
});

Deno.test("appel manqué et messagerie : tentative", () => {
  estEgal(ligneAppel({ ...APPEL_TYPE, last_state: "MISSED", is_answered: false })!.outcome, "tentative");
  estEgal(ligneAppel({ ...APPEL_TYPE, last_state: "VOICEMAIL" })!.status, "voicemail");
});

Deno.test("état inconnu : jamais compté comme une conversation", () => {
  estEgal(etatDepuisRingover({ last_state: "ETAT_INVENTE", is_answered: false }), "ended");
  estEgal(etatDepuisRingover({ last_state: "FAILED" }), "ended");
  estEgal(etatDepuisRingover({ last_state: "QUEUE_TIMEOUT" }), "missed");
});

Deno.test("tag RDV : rendez-vous et situation posés", () => {
  const ligne = ligneAppel({ ...APPEL_TYPE, tags: [{ name: "RDV" }] })!;
  estEgal(ligne.outcome, "rdv");
  estEgal(ligne.situation, "rdv");
});

Deno.test("appel entrant sans numéro : anonyme", () => {
  const ligne = ligneAppel({ ...APPEL_TYPE, direction: "in", from_number: "" })!;
  estEgal(ligne.is_anonymous, true);
});

Deno.test("appel sans date de début : écarté plutôt qu'inventé", () => {
  estEgal(ligneAppel({ ...APPEL_TYPE, start_time: null }), null);
  estEgal(ligneAppel({ ...APPEL_TYPE, call_id: null }), null);
});

Deno.test("segments d'un même appel : comptés une fois, le plus long gagne", () => {
  const segments = [
    { call_id: "a", incall_duration: 5 },
    { call_id: "a", incall_duration: 120 },
    { call_id: "b", incall_duration: 30 },
  ];
  const uniques = dedoublonner(segments);
  estEgal(uniques.length, 2);
  estEgal(uniques.find((s) => s.call_id === "a")?.incall_duration, 120);
});

Deno.test("la journée demandée est une journée de Paris, pas d'UTC", () => {
  estEgal(decalageParis("2026-09-03"), "+02:00"); // heure d'été
  estEgal(decalageParis("2026-01-15"), "+01:00"); // heure d'hiver
  estEgal(bornesJournee("2026-09-03", "+02:00"), {
    debut: "2026-09-03T00:00:00+02:00",
    fin: "2026-09-03T23:59:59+02:00",
  });
});

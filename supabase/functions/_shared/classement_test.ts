// Tests de la décision de classement — SPECS §10, scénarios 1, 2, 3 et 5.
// Ce que ces tests protègent, dans l'ordre d'importance :
//  1. aucun candidat ne doit entrer dans le rapport ;
//  2. aucune décision humaine ne doit être défaite ;
//  3. un numéro inconnu doit être posé en question, jamais tranché tout seul.

import { estEgal, estFaux, estVrai } from "./verifs.ts";
import {
  type AppelAClasser,
  choisirProfil,
  classer,
  ligneCache,
  profilDepuisCache,
  repondeurDetecte,
} from "./classement.ts";
import type { ProfilJarvi } from "./jarvi.ts";
import { chiffresSignificatifs, memeNumero } from "./phone.ts";

function appel(extra: Partial<AppelAClasser> = {}): AppelAClasser {
  return {
    call_id: "42",
    external_number: "+33612345678",
    is_internal: false,
    is_anonymous: false,
    status: "answered",
    duration_s: 300,
    outcome: "conversation",
    outcome_manual: null,
    kind_manual: null,
    machine_detection: null,
    reviewed_at: null,
    ...extra,
  };
}

function profil(extra: Partial<ProfilJarvi> = {}): ProfilJarvi {
  return {
    id: "p1",
    prenom: "Claire",
    nom: "Martin",
    headline: "Directrice des ressources humaines",
    estContact: true,
    estTalent: false,
    societeId: "c1",
    societeNom: "Atelier Ledoux",
    numeros: ["+33612345678"],
    ...extra,
  };
}

Deno.test("contact Jarvi : prospection, avec la société et la fonction", () => {
  const d = classer({ appel: appel(), profil: profil(), trouve: true });
  estEgal(d.kind, "prospection");
  estEgal(d.champs.company_name, "Atelier Ledoux");
  estEgal(d.champs.contact_name, "Claire Martin");
  estEgal(d.champs.contact_role, "Directrice des ressources humaines");
  estEgal(d.champs.needs_review, false);
});

Deno.test("candidat seul : hors prospection, et RIEN de lui n'est recopié", () => {
  const candidat = profil({ estContact: false, estTalent: true, prenom: "Yanis" });
  const d = classer({ appel: appel(), profil: candidat, trouve: true });
  estEgal(d.kind, "hors_prospection");
  estEgal(d.champs.contact_name, null);
  estEgal(d.champs.company_name, null);
  estEgal(d.champs.jarvi_profile_id, null);
  estEgal(d.champs.needs_review, false);
});

Deno.test("numéro absent de Jarvi : inconnu, posé en question", () => {
  const d = classer({ appel: appel(), profil: null, trouve: false });
  estEgal(d.kind, "inconnu");
  estEgal(d.champs.needs_review, true);
  estEgal(d.champs.review_reason, "inconnu");
});

Deno.test("appel interne : hors prospection sans interroger Jarvi", () => {
  const d = classer({ appel: appel({ is_internal: true }), profil: null, trouve: false });
  estEgal(d.kind, "hors_prospection");
  estEgal(d.champs.needs_review, false);
});

Deno.test("appel anonyme : hors prospection", () => {
  const d = classer({ appel: appel({ is_anonymous: true }), profil: null, trouve: false });
  estEgal(d.kind, "hors_prospection");
});

Deno.test("numéro non normalisable : hors prospection, jamais soumis à Jarvi", () => {
  const d = classer({ appel: appel({ external_number: "anonyme" }), profil: null, trouve: false });
  estEgal(d.kind, "hors_prospection");
});

Deno.test("contact et appel court : à qualifier", () => {
  const court = appel({ duration_s: 38, outcome: "court" });
  const d = classer({ appel: court, profil: profil(), trouve: true });
  estEgal(d.champs.needs_review, true);
  estEgal(d.champs.review_reason, "court");
});

Deno.test("appel court reconnu comme répondeur : pas de question posée", () => {
  const repondeur = appel({ duration_s: 12, outcome: "court", machine_detection: "MACHINE" });
  const d = classer({ appel: repondeur, profil: profil(), trouve: true });
  estEgal(d.champs.needs_review, false);
});

Deno.test("un appel déjà tranché par un humain ne retourne jamais dans la file", () => {
  const tranche = appel({ duration_s: 20, outcome: "court", reviewed_at: "2026-09-04T09:00:00Z" });
  const d = classer({ appel: tranche, profil: null, trouve: false });
  estEgal(d.kind, "inconnu");
  estFaux("needs_review" in d.champs, "la revue ne doit pas être rouverte");
  estFaux("review_reason" in d.champs, "le motif ne doit pas être réécrit");
});

Deno.test("plusieurs profils sur un numéro : le contact l'emporte", () => {
  const candidat = profil({ id: "t1", estContact: false, estTalent: true });
  const contact = profil({ id: "c9" });
  estEgal(choisirProfil([candidat, contact], "+33612345678")?.id, "c9");
});

Deno.test("un profil dont le numéro ne correspond pas est écarté du choix", () => {
  const autre = profil({ id: "x", numeros: ["+33700000000"] });
  const bon = profil({ id: "bon", estContact: false });
  estEgal(choisirProfil([autre, bon], "+33612345678")?.id, "bon");
});

Deno.test("détection de répondeur : seul MACHINE compte", () => {
  estVrai(repondeurDetecte("MACHINE"));
  estVrai(repondeurDetecte("machine"));
  estFaux(repondeurDetecte("HUMAN"));
  estFaux(repondeurDetecte("NOTSURE"));
  estFaux(repondeurDetecte(null));
});

Deno.test("le cache restitue exactement la même décision", () => {
  const ligne = ligneCache("+33612345678", profil());
  const relu = profilDepuisCache(ligne as Record<string, unknown>);
  estVrai(relu !== null);
  const d = classer({ appel: appel(), profil: relu, trouve: true });
  estEgal(d.kind, "prospection");
  estEgal(d.champs.company_name, "Atelier Ledoux");
});

Deno.test("le cache mémorise aussi les absences", () => {
  const ligne = ligneCache("+33699999999", null);
  estEgal(ligne.found, false);
  estEgal(profilDepuisCache(ligne as Record<string, unknown>), null);
});

Deno.test("rapprochement des numéros écrits différemment", () => {
  estVrai(memeNumero("+33612345678", "0612345678"));
  estVrai(memeNumero("33612345678", "+33 6 12 34 56 78"));
  estVrai(memeNumero("0033612345678", "+33612345678"));
  estFaux(memeNumero("+33612345678", "+33612345679"));
  estFaux(memeNumero("1234", "1234"), "un numéro trop court ne prouve rien");
  estEgal(chiffresSignificatifs("+33612345678"), "612345678");
});

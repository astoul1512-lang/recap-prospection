// Tests de la lecture du CRM Jarvi — lot Sociétés §3.
//
// Ce que ces tests surveillent : les deux défauts qui ne se voient pas.
//  - un filtre de prospecteur qui laisse passer tout le monde, et la page
//    affiche deux mille comptes au lieu de six cents (docs/decisions.md D9) ;
//  - un champ lu sous le mauvais nom, qui rend `null` sans lever d'erreur —
//    le nom de société devient un identifiant LinkedIn, le secteur disparaît,
//    et personne ne s'en aperçoit.

import { estEgal, estFaux, estVrai } from "./verifs.ts";
import { lireContact, lireSociete, prospecteurConnu } from "./jarvi_crm.ts";

Deno.test("prospecteur : reconnu sur le prénom, accent et casse ignorés", () => {
  estEgal(prospecteurConnu("Remy Basdim"), "Rémy", "Jarvi écrit sans accent");
  estEgal(prospecteurConnu("Rémy Basdim"), "Rémy");
  estEgal(prospecteurConnu("Martin Benyekkou"), "Martin");
  estEgal(prospecteurConnu("Adrien Astoul"), "Adrien");
});

Deno.test("prospecteur : ceux qui ne prospectent pas ne passent pas", () => {
  estEgal(prospecteurConnu("Julien Fravallo"), null, "parti du cabinet");
  estEgal(prospecteurConnu("Alexandre mesnier"), null, "ne prospecte pas");
  estEgal(prospecteurConnu(""), null);
  estEgal(prospecteurConnu("   "), null);
});

Deno.test("société : responsables retenus, les autres écartés", () => {
  const societe = lireSociete({
    id: "c-1",
    name: "Oodrive",
    assignees: [
      { user: { displayName: "Martin Benyekkou" } },
      { user: { displayName: "Julien Fravallo" } },
    ],
  });
  estEgal(societe?.prospecteurs.length, 1, "Julien ne compte pas");
  estEgal(societe?.prospecteurs[0], "Martin");
});

Deno.test("société partagée : elle apparaît chez chacun", () => {
  const societe = lireSociete({
    id: "c-2",
    name: "Praxedo",
    assignees: [
      { user: { displayName: "Martin Benyekkou" } },
      { user: { displayName: "Remy Basdim" } },
    ],
  });
  estEgal(societe?.prospecteurs.length, 2);
  estVrai(societe!.prospecteurs.includes("Martin"));
  estVrai(societe!.prospecteurs.includes("Rémy"));
});

Deno.test("société : un compte sans responsable qui prospecte reste lisible mais vide", () => {
  const societe = lireSociete({
    id: "c-3",
    name: "Zenchef",
    assignees: [{ user: { displayName: "Julien Fravallo" } }],
  });
  estVrai(societe !== null, "la société se lit");
  estEgal(societe?.prospecteurs.length, 0, "c'est l'appelant qui l'écarte");
});

// Le piège de `jarvi.ts`, repris ici : beaucoup de sociétés ont été créées
// depuis une adresse LinkedIn, leur `name` est l'identifiant de l'URL.
Deno.test("société : le nom LinkedIn prime sur l'identifiant d'URL", () => {
  const societe = lireSociete({
    id: "c-4",
    name: "cecurity-com",
    linkedinCompanyData: { name: "Cecurity.com" },
    assignees: [{ user: { displayName: "Remy Basdim" } }],
  });
  estEgal(societe?.nom, "Cecurity.com");
});

Deno.test("société : secteur lu sur le bon champ personnalisé, et lui seul", () => {
  const societe = lireSociete({
    id: "c-5",
    name: "Hello Watt",
    assignees: [{ user: { displayName: "Martin Benyekkou" } }],
    fieldsValues: [
      { fieldId: "409db88f-ef79-4917-8ee8-b09002548c6e", value: "Paris" },
      { fieldId: "3665fb39-820b-4f19-a876-0899ec1e7a4d", value: "Énergie / Utilities" },
    ],
  });
  estEgal(societe?.secteur, "Énergie / Utilities", "l'adresse ne doit pas passer pour un secteur");
});

Deno.test("société : sans identifiant ou sans nom, rien n'est inventé", () => {
  estEgal(lireSociete({ name: "Sans identifiant" }), null);
  estEgal(lireSociete({ id: "c-6" }), null);
});

Deno.test("contact : nom, poste borné, numéro", () => {
  const contact = lireContact({
    id: "p-1",
    firstName: "Bruno",
    lastName: "Ricci",
    headline: "D".repeat(200),
    phoneNumbers: [{ canonicalNumber: "+33612345678" }],
    isContact: true,
  }, "c-1");
  estEgal(contact?.nom, "Bruno Ricci");
  estEgal(contact?.numero, "+33612345678");
  estEgal(contact?.poste?.length, 120, "le poste est borné à 120 caractères");
});

// Interdit absolu de CLAUDE.md : aucune donnée candidat n'entre en base.
Deno.test("contact : un candidat n'entre jamais en base", () => {
  const candidat = lireContact({
    id: "p-2",
    firstName: "Quelqu'un",
    lastName: "Ailleurs",
    isContact: false,
  }, "c-1");
  estEgal(candidat, null);
});

Deno.test("contact : sans nom, on n'écrit pas une ligne vide", () => {
  estEgal(lireContact({ id: "p-3", isContact: true }, "c-1"), null);
  estFaux(lireContact({ firstName: "Sans", lastName: "Identifiant" }, "c-1") !== null);
});

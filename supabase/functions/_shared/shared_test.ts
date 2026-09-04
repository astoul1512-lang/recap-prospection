import { estEgal, estFaux, estVrai } from "./verifs.ts";
import { numeroExterneOuDefaut, sensRingover, versE164 } from "./phone.ts";
import { analyserTemps, ecartMinutes, jourParis } from "./dates.ts";
import { signerJwtHs512, verifierJwtHs512 } from "./signature.ts";
import { numeroMasque } from "./log.ts";

const SECRET = "secret-de-test-uniquement";

Deno.test("numéros : toutes les formes françaises donnent le même E.164", () => {
  const attendu = "+33612345678";
  estEgal(versE164("06 12 34 56 78"), attendu, "national avec espaces");
  estEgal(versE164("06.12.34.56.78"), attendu, "national avec points");
  estEgal(versE164("0612345678"), attendu, "national collé");
  estEgal(versE164("+33 6 12 34 56 78"), attendu, "international avec espaces");
  estEgal(versE164("33612345678"), attendu, "international sans le +");
  estEgal(versE164("0033612345678"), attendu, "préfixe 00");
});

Deno.test("numéros : ce qui n'est pas un numéro ne doit pas en devenir un", () => {
  estEgal(versE164(""), null);
  estEgal(versE164("   "), null);
  estEgal(versE164("anonyme"), null);
  estEgal(versE164(null), null);
  estEgal(versE164(undefined), null);
  estEgal(versE164("123"), null, "trop court");
});

Deno.test("numéro externe : c'est l'interlocuteur, jamais le collaborateur", () => {
  estEgal(
    numeroExterneOuDefaut("outbound", "+33123456789", "0612345678"),
    "+33612345678",
    "sortant : le destinataire",
  );
  estEgal(
    numeroExterneOuDefaut("inbound", "0612345678", "+33123456789"),
    "+33612345678",
    "entrant : l'appelant",
  );
  estEgal(numeroExterneOuDefaut("inbound", "", ""), "anonyme", "appel anonyme : jamais de perte de ligne");
  estEgal(sensRingover("outbound"), "out");
  estEgal(sensRingover("inbound"), "in");
  estEgal(sensRingover(undefined), "in", "valeur par défaut prudente");
});

Deno.test("jour : c'est le jour de Paris, pas le jour UTC", () => {
  // 3 septembre 23 h 30 à Paris (UTC+2 l'été) = encore le 3.
  estEgal(jourParis(new Date("2026-09-03T21:30:00Z")), "2026-09-03");
  // 4 septembre 00 h 30 à Paris = déjà le 4, alors qu'il est 22 h 30 UTC le 3.
  estEgal(jourParis(new Date("2026-09-03T22:30:00Z")), "2026-09-04");
  // Même bascule en hiver (UTC+1).
  estEgal(jourParis(new Date("2026-01-03T23:30:00Z")), "2026-01-04");
});

// Calculé, jamais écrit à la main : un epoch recopié de tête est faux une fois
// sur deux, et le test « passerait » alors pour une mauvaise raison.
const INSTANT_S = Math.floor(Date.UTC(2026, 8, 3, 16, 0, 0) / 1000);
const INSTANT_ISO = "2026-09-03T16:00:00.000Z";

Deno.test("horodatage : secondes, millisecondes ou ISO, sans se tromper d'unité", () => {
  const secondes = analyserTemps(INSTANT_S);
  estEgal(secondes.unite, "secondes");
  estEgal(secondes.date?.toISOString(), INSTANT_ISO);

  const millis = analyserTemps(INSTANT_S * 1000);
  estEgal(millis.unite, "millisecondes");
  estEgal(millis.date?.toISOString(), INSTANT_ISO, "la même seconde, exprimée en millisecondes");

  estEgal(analyserTemps(String(INSTANT_S)).unite, "secondes", "entier transmis en texte");
  estEgal(analyserTemps("2026-09-03T16:00:00Z").unite, "iso");
  estEgal(analyserTemps("n'importe quoi").unite, "inconnue");
  estEgal(analyserTemps(null).unite, "inconnue");
  estEgal(analyserTemps(0).unite, "inconnue");
});

Deno.test("anti-rejeu : l'écart est mesuré, et reste nul si l'unité est illisible", () => {
  const maintenant = new Date(INSTANT_ISO);
  estEgal(ecartMinutes(INSTANT_S, maintenant), 0, "même instant, en secondes");
  estEgal(ecartMinutes(INSTANT_S * 1000, maintenant), 0, "même instant, en millisecondes");
  estEgal(ecartMinutes(INSTANT_S - 600, maintenant), 10, "dix minutes plus tôt");
  estEgal(ecartMinutes("illisible", maintenant), null, "on ne bloque pas sur un doute");
});

Deno.test("signature : un jeton correctement signé est accepté", async () => {
  const jeton = await signerJwtHs512({ event: "hangup", iat: 1788518400 }, SECRET);
  const controle = await verifierJwtHs512(jeton, SECRET);
  estVrai(controle.valide, "le jeton signé avec le bon secret doit passer");
  estEgal(controle.alg, "HS512");
  estEgal((controle.charge as Record<string, unknown>).event, "hangup");
});

Deno.test("signature : tout le reste est refusé", async () => {
  const jeton = await signerJwtHs512({ event: "hangup" }, SECRET);

  estFaux((await verifierJwtHs512(jeton, "mauvais-secret")).valide, "mauvais secret");
  estEgal((await verifierJwtHs512(jeton, "mauvais-secret")).motif, "signature_incorrecte");
  estEgal((await verifierJwtHs512("", SECRET)).motif, "signature_absente");
  estEgal((await verifierJwtHs512("a.b", SECRET)).motif, "format_invalide");
  estEgal((await verifierJwtHs512("pas.un.jwt", SECRET)).motif, "entete_illisible");

  // Un octet modifié dans la signature suffit à invalider le jeton. On modifie
  // le PREMIER caractère : le dernier ne porte parfois que des bits inutilisés,
  // et le changer ne changerait pas les octets décodés — le test passerait pour
  // une mauvaise raison.
  const parties = jeton.split(".");
  const premier = parties[2][0] === "A" ? "B" : "A";
  const altere = `${parties[0]}.${parties[1]}.${premier}${parties[2].slice(1)}`;
  estFaux((await verifierJwtHs512(altere, SECRET)).valide, "signature altérée");

  // Charge modifiée après signature : la signature ne correspond plus.
  const fausseCharge = btoa(JSON.stringify({ event: "hangup", injecte: true }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const rejoue = `${parties[0]}.${fausseCharge}.${parties[2]}`;
  estFaux((await verifierJwtHs512(rejoue, SECRET)).valide, "charge falsifiée");
});

Deno.test("signature : l'algorithme annoncé par l'émetteur n'est jamais accepté", async () => {
  // La faille classique des vérifications de JWT : croire l'en-tête « alg ».
  const entete = btoa(JSON.stringify({ alg: "none", typ: "JWT" }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const corps = btoa(JSON.stringify({ event: "hangup" }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const controle = await verifierJwtHs512(`${entete}.${corps}.`, SECRET);
  estFaux(controle.valide);
  estEgal(controle.motif, "algorithme_inattendu");
});

Deno.test("journaux : un numéro n'apparaît jamais en clair", () => {
  estEgal(numeroMasque("+33612345678"), "+33…78");
  estEgal(numeroMasque(null), "∅");
});

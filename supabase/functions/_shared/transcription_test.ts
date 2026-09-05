// Tests de l'assemblage des transcriptions Ringover.
//
// Ce que ces tests protègent : une transcription mal assemblée donne un résumé
// faux, et un résumé faux ne se voit pas — personne ne relit la conversation
// pour vérifier. C'est le défaut le plus coûteux de toute la chaîne.

import { estEgal, estVrai } from "./verifs.ts";
import { assemblerParoles } from "./ringover.ts";

const SORTANT = true;
const ENTRANT = false;

Deno.test("transcription diarisée : une réplique par ligne, avec qui parle", () => {
  const donnees = {
    speeches: [
      { speaker_id: 0, content: "Bonjour, Adrien du cabinet Ekinox." },
      { speaker_id: 1, content: "Bonjour, je vous écoute." },
      { speaker_id: 0, content: "Vous recrutez en ce moment ?" },
    ],
  };
  const { texte, segments } = assemblerParoles(donnees, SORTANT);
  estEgal(segments, 3);
  // Appel sortant : c'est le collaborateur qui compose, donc le canal 1.
  estEgal(
    texte,
    "Interlocuteur : Bonjour, Adrien du cabinet Ekinox.\n" +
      "Collaborateur : Bonjour, je vous écoute.\n" +
      "Interlocuteur : Vous recrutez en ce moment ?",
  );
});

Deno.test("locuteur inconnu : on garde la parole, sans inventer d'étiquette", () => {
  const { texte } = assemblerParoles({ speeches: [{ speaker_id: 7, content: "Allô ?" }] }, SORTANT);
  estEgal(texte, "Allô ?");
});

Deno.test("les autres noms de champs sont acceptés", () => {
  const { texte } = assemblerParoles({
    segments: [{ channelId: 1, text: "Je vous rappelle demain." }],
  }, ENTRANT);
  estEgal(texte, "Interlocuteur : Je vous rappelle demain.");  // entrant : canal 1 = l'appelant
});

Deno.test("répliques vides : écartées, jamais de ligne fantôme", () => {
  const { texte, segments } = assemblerParoles({
    speeches: [
      { speaker_id: 0, content: "  " },
      { speaker_id: 1, content: "D'accord." },
      { speaker_id: 1 },
      null,
    ],
  }, ENTRANT);
  estEgal(segments, 1);
  estEgal(texte, "Interlocuteur : D'accord.");
});

Deno.test("transcription absente ou d'une forme inattendue : texte vide, pas d'erreur", () => {
  estEgal(assemblerParoles(null, SORTANT).texte, "");
  estEgal(assemblerParoles({}, SORTANT).texte, "");
  estEgal(assemblerParoles({ speeches: "pas un tableau" }, SORTANT).texte, "");
  estEgal(assemblerParoles([], SORTANT).texte, "");
});

Deno.test("liste de phrases nues : acceptée telle quelle", () => {
  const { texte, segments } = assemblerParoles({ speeches: ["Première phrase.", "Seconde."] }, SORTANT);
  estEgal(segments, 2);
  estVrai(texte.includes("Première phrase."));
});

Deno.test("la réponse est un tableau : la liste de répliques est retrouvée", () => {
  // Forme constatée le 4 septembre 2026 sur le trafic réel : l'endpoint
  // renvoie un tableau, là où la documentation laissait attendre un objet.
  const { texte, segments } = assemblerParoles([
    { speaker_id: 0, content: "Bonjour." },
    { speaker_id: 1, content: "Bonjour à vous." },
  ], SORTANT);
  estEgal(segments, 2);
  estEgal(texte, "Interlocuteur : Bonjour.\nCollaborateur : Bonjour à vous.");
});

Deno.test("autres noms possibles de la liste de répliques", () => {
  estEgal(assemblerParoles({ utterances: [{ content: "Oui." }] }, SORTANT).texte, "Oui.");
  estEgal(assemblerParoles({ sentences: [{ text: "Non." }] }, SORTANT).texte, "Non.");
});

Deno.test("le sens de l'appel décide de qui parle — le défaut du 5 septembre 2026", () => {
  // Ringover numérote par rôle : 1 = celui qui appelle, 0 = celui qui décroche.
  const repliques = [
    { speaker_id: 1, content: "Bonjour, Ekinox à l’appareil." },
    { speaker_id: 0, content: "Bonjour, je vous écoute." },
  ];
  // Sortant : c'est nous qui composons, donc canal 1.
  estEgal(
    assemblerParoles({ speeches: repliques }, SORTANT).texte,
    "Collaborateur : Bonjour, Ekinox à l’appareil.\nInterlocuteur : Bonjour, je vous écoute.",
  );
  // Entrant : c'est le prospect qui appelle, donc canal 1.
  estEgal(
    assemblerParoles({ speeches: repliques }, ENTRANT).texte,
    "Interlocuteur : Bonjour, Ekinox à l’appareil.\nCollaborateur : Bonjour, je vous écoute.",
  );
});

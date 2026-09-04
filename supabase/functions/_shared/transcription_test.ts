// Tests de l'assemblage des transcriptions Ringover.
//
// Ce que ces tests protègent : une transcription mal assemblée donne un résumé
// faux, et un résumé faux ne se voit pas — personne ne relit la conversation
// pour vérifier. C'est le défaut le plus coûteux de toute la chaîne.

import { estEgal, estVrai } from "./verifs.ts";
import { assemblerParoles } from "./ringover.ts";

Deno.test("transcription diarisée : une réplique par ligne, avec qui parle", () => {
  const donnees = {
    speeches: [
      { speaker_id: 0, content: "Bonjour, Adrien du cabinet Ekinox." },
      { speaker_id: 1, content: "Bonjour, je vous écoute." },
      { speaker_id: 0, content: "Vous recrutez en ce moment ?" },
    ],
  };
  const { texte, segments } = assemblerParoles(donnees);
  estEgal(segments, 3);
  estEgal(
    texte,
    "Collaborateur : Bonjour, Adrien du cabinet Ekinox.\n" +
      "Interlocuteur : Bonjour, je vous écoute.\n" +
      "Collaborateur : Vous recrutez en ce moment ?",
  );
});

Deno.test("locuteur inconnu : on garde la parole, sans inventer d'étiquette", () => {
  const { texte } = assemblerParoles({ speeches: [{ speaker_id: 7, content: "Allô ?" }] });
  estEgal(texte, "Allô ?");
});

Deno.test("les autres noms de champs sont acceptés", () => {
  const { texte } = assemblerParoles({
    segments: [{ channelId: 1, text: "Je vous rappelle demain." }],
  });
  estEgal(texte, "Interlocuteur : Je vous rappelle demain.");
});

Deno.test("répliques vides : écartées, jamais de ligne fantôme", () => {
  const { texte, segments } = assemblerParoles({
    speeches: [
      { speaker_id: 0, content: "  " },
      { speaker_id: 1, content: "D'accord." },
      { speaker_id: 1 },
      null,
    ],
  });
  estEgal(segments, 1);
  estEgal(texte, "Interlocuteur : D'accord.");
});

Deno.test("transcription absente ou d'une forme inattendue : texte vide, pas d'erreur", () => {
  estEgal(assemblerParoles(null).texte, "");
  estEgal(assemblerParoles({}).texte, "");
  estEgal(assemblerParoles({ speeches: "pas un tableau" }).texte, "");
  estEgal(assemblerParoles([]).texte, "");
});

Deno.test("liste de phrases nues : acceptée telle quelle", () => {
  const { texte, segments } = assemblerParoles({ speeches: ["Première phrase.", "Seconde."] });
  estEgal(segments, 2);
  estVrai(texte.includes("Première phrase."));
});

Deno.test("la réponse est un tableau : la liste de répliques est retrouvée", () => {
  // Forme constatée le 4 septembre 2026 sur le trafic réel : l'endpoint
  // renvoie un tableau, là où la documentation laissait attendre un objet.
  const { texte, segments } = assemblerParoles([
    { speaker_id: 0, content: "Bonjour." },
    { speaker_id: 1, content: "Bonjour à vous." },
  ]);
  estEgal(segments, 2);
  estEgal(texte, "Collaborateur : Bonjour.\nInterlocuteur : Bonjour à vous.");
});

Deno.test("autres noms possibles de la liste de répliques", () => {
  estEgal(assemblerParoles({ utterances: [{ content: "Oui." }] }).texte, "Oui.");
  estEgal(assemblerParoles({ sentences: [{ text: "Non." }] }).texte, "Non.");
});

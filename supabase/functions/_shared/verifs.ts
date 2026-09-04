// Assertions minimales pour les tests Deno.
// Écrites à la main plutôt qu'importées : les tests sont la barrière qui
// autorise un déploiement, ils ne doivent pas dépendre d'un paquet distant
// susceptible de disparaître ou de changer de version.

export function estEgal(obtenu: unknown, attendu: unknown, message = ""): void {
  const a = JSON.stringify(obtenu);
  const b = JSON.stringify(attendu);
  if (a !== b) {
    throw new Error(`${message || "valeurs différentes"}\n  obtenu  : ${a}\n  attendu : ${b}`);
  }
}

export function estVrai(condition: unknown, message = "condition fausse"): void {
  if (!condition) throw new Error(message);
}

export function estFaux(condition: unknown, message = "condition vraie"): void {
  if (condition) throw new Error(message);
}

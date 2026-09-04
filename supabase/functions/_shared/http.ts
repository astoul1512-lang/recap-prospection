// Appels réseau sortants : jamais sans limite de temps, jamais en boucle.
// Une edge function bloquée sur un service extérieur lent finit par expirer et
// perdre l'événement en cours — mieux vaut échouer vite et réessayer.

export const DELAI_MAX_MS = 8000;

export async function fetchAvecDelai(
  url: string | URL,
  init: RequestInit = {},
  delaiMs: number = DELAI_MAX_MS,
): Promise<Response> {
  const controleur = new AbortController();
  const minuterie = setTimeout(() => controleur.abort(), delaiMs);
  try {
    return await fetch(url, { ...init, signal: controleur.signal });
  } finally {
    clearTimeout(minuterie);
  }
}

// Deux tentatives maximum, avec une pause croissante. On ne réessaie que sur
// une panne réseau ou un dépassement de délai : un refus explicite du serveur
// (4xx) ne s'améliore pas en insistant.
export async function avecReprise<T>(
  action: () => Promise<T>,
  tentatives = 2,
  pauseMs = 300,
): Promise<T> {
  let derniere: unknown;
  for (let i = 0; i < tentatives; i++) {
    try {
      return await action();
    } catch (erreur) {
      derniere = erreur;
      if (i < tentatives - 1) await new Promise((r) => setTimeout(r, pauseMs * (i + 1)));
    }
  }
  throw derniere;
}

// Réponses de la fonction : minimales, aucun détail interne (SPECS §5).
export function reponse(statut: number, corps?: unknown): Response {
  if (corps === undefined) return new Response(null, { status: statut });
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: { "Content-Type": "application/json" },
  });
}

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

// Travail à poursuivre APRÈS avoir répondu. Ringover attend un accusé de
// réception rapide ; l'interrogation de Jarvi qui suit un raccrochage peut
// prendre plusieurs secondes. `EdgeRuntime.waitUntil` est l'API prévue par
// Supabase pour qu'un traitement en cours ne soit pas interrompu par l'arrêt de
// l'exécutable. Hors de cet environnement (tests), on se contente d'attendre.
export function poursuivre(travail: Promise<unknown>): void {
  const surveille = travail.catch(() => {});
  const runtime = (globalThis as Record<string, unknown>).EdgeRuntime as
    | { waitUntil?: (p: Promise<unknown>) => void }
    | undefined;
  if (runtime && typeof runtime.waitUntil === "function") runtime.waitUntil(surveille);
}

// Réponses de la fonction : minimales, aucun détail interne (SPECS §5).
export function reponse(statut: number, corps?: unknown): Response {
  if (corps === undefined) return new Response(null, { status: statut });
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: { "Content-Type": "application/json" },
  });
}

// --- Contrôle préalable du navigateur (CORS) ---------------------------------
//
// Avant d'appeler une fonction depuis une page web, le navigateur envoie une
// requête `OPTIONS` pour demander l'autorisation. Une fonction qui répond 405 à
// cette question — parce qu'elle n'accepte que POST — voit tous ses appels
// bloqués **avant même d'être émis**. Rien n'arrive au serveur, rien n'apparaît
// dans les journaux applicatifs, et l'utilisateur voit un échec sans cause.
// C'est ce qui est arrivé le 4 septembre 2026 à toutes les fonctions appelées
// depuis l'application.
//
// L'origine est vérifiée plutôt qu'ouverte à tous : cette application est
// privée, aucune autre page n'a de raison de l'appeler. Ce n'est pas une
// barrière de sécurité — le jeton reste le vrai contrôle — mais il n'y a
// aucune raison d'être plus permissif que nécessaire.
const ORIGINES_AUTORISEES = new Set([
  "https://astoul1512-lang.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

export function enTetesCors(origine: string | null): Record<string, string> {
  if (!origine || !ORIGINES_AUTORISEES.has(origine)) return {};
  return {
    "Access-Control-Allow-Origin": origine,
    "Vary": "Origin",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info, x-supabase-api-version",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

// Enveloppe toute fonction appelable depuis le navigateur : répond au contrôle
// préalable, puis pose les mêmes en-têtes sur la vraie réponse — sans quoi le
// navigateur refuserait de la lire.
export function servir(gestion: (req: Request) => Promise<Response>): void {
  Deno.serve(async (req: Request): Promise<Response> => {
    const cors = enTetesCors(req.headers.get("Origin"));
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const sortie = await gestion(req);
    for (const [clef, valeur] of Object.entries(cors)) sortie.headers.set(clef, valeur);
    return sortie;
  });
}

// Journalisation structurée : une ligne JSON par événement.
// Lisible dans Supabase → Edge Functions → Logs, et filtrable par champ.
// Règle : jamais de numéro complet ni de nom dans les logs (SPECS §5).

export type Champs = Record<string, unknown>;

function emettre(niveau: string, champs: Champs): void {
  const ligne = JSON.stringify({ ts: new Date().toISOString(), niveau, ...champs });
  if (niveau === "error") console.error(ligne);
  else console.log(ligne);
}

export function log(champs: Champs): void {
  emettre("info", champs);
}

export function logErreur(champs: Champs): void {
  emettre("error", champs);
}

// Un numéro ne doit jamais apparaître en clair dans un journal : on garde le
// pays et les deux derniers chiffres, assez pour rapprocher deux lignes.
export function numeroMasque(e164: string | null | undefined): string {
  if (!e164) return "∅";
  if (e164.length < 5) return "…";
  return `${e164.slice(0, 3)}…${e164.slice(-2)}`;
}

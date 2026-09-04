// Dates : le « jour » du rapport est un jour de Paris, pas un jour UTC.
// Un appel de 23 h 30 le 3 septembre à Paris est un appel du 3, alors qu'en UTC
// il est déjà le 4 en hiver. Toute la barre des jours en dépend.

const FUSEAU = "Europe/Paris";

const formatJour = new Intl.DateTimeFormat("en-CA", {
  timeZone: FUSEAU,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function jourParis(date: Date): string {
  const parts = Object.fromEntries(
    formatJour.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// La veille, en jour de Paris. La réconciliation tourne au milieu de la nuit :
// c'est la journée qui vient de se terminer qu'elle vérifie.
export function veilleParis(maintenant: Date = new Date()): string {
  return jourParis(new Date(maintenant.getTime() - 24 * 3600 * 1000));
}

export function estJourValide(valeur: unknown): valeur is string {
  return typeof valeur === "string" && /^\d{4}-\d{2}-\d{2}$/.test(valeur);
}

export type UniteTemps = "secondes" | "millisecondes" | "iso" | "inconnue";
export type TempsAnalyse = { date: Date | null; unite: UniteTemps };

// Ringover peut envoyer un horodatage en secondes, en millisecondes ou en texte
// ISO — la documentation ne le dit pas et ce n'est pas encore vérifié contre la
// vraie API (docs/A_VERIFIER.md, ligne 1). On accepte les trois plutôt que de
// parier : se tromper d'unité, c'est refuser 100 % des appels légitimes.
// Repère : 1e11 secondes = an 5138, donc au-delà ce sont des millisecondes.
export function analyserTemps(valeur: unknown): TempsAnalyse {
  const estEntierTextuel = typeof valeur === "string" && /^\d+$/.test(valeur.trim());
  if (typeof valeur === "number" || estEntierTextuel) {
    const n = Number(valeur);
    if (!Number.isFinite(n) || n <= 0) return { date: null, unite: "inconnue" };
    const unite: UniteTemps = n < 1e11 ? "secondes" : "millisecondes";
    const date = new Date(unite === "secondes" ? n * 1000 : n);
    return Number.isNaN(date.getTime()) ? { date: null, unite: "inconnue" } : { date, unite };
  }
  if (typeof valeur === "string" && valeur.trim()) {
    const date = new Date(valeur);
    if (!Number.isNaN(date.getTime())) return { date, unite: "iso" };
  }
  return { date: null, unite: "inconnue" };
}

export function versISO(valeur: unknown): string | null {
  const { date } = analyserTemps(valeur);
  return date ? date.toISOString() : null;
}

// Anti-rejeu : un événement daté d'il y a plus de 5 minutes (ou du futur) est
// suspect. Renvoie null quand l'horodatage est illisible — dans ce cas on ne
// bloque pas, la signature reste le vrai contrôle de sécurité.
export function ecartMinutes(valeur: unknown, maintenant: Date = new Date()): number | null {
  const { date } = analyserTemps(valeur);
  if (!date) return null;
  return Math.abs(maintenant.getTime() - date.getTime()) / 60000;
}

// Validation des entrées de la fonction admin — logique pure, testable.

export const DOMAINE = "cabinet-ekinox.fr";
const FORME_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Seules les adresses du cabinet peuvent être invitées (SPECS §5.6). C'est la
// deuxième barrière après la fermeture des inscriptions : même un administrateur
// ne peut pas ouvrir l'application à l'extérieur par mégarde.
export function emailInvitable(valeur: unknown): string | null {
  if (typeof valeur !== "string") return null;
  const email = valeur.trim().toLowerCase();
  if (!FORME_EMAIL.test(email)) return null;
  if (!email.endsWith(`@${DOMAINE}`)) return null;
  return email;
}

export function roleValide(valeur: unknown): "admin" | "member" | null {
  if (valeur === undefined || valeur === null || valeur === "") return "member";
  return valeur === "admin" || valeur === "member" ? valeur : null;
}

export function nomAffiche(valeur: unknown, email: string): string {
  if (typeof valeur === "string" && valeur.trim()) return valeur.trim().slice(0, 80);
  // À défaut, la partie gauche de l'adresse : « prenom.nom » devient « Prenom Nom ».
  return email.split("@")[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((m) => m.charAt(0).toUpperCase() + m.slice(1))
    .join(" ") || email;
}

export function uuidValide(valeur: unknown): string | null {
  if (typeof valeur !== "string") return null;
  const v = valeur.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) ? v : null;
}

export type Action = "invite" | "activate" | "deactivate" | "erase" | "webhook-test";

const ACTIONS: readonly Action[] = ["invite", "activate", "deactivate", "erase", "webhook-test"];

export function actionDemandee(url: string): Action | null {
  const chemin = new URL(url).pathname.replace(/\/+$/, "");
  const dernier = chemin.split("/").pop() ?? "";
  return (ACTIONS as readonly string[]).includes(dernier) ? dernier as Action : null;
}

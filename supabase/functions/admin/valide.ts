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

// Un mot de passe fait pour être recopié d'un message Slack, pas pour être
// retenu par cœur : trois groupes de quatre, séparés par des tirets.
//
// L'alphabet écarte les caractères qui se confondent à la lecture — i/l/1,
// o/0 — parce que la panne la plus probable de ce mot de passe n'est pas une
// attaque, c'est quelqu'un qui recopie un « l » là où il y avait un « 1 » et
// qui croit que l'application est cassée.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function motDePasseAleatoire(): string {
  const octets = new Uint8Array(12);
  crypto.getRandomValues(octets);
  const lettres = Array.from(octets, (o) => ALPHABET[o % ALPHABET.length]);
  return [lettres.slice(0, 4), lettres.slice(4, 8), lettres.slice(8, 12)]
    .map((g) => g.join(""))
    .join("-");
}

export type Action =
  | "invite"
  | "activate"
  | "deactivate"
  | "erase"
  | "webhook-test"
  | "password";

const ACTIONS: readonly Action[] = [
  "invite",
  "activate",
  "deactivate",
  "erase",
  "webhook-test",
  "password",
];

export function actionDemandee(url: string): Action | null {
  const chemin = new URL(url).pathname.replace(/\/+$/, "");
  const dernier = chemin.split("/").pop() ?? "";
  return (ACTIONS as readonly string[]).includes(dernier) ? dernier as Action : null;
}

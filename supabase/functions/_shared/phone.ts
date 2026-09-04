// Normalisation des numéros en E.164 (+33612345678).
// Tout le rapprochement avec Jarvi et Modjo repose sur cette forme unique :
// un numéro mal normalisé = un contact jamais retrouvé, donc un appel classé
// « inconnu » à tort. C'est le point le plus sensible de la chaîne.

const PAYS_DEFAUT = "33";

export function versE164(brut: unknown, pays: string = PAYS_DEFAUT): string | null {
  if (typeof brut !== "string" && typeof brut !== "number") return null;
  const texte = String(brut).trim();
  if (!texte) return null;

  const international = texte.startsWith("+");
  const chiffres = texte.replace(/[^0-9]/g, "");
  if (!chiffres) return null;

  // Déjà international : on fait confiance au préfixe donné.
  if (international) return chiffres.length >= 8 ? `+${chiffres}` : null;

  // 0033… ou 00 + indicatif pays
  if (chiffres.startsWith("00")) {
    const reste = chiffres.slice(2);
    return reste.length >= 8 ? `+${reste}` : null;
  }

  // Numéro national français : 0X XX XX XX XX
  if (chiffres.startsWith("0") && chiffres.length === 10) {
    return `+${pays}${chiffres.slice(1)}`;
  }

  // Ringover renvoie souvent l'international sans le « + » : 33612345678
  if (chiffres.length >= 11 && chiffres.length <= 15) return `+${chiffres}`;

  return null;
}

// Le numéro « externe » d'un appel : celui de l'interlocuteur, jamais celui du
// collaborateur. C'est lui qu'on cherchera dans Jarvi.
export function numeroExterne(
  direction: string,
  fromNumber: unknown,
  toNumber: unknown,
): { e164: string | null; brut: string } {
  const sortant = String(direction ?? "").toLowerCase().startsWith("out");
  const choisi = sortant ? toNumber : fromNumber;
  return {
    e164: versE164(choisi),
    brut: String(choisi ?? "").trim(),
  };
}

// La colonne calls.external_number est NOT NULL : un appel anonyme doit quand
// même pouvoir être enregistré, on ne perd jamais une ligne pour ça.
export function numeroExterneOuDefaut(direction: string, fromNumber: unknown, toNumber: unknown): string {
  const { e164, brut } = numeroExterne(direction, fromNumber, toNumber);
  return e164 ?? (brut || "anonyme");
}

export function sensRingover(direction: unknown): "in" | "out" {
  return String(direction ?? "").toLowerCase().startsWith("out") ? "out" : "in";
}

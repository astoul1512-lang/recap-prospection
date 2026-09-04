// Client de l'API publique Jarvi (SPECS §6.2).
//
// C'est Jarvi qui décide seul si un appel est de la prospection : un numéro
// présent comme contact (`isContact`) et rien d'autre. Toute la valeur du
// rapport tient à cette question, donc ce fichier est volontairement tolérant
// sur la FORME de la réponse (le format exact n'est pas documenté : voir
// docs/A_VERIFIER.md n°5) et strict sur le FOND : sans correspondance certaine
// de numéro, on ne conclut rien.

import { avecReprise, fetchAvecDelai } from "./http.ts";
import { chiffresSignificatifs, memeNumero } from "./phone.ts";

const BASE = "https://functions.prod.jarvi.tech/v1/public-api";

export type ProfilJarvi = {
  id: string;
  prenom: string;
  nom: string;
  headline: string | null;
  estContact: boolean;
  estTalent: boolean;
  societeId: string | null;
  societeNom: string | null;
  numeros: string[];
};

export type ResultatJarvi =
  | { etat: "trouve"; profils: ProfilJarvi[] }
  | { etat: "absent" }
  | { etat: "injoignable"; motif: string };

export function cleJarviPresente(): boolean {
  return Boolean(Deno.env.get("jarvi"));
}

function texte(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function booleen(v: unknown): boolean {
  return v === true || v === "true" || v === 1;
}

// La réponse peut être un tableau nu ou un objet enveloppant : on accepte les
// deux plutôt que de dépendre d'une forme non confirmée.
function extraireListe(charge: unknown): Record<string, unknown>[] {
  if (Array.isArray(charge)) return charge.filter((x) => x && typeof x === "object");
  if (charge && typeof charge === "object") {
    for (const clef of ["data", "results", "items", "profiles", "rows"]) {
      const v = (charge as Record<string, unknown>)[clef];
      if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object");
    }
  }
  return [];
}

// `associations` peut être un objet (une société) ou un tableau (plusieurs
// rattachements) : on retient le premier rattachement nommé.
function societe(brut: Record<string, unknown>): { id: string | null; nom: string | null } {
  const candidats: unknown[] = [];
  const assoc = brut.associations;
  if (Array.isArray(assoc)) candidats.push(...assoc);
  else if (assoc && typeof assoc === "object") candidats.push(assoc);
  candidats.push(brut.company, brut.currentCompany);

  for (const candidat of candidats) {
    if (!candidat || typeof candidat !== "object") continue;
    const o = candidat as Record<string, unknown>;
    const entreprise = (o.company && typeof o.company === "object")
      ? o.company as Record<string, unknown>
      : o;
    const nom = texte(entreprise.name) || texte(entreprise.companyName);
    const id = texte(entreprise.id) || texte(entreprise.companyId);
    if (nom || id) return { id: id || null, nom: nom || null };
  }
  return { id: null, nom: null };
}

function numeros(brut: Record<string, unknown>): string[] {
  const liste = Array.isArray(brut.phoneNumbers)
    ? brut.phoneNumbers
    : (Array.isArray(brut.phones) ? brut.phones : []);
  const sortie: string[] = [];
  for (const entree of liste) {
    if (typeof entree === "string") {
      sortie.push(entree);
      continue;
    }
    if (!entree || typeof entree !== "object") continue;
    const o = entree as Record<string, unknown>;
    for (const clef of ["canonicalNumber", "number", "phone", "value"]) {
      const v = texte(o[clef]);
      if (v) sortie.push(v);
    }
  }
  return sortie;
}

export function lireProfil(brut: Record<string, unknown>): ProfilJarvi | null {
  const id = texte(brut.id) || texte(brut._id) || texte(brut.profileId);
  if (!id) return null;
  const soc = societe(brut);
  return {
    id,
    prenom: texte(brut.firstName) || texte(brut.firstname),
    nom: texte(brut.lastName) || texte(brut.lastname),
    headline: texte(brut.headline) || texte(brut.jobTitle) || null,
    estContact: booleen(brut.isContact),
    estTalent: booleen(brut.isTalent),
    societeId: soc.id,
    societeNom: soc.nom,
    numeros: numeros(brut),
  };
}

// Recherche par numéro. Jarvi compare sur les chiffres seuls : on lui envoie la
// partie significative (sans indicatif pays), puis on ne garde que les profils
// dont un numéro correspond réellement au nôtre — un `_search` partiel peut
// remonter un homonyme de suffixe, et attribuer un appel au mauvais contact
// serait pire que ne rien trouver.
export async function chercherParNumero(e164: string): Promise<ResultatJarvi> {
  const cle = Deno.env.get("jarvi");
  if (!cle) return { etat: "injoignable", motif: "cle_absente" };

  const recherche = chiffresSignificatifs(e164);
  if (!recherche) return { etat: "absent" };

  const where = encodeURIComponent(JSON.stringify({ phones: { _search: recherche } }));
  const url = `${BASE}/rest/v2/profiles?where=${where}&limit=5`;

  let reponse: Response;
  try {
    reponse = await avecReprise(() =>
      fetchAvecDelai(url, { headers: { "X-API-KEY": cle, Accept: "application/json" } })
    );
  } catch {
    return { etat: "injoignable", motif: "reseau" };
  }

  if (reponse.status === 404) return { etat: "absent" };
  if (!reponse.ok) {
    await reponse.body?.cancel();
    return { etat: "injoignable", motif: `http_${reponse.status}` };
  }

  let charge: unknown;
  try {
    charge = await reponse.json();
  } catch {
    return { etat: "injoignable", motif: "reponse_illisible" };
  }

  const profils = extraireListe(charge)
    .map(lireProfil)
    .filter((p): p is ProfilJarvi => p !== null)
    .filter((p) => p.numeros.some((n) => memeNumero(n, e164)));

  return profils.length ? { etat: "trouve", profils } : { etat: "absent" };
}

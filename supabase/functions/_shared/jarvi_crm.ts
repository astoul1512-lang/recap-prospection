// Lecture de la partie CRM de Jarvi : les sociétés suivies et leurs contacts.
//
// Même posture que `jarvi.ts` : tolérant sur la FORME de la réponse, strict
// sur le FOND. Le format exact de `/rest/v2/companies` n'est pas documenté
// (docs/A_VERIFIER.md n°6) — on accepte plusieurs noms de champs plutôt que
// de dépendre d'une forme supposée, et le mode sonde de `jarvi-sync` affiche
// ce que l'API renvoie réellement.
//
// Rappel du piège de D7 : un endpoint qui renvoie un tableau là où on attend
// un objet ne lève aucune erreur — il ne lit rien, et conclut « vide ». C'est
// exactement ce que `extraireListe` évite ici.

import { avecReprise, fetchAvecDelai } from "./http.ts";

const BASE = "https://functions.prod.jarvi.tech/v1/public-api";

// Les seuls responsables qui attribuent des comptes. Julien a quitté le
// cabinet, Alexandre ne prospecte pas : à eux deux ils portent 1 431 des
// 1 971 sociétés qui ont un responsable (docs/decisions.md D9). Sans ce
// filtre, la page afficherait deux mille lignes vides.
//
// Le filtre vit ici, à la synchronisation, et non dans le front : un compte
// réattribué à quelqu'un d'autre disparaît de la base au passage suivant.
export const PROSPECTEURS = ["Martin", "Rémy", "Adrien"] as const;

export type SocieteJarvi = {
  id: string;
  nom: string;
  secteur: string | null;
  prospecteurs: string[];
};

export type ContactJarvi = {
  id: string;
  societeId: string;
  nom: string;
  poste: string | null;
  numero: string | null;
};

export type Page<T> = { etat: "ok"; elements: T[] } | { etat: "injoignable"; motif: string };

function texte(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// Jarvi écrit le nom complet sans accent (« Remy Basdim ») ; l'application
// affiche le prénom accentué (« Rémy »). Le rapprochement se fait sur le
// prénom, sans accent et sans casse — l'équipe est petite, aucune ambiguïté.
function sansAccent(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function prospecteurConnu(nomAffiche: string): string | null {
  const prenom = sansAccent(nomAffiche.trim().split(/\s+/)[0] ?? "");
  if (!prenom) return null;
  return PROSPECTEURS.find((p) => sansAccent(p) === prenom) ?? null;
}

// La réponse peut être un tableau nu ou un objet enveloppant. Voir D7.
function extraireListe(charge: unknown): Record<string, unknown>[] {
  if (Array.isArray(charge)) return charge.filter((x) => x && typeof x === "object");
  if (charge && typeof charge === "object") {
    for (const clef of ["data", "results", "items", "companies", "profiles", "rows"]) {
      const v = (charge as Record<string, unknown>)[clef];
      if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object");
    }
  }
  return [];
}

// `assignees` : un tableau d'affectations, chacune portant un `user`. On
// accepte aussi la forme aplatie, au cas où l'API publique la simplifie.
function responsables(brut: Record<string, unknown>): string[] {
  const liste = Array.isArray(brut.assignees) ? brut.assignees : [];
  const noms: string[] = [];
  for (const entree of liste) {
    if (!entree || typeof entree !== "object") continue;
    const o = entree as Record<string, unknown>;
    const u = (o.user && typeof o.user === "object") ? o.user as Record<string, unknown> : o;
    const nom = texte(u.displayName) ||
      [texte(u.firstName) || texte(u.firstname), texte(u.lastName) || texte(u.lastname)]
        .filter(Boolean).join(" ");
    if (nom) noms.push(nom);
  }
  return noms;
}

// Le secteur est un champ personnalisé à choix multiple : plusieurs valeurs
// possibles, on les joint. L'identifiant du champ vit dans
// docs/jarvi-champs.md et nulle part ailleurs.
const CHAMP_SECTEUR = "3665fb39-820b-4f19-a876-0899ec1e7a4d";

function secteur(brut: Record<string, unknown>): string | null {
  const liste = Array.isArray(brut.fieldsValues) ? brut.fieldsValues : [];
  const valeurs: string[] = [];
  for (const entree of liste) {
    if (!entree || typeof entree !== "object") continue;
    const o = entree as Record<string, unknown>;
    const champ = (o.field && typeof o.field === "object") ? o.field as Record<string, unknown> : {};
    const id = texte(o.fieldId) || texte(champ.id);
    if (id !== CHAMP_SECTEUR) continue;
    const v = texte(o.value) || texte((o.fieldValue as Record<string, unknown>)?.name);
    if (v) valeurs.push(v);
  }
  return valeurs.length ? valeurs.join(" · ") : null;
}

// Beaucoup de sociétés ont été créées depuis une adresse LinkedIn : leur
// `name` est alors l'identifiant de l'URL (« cecurity-com ») et non le nom
// qu'on lit sur la fiche. Le vrai nom, quand il existe, est dans les données
// LinkedIn rattachées — même arbitrage que dans `jarvi.ts`.
function nomSociete(brut: Record<string, unknown>): string {
  const linkedin = (brut.linkedinCompanyData && typeof brut.linkedinCompanyData === "object")
    ? brut.linkedinCompanyData as Record<string, unknown>
    : {};
  return texte(linkedin.name) || texte(brut.name) || texte(brut.companyName);
}

export function lireSociete(brut: Record<string, unknown>): SocieteJarvi | null {
  const id = texte(brut.id) || texte(brut._id) || texte(brut.companyId);
  const nom = nomSociete(brut);
  if (!id || !nom) return null;
  const prospecteurs = [...new Set(
    responsables(brut).map(prospecteurConnu).filter((p): p is string => p !== null),
  )];
  return { id, nom, secteur: secteur(brut), prospecteurs };
}

// Le poste s'affiche tel quel dans un tableau : certains `headline` LinkedIn
// font trois lignes, on borne à 120 caractères (lot Sociétés §3).
function poste(brut: Record<string, unknown>): string | null {
  const v = texte(brut.headline) || texte(brut.jobTitle) || texte(brut.position);
  if (!v) return null;
  return v.length > 120 ? v.slice(0, 119).trimEnd() + "…" : v;
}

function premierNumero(brut: Record<string, unknown>): string | null {
  const liste = Array.isArray(brut.phoneNumbers)
    ? brut.phoneNumbers
    : (Array.isArray(brut.phones) ? brut.phones : []);
  for (const entree of liste) {
    if (typeof entree === "string" && entree.trim()) return entree.trim();
    if (!entree || typeof entree !== "object") continue;
    const o = entree as Record<string, unknown>;
    for (const clef of ["canonicalNumber", "number", "phone", "value"]) {
      const v = texte(o[clef]);
      if (v) return v;
    }
  }
  return null;
}

export function lireContact(
  brut: Record<string, unknown>,
  societeId: string,
): ContactJarvi | null {
  const id = texte(brut.id) || texte(brut._id) || texte(brut.profileId);
  if (!id) return null;
  const nom = [texte(brut.firstName) || texte(brut.firstname),
    texte(brut.lastName) || texte(brut.lastname)].filter(Boolean).join(" ");
  if (!nom) return null;
  // Garde-fou : un profil qui n'est pas un contact est un candidat. Aucune de
  // ses données ne doit entrer en base, jamais (CLAUDE.md).
  if (brut.isContact === false) return null;
  return { id, societeId, nom, poste: poste(brut), numero: premierNumero(brut) };
}

async function interroger(url: string): Promise<Page<Record<string, unknown>>> {
  const cle = Deno.env.get("jarvi");
  if (!cle) return { etat: "injoignable", motif: "cle_absente" };

  let reponse: Response;
  try {
    reponse = await avecReprise(() =>
      fetchAvecDelai(url, { headers: { "X-API-KEY": cle, Accept: "application/json" } })
    );
  } catch {
    return { etat: "injoignable", motif: "reseau" };
  }

  if (!reponse.ok) {
    await reponse.body?.cancel();
    return { etat: "injoignable", motif: `http_${reponse.status}` };
  }

  try {
    return { etat: "ok", elements: extraireListe(await reponse.json()) };
  } catch {
    return { etat: "injoignable", motif: "reponse_illisible" };
  }
}

// Une page de sociétés ayant au moins un responsable. Le tri par identifiant
// donne un ordre stable : sans lui, deux pages successives peuvent renvoyer
// deux fois la même société et en sauter une autre.
export async function pageSocietes(limite: number, decalage: number) {
  const where = encodeURIComponent(JSON.stringify({
    deletedAt: { _is_null: true },
    assignees: { deletedAt: { _is_null: true } },
  }));
  return await interroger(
    `${BASE}/rest/v2/companies?where=${where}&order_by=${
      encodeURIComponent(JSON.stringify({ id: "asc" }))
    }&limit=${limite}&offset=${decalage}`,
  );
}

export async function contactsDeLaSociete(societeId: string, limite: number) {
  const where = encodeURIComponent(JSON.stringify({
    deletedAt: { _is_null: true },
    isContact: { _eq: true },
    associations: { companyId: { _eq: societeId } },
  }));
  return await interroger(`${BASE}/rest/v2/profiles?where=${where}&limit=${limite}`);
}

export function urlSociete(id: string): string {
  return `https://app.jarvi.tech/#/crm/companies/${id}`;
}

export function urlContact(id: string): string {
  return `https://app.jarvi.tech/#/crm/profiles/${id}`;
}

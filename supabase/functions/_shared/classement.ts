// Décision de classement d'un appel — logique pure, sans réseau ni base.
//
// Une seule question : cet appel entre-t-il dans le rapport de prospection ?
// La réponse ne dépend que de Jarvi (SPECS §1.1.1). Deux interdits absolus :
//  - ne jamais faire entrer un candidat dans le rapport, ni son nom, ni un
//    compteur (§1.1.2) : un profil `isTalent` sans `isContact` sort, et rien
//    de lui n'est écrit en base ;
//  - ne jamais défaire une décision humaine (§1.1.6).

import type { ProfilJarvi } from "./jarvi.ts";
import { memeNumero } from "./phone.ts";

export type AppelAClasser = {
  call_id: string;
  external_number: string;
  is_internal: boolean;
  is_anonymous: boolean;
  status: string;
  duration_s: number | null;
  outcome: string;
  outcome_manual: string | null;
  kind_manual: string | null;
  machine_detection: string | null;
  reviewed_at: string | null;
};

export type Genre = "prospection" | "hors_prospection" | "inconnu";

// Une minute : la frontière entre « on a échangé » et « il faut trancher à la
// main » (SPECS §1.1.4). Elle sert au webhook, à la réconciliation et à la
// décision de classement — d'où sa place ici, en un seul exemplaire.
export const SEUIL_CONVERSATION_S = 60;

export type Classement = {
  kind: Genre;
  champs: Record<string, unknown>;
};

// Plusieurs profils peuvent porter le même numéro (standard d'entreprise,
// ancien portable réattribué). Le contact prime : c'est lui qui décide du
// caractère « prospection ». À défaut, le premier profil renvoyé.
export function choisirProfil(profils: ProfilJarvi[], e164: string): ProfilJarvi | null {
  const correspondants = profils.filter((p) => p.numeros.some((n) => memeNumero(n, e164)));
  const source = correspondants.length ? correspondants : profils;
  return source.find((p) => p.estContact) ?? source[0] ?? null;
}

export function nomComplet(profil: ProfilJarvi): string | null {
  const nom = [profil.prenom, profil.nom].filter(Boolean).join(" ").trim();
  return nom || null;
}

// Un appel décroché de moins d'une minute doit être tranché à la main, mais
// seulement s'il peut compter dans le rapport (SPECS §5.7). Un répondeur
// reconnu par Ringover n'a rien à y faire : c'est une tentative, pas une
// question posée à l'équipe.
function estCourtAQualifier(appel: AppelAClasser): boolean {
  if (repondeurDetecte(appel.machine_detection)) return false;
  const issue = appel.outcome_manual ?? appel.outcome;
  return issue === "court";
}

export function repondeurDetecte(detection: string | null | undefined): boolean {
  return String(detection ?? "").toUpperCase() === "MACHINE";
}

export type Entree = {
  appel: AppelAClasser;
  profil: ProfilJarvi | null;
  trouve: boolean;
};

export function classer({ appel, profil, trouve }: Entree): Classement {
  const identite = {
    jarvi_profile_id: null as string | null,
    jarvi_company_id: null as string | null,
    contact_name: null as string | null,
    contact_role: null as string | null,
    company_name: null as string | null,
  };

  // 1. Interne, anonyme, numéro non normalisable : hors rapport, sans appeler
  //    Jarvi. Rien à qualifier non plus — ces appels n'ont pas à occuper la file.
  if (appel.is_internal || appel.is_anonymous || !appel.external_number.startsWith("+")) {
    return {
      kind: "hors_prospection",
      champs: { kind: "hors_prospection", ...identite, ...revue(appel, false, null) },
    };
  }

  // 2. Numéro absent de Jarvi : on ne tranche pas à sa place, on demande.
  if (!trouve || !profil) {
    return {
      kind: "inconnu",
      champs: { kind: "inconnu", ...identite, ...revue(appel, true, "inconnu") },
    };
  }

  // 3. Connu de Jarvi mais pas comme contact : c'est un candidat. Il sort du
  //    rapport et aucune de ses données n'est recopiée en base.
  if (!profil.estContact) {
    return {
      kind: "hors_prospection",
      champs: { kind: "hors_prospection", ...identite, ...revue(appel, false, null) },
    };
  }

  // 4. Contact : prospection.
  const court = estCourtAQualifier(appel);
  return {
    kind: "prospection",
    champs: {
      kind: "prospection",
      jarvi_profile_id: profil.id,
      jarvi_company_id: profil.societeId,
      contact_name: nomComplet(profil),
      contact_role: profil.headline,
      company_name: profil.societeNom,
      ...revue(appel, court, court ? "court" : null),
    },
  };
}

// La file « À qualifier » n'est jamais rouverte sur un appel déjà tranché :
// quelqu'un a répondu à la question, la machine ne la repose pas.
function revue(
  appel: AppelAClasser,
  demande: boolean,
  motif: string | null,
): Record<string, unknown> {
  if (appel.reviewed_at) return {};
  return { needs_review: demande, review_reason: demande ? motif : null };
}

// Ligne de cache Jarvi : mémoire de la réponse, valable 30 jours (SPECS §5.2.2).
// On mémorise aussi les absences — sans quoi chaque numéro inconnu, souvent
// rappelé, relancerait une recherche à chaque passage du traitement par lots.
export function ligneCache(e164: string, profil: ProfilJarvi | null): Record<string, unknown> {
  if (!profil) {
    return { phone_e164: e164, found: false, fetched_at: new Date().toISOString() };
  }
  return {
    phone_e164: e164,
    found: true,
    profile_id: profil.id,
    company_id: profil.societeId,
    first_name: profil.prenom || null,
    last_name: profil.nom || null,
    headline: profil.headline,
    company_name: profil.societeNom,
    is_contact: profil.estContact,
    is_talent: profil.estTalent,
    fetched_at: new Date().toISOString(),
  };
}

// Relecture d'une ligne de cache sous la forme d'un profil, pour repasser par
// exactement la même décision que si Jarvi venait de répondre.
export function profilDepuisCache(ligne: Record<string, unknown>): ProfilJarvi | null {
  if (ligne.found !== true) return null;
  const id = typeof ligne.profile_id === "string" ? ligne.profile_id : "";
  if (!id) return null;
  const chaine = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  return {
    id,
    prenom: chaine(ligne.first_name),
    nom: chaine(ligne.last_name),
    headline: chaine(ligne.headline) || null,
    estContact: ligne.is_contact === true,
    estTalent: ligne.is_talent === true,
    societeId: chaine(ligne.company_id) || null,
    societeNom: chaine(ligne.company_name) || null,
    numeros: typeof ligne.phone_e164 === "string" ? [ligne.phone_e164] : [],
  };
}

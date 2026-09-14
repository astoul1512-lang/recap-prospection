// jarvi-sync — recopie la partie CRM de Jarvi utile à la page Sociétés.
//
// Trois entrées :
//  - sans paramètre  : un lot, appelé par pg_cron toutes les quinze minutes ;
//  - `?mode=sonde`   : affiche ce que l'API renvoie vraiment, sans rien écrire ;
//  - bouton « Resynchroniser Jarvi » de l'écran d'administration (même lot,
//    déclenché par un administrateur).
//
// Pourquoi par lots et pas en une fois : environ 665 sociétés et leurs
// contacts ne tiennent pas dans une exécution. Chaque passage prend les
// sociétés les moins fraîchement synchronisées ; le tour complet se boucle en
// quelques heures et recommence. Une panne se rattrape sans intervention, et
// il n'y a aucun curseur à tenir — donc rien à désynchroniser.
//
// Idempotente : tout est en `upsert` sur la clé Jarvi. Deux passages
// successifs écrivent exactement la même chose.

import { log, logErreur } from "../_shared/log.ts";
import { reponse, servir } from "../_shared/http.ts";
import {
  archiverContactsAbsents,
  configurationPresente,
  ecrireCurseur,
  enregistrerContacts,
  enregistrerSocietes,
  jetonCronValide,
  lireCurseur,
  noterPassageTache,
  rattacherAppels,
  remplacerProspecteurs,
  utilisateurActif,
} from "../_shared/db.ts";
import {
  cleJarviPresente,
} from "../_shared/jarvi.ts";
import {
  contactsDeLaSociete,
  lireContact,
  lireSociete,
  pageSocietes,
  urlContact,
  urlSociete,
} from "../_shared/jarvi_crm.ts";

const FN = "jarvi-sync";

// Un lot borné : Jarvi est limité en débit, et la fonction doit finir bien
// avant son délai d'exécution. Chaque société coûte une requête de contacts.
const SOCIETES_PAR_PASSAGE = 25;
const CONTACTS_MAX = 200;
// Une page de lecture Jarvi plus large que le lot écrit : la plupart des
// sociétés lues seront écartées (responsable qui ne prospecte pas), il en
// faut beaucoup pour en retenir vingt-cinq.
const PAGE_JARVI = 100;
const PAGES_MAX = 25;

const CURSEUR = "jarvi_sync_offset";

type Bilan = {
  depuis: number;
  jusqua: number;
  tour_boucle: boolean;
  societes_lues: number;
  societes_retenues: number;
  contacts_lus: number;
  contacts_archives: number;
  appels_rattaches: number;
  erreurs: string[];
};

async function synchroniser(): Promise<Bilan> {
  const depuis = await lireCurseur(CURSEUR);
  const bilan: Bilan = {
    depuis,
    jusqua: depuis,
    tour_boucle: false,
    societes_lues: 0,
    societes_retenues: 0,
    contacts_lus: 0,
    contacts_archives: 0,
    appels_rattaches: 0,
    erreurs: [],
  };

  const retenues: { id: string; nom: string; secteur: string | null; prospecteurs: string[] }[] =
    [];

  // On lit page après page jusqu'à remplir le lot : la proportion de sociétés
  // retenues est faible et imprévisible (environ une sur trois).
  let decalage = depuis;
  for (let page = 0; page < PAGES_MAX && retenues.length < SOCIETES_PAR_PASSAGE; page++) {
    const lot = await pageSocietes(PAGE_JARVI, decalage);
    if (lot.etat === "injoignable") {
      bilan.erreurs.push(`societes:${lot.motif}`);
      break;
    }
    // Liste épuisée : le tour est bouclé, le suivant repart du début. C'est
    // ce qui fait qu'une société créée ce matin finit par arriver, et qu'une
    // société réattribuée finit par disparaître.
    if (!lot.elements.length) {
      bilan.tour_boucle = true;
      decalage = 0;
      break;
    }
    decalage += lot.elements.length;
    bilan.societes_lues += lot.elements.length;
    for (const brut of lot.elements) {
      const societe = lireSociete(brut);
      // Aucun prospecteur reconnu : le compte est à Alexandre ou à Julien, il
      // n'entre pas dans l'application (docs/decisions.md D9).
      if (!societe || !societe.prospecteurs.length) continue;
      retenues.push(societe);
    }
  }

  // Le curseur avance même quand le lot est vide : sinon une tranche sans
  // aucun compte retenu bloquerait le tour indéfiniment.
  bilan.jusqua = decalage;
  await ecrireCurseur(CURSEUR, decalage);

  if (!retenues.length) return bilan;

  const maintenant = new Date().toISOString();
  const ok = await enregistrerSocietes(retenues.map((s) => ({
    jarvi_company_id: s.id,
    name: s.nom,
    sector: s.secteur,
    jarvi_url: urlSociete(s.id),
    archived_at: null, // une société retrouvée sort de l'archive
    synced_at: maintenant,
  })));
  if (!ok) {
    bilan.erreurs.push("ecriture_societes");
    return bilan;
  }
  bilan.societes_retenues = retenues.length;

  for (const societe of retenues) {
    if (!(await remplacerProspecteurs(societe.id, societe.prospecteurs))) {
      bilan.erreurs.push(`prospecteurs:${societe.id}`);
    }

    const lot = await contactsDeLaSociete(societe.id, CONTACTS_MAX);
    if (lot.etat === "injoignable") {
      bilan.erreurs.push(`contacts:${lot.motif}`);
      continue; // la société reste, ses contacts seront repris au tour suivant
    }

    const contacts = lot.elements
      .map((brut) => lireContact(brut, societe.id))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    bilan.contacts_lus += contacts.length;

    if (contacts.length) {
      const ecrits = await enregistrerContacts(contacts.map((c) => ({
        jarvi_profile_id: c.id,
        jarvi_company_id: societe.id,
        name: c.nom,
        role: c.poste,
        phone_e164: c.numero,
        jarvi_url: urlContact(c.id),
        archived_at: null,
        synced_at: maintenant,
      })));
      if (!ecrits) bilan.erreurs.push(`ecriture_contacts:${societe.id}`);
    }

    bilan.contacts_archives += await archiverContactsAbsents(
      societe.id,
      contacts.map((c) => c.id),
    );
  }

  bilan.appels_rattaches = await rattacherAppels();
  return bilan;
}

servir(async (req: Request): Promise<Response> => {
  const debut = Date.now();
  if (req.method !== "POST" && req.method !== "GET") return reponse(405);
  if (!configurationPresente() || !cleJarviPresente()) {
    logErreur({ fn: FN, etape: "configuration", jarvi: cleJarviPresente() });
    return reponse(500);
  }

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "";
  const jetonCron = req.headers.get("x-cron-token") ?? "";
  const parLaTache = await jetonCronValide(jetonCron);

  // Un membre actif peut déclencher un passage depuis l'administration ; le
  // reste du monde n'entre pas, même avec un jeton de portail valide.
  if (!parLaTache) {
    const autorisation = req.headers.get("Authorization") ?? "";
    const userId = autorisation ? await utilisateurActif(autorisation) : null;
    if (!userId) {
      log({ fn: FN, etape: "refus", motif: "non_authentifie" });
      return reponse(401);
    }
  }

  // --- Sonde : ce que l'API renvoie vraiment, sans rien écrire --------------
  //
  // Le format de `/rest/v2/companies` n'est pas documenté (docs/A_VERIFIER.md
  // n°6). Le défaut de D7 — un endpoint qui renvoie un tableau là où on
  // attendait un objet, sans erreur ni message — s'était vu grâce à une sonde
  // exactement comme celle-ci, pas grâce à un test.
  if (mode === "sonde") {
    const lot = await pageSocietes(3, 0);
    if (lot.etat === "injoignable") {
      log({ fn: FN, etape: "sonde", etat: "injoignable", motif: lot.motif });
      return reponse(200, { etat: "injoignable", motif: lot.motif });
    }
    const premiere = lot.elements[0] ?? {};
    const lue = lot.elements[0] ? lireSociete(lot.elements[0]) : null;
    // Les clés, pas les valeurs : aucune donnée nominative dans les journaux.
    return reponse(200, {
      etat: "ok",
      recues: lot.elements.length,
      clefs: Object.keys(premiere).sort(),
      assignees_present: Array.isArray((premiere as Record<string, unknown>).assignees),
      lue_correctement: lue !== null,
      prospecteurs_reconnus: lue?.prospecteurs ?? [],
      secteur_lu: lue?.secteur !== null && lue?.secteur !== undefined,
    });
  }

  const bilan = await synchroniser();
  await noterPassageTache("jarvi_sync", { ...bilan, ms: Date.now() - debut });
  log({ fn: FN, etape: "passage", ...bilan, ms: Date.now() - debut });
  return reponse(200, bilan);
});

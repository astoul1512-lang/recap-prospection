// Accès à la base depuis les edge functions, avec la clé service role.
//
// Choix : appels PostgREST directs par fetch, sans supabase-js. Raisons —
//  1. zéro dépendance à épingler et à surveiller sur un point d'entrée public ;
//  2. le schéma `private` n'est pas exposé à l'API (et ne doit jamais l'être) :
//     on y écrit par des fonctions SQL dédiées, pas par un client générique.
// La clé service role ne quitte jamais ce fichier.

import { avecReprise, fetchAvecDelai } from "./http.ts";

const BASE = Deno.env.get("SUPABASE_URL") ?? "";
const CLE_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SECRET_KEY") ?? "";

export function configurationPresente(): boolean {
  return Boolean(BASE && CLE_SERVICE);
}

function entetes(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: CLE_SERVICE,
    Authorization: `Bearer ${CLE_SERVICE}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function rest(chemin: string, init: RequestInit = {}): Promise<Response> {
  return await avecReprise(() =>
    fetchAvecDelai(`${BASE}/rest/v1/${chemin}`, {
      ...init,
      headers: entetes(init.headers as Record<string, string> | undefined),
    })
  );
}

async function corpsJson(reponse: Response): Promise<unknown[]> {
  const texte = await reponse.text();
  if (!texte) return [];
  try {
    const valeur = JSON.parse(texte);
    return Array.isArray(valeur) ? valeur : [valeur];
  } catch {
    return [];
  }
}

// --- Journal brut des webhooks (schéma private, via fonction SQL dédiée) ------

export async function journaliserEvenement(
  evenement: string,
  callId: string | null,
  tentative: number | null,
  signatureOk: boolean,
  charge: unknown,
): Promise<boolean> {
  const r = await rest("rpc/log_webhook_event", {
    method: "POST",
    body: JSON.stringify({
      p_event: evenement || "inconnu",
      p_call_id: callId,
      p_attempt: tentative,
      p_signature_ok: signatureOk,
      p_payload: charge ?? {},
    }),
  });
  return r.ok;
}

export async function santeWebhook(): Promise<Record<string, unknown> | null> {
  const r = await rest("rpc/webhook_health", { method: "POST", body: "{}" });
  if (!r.ok) return null;
  const lignes = await corpsJson(r);
  return (lignes[0] as Record<string, unknown>) ?? null;
}

// --- Collaborateurs Ringover -------------------------------------------------

export type LigneRingoverUser = {
  ringover_user_id: string;
  display_name: string;
  email: string | null;
};

// À faire AVANT d'insérer l'appel : calls.ringover_user_id est une clé étrangère.
export async function enregistrerRingoverUser(ligne: LigneRingoverUser): Promise<boolean> {
  const r = await rest("ringover_users?on_conflict=ringover_user_id", {
    method: "POST",
    body: JSON.stringify(ligne),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
  return r.ok;
}

// --- Appels ------------------------------------------------------------------

// Renvoie le nombre de lignes réellement créées (0 si l'appel existait déjà) :
// la réconciliation a besoin de savoir ce qu'elle a rattrapé, pas seulement que
// la requête a abouti.
export async function insererAppelSiAbsent(ligne: Record<string, unknown>): Promise<number> {
  const r = await rest("calls?on_conflict=call_id", {
    method: "POST",
    body: JSON.stringify(ligne),
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
  });
  if (!r.ok) return 0;
  return (await corpsJson(r)).length;
}

// Renvoie le nombre de lignes réellement modifiées. Quand `horodatageMs` est
// fourni, la mise à jour n'est appliquée que si l'événement est plus récent que
// le dernier traité : les webhooks arrivent parfois dans le désordre.
export async function modifierAppel(
  callId: string,
  champs: Record<string, unknown>,
  horodatageMs: number | null,
): Promise<number> {
  const filtres = [`call_id=eq.${encodeURIComponent(callId)}`];
  const corps = { ...champs };
  if (horodatageMs !== null) {
    filtres.push(`last_event_ts=lte.${horodatageMs}`);
    corps.last_event_ts = horodatageMs;
  }
  const r = await rest(`calls?${filtres.join("&")}`, {
    method: "PATCH",
    body: JSON.stringify(corps),
    headers: { Prefer: "return=representation" },
  });
  if (!r.ok) return 0;
  return (await corpsJson(r)).length;
}

export async function appelExiste(callId: string): Promise<boolean> {
  const r = await rest(`calls?call_id=eq.${encodeURIComponent(callId)}&select=call_id&limit=1`);
  if (!r.ok) return false;
  return (await corpsJson(r)).length > 0;
}

// --- Classement --------------------------------------------------------------

// Les colonnes dont la décision de classement a besoin, et elles seules.
const CHAMPS_CLASSEMENT =
  "call_id,external_number,is_internal,is_anonymous,status,duration_s,outcome," +
  "outcome_manual,kind_manual,machine_detection,reviewed_at,jarvi_check_count";

export async function appelsAClasser(limite: number): Promise<Record<string, unknown>[]> {
  const r = await rest(
    `calls?kind=eq.a_classer&select=${CHAMPS_CLASSEMENT}&order=started_at.desc&limit=${limite}`,
  );
  if (!r.ok) return [];
  return (await corpsJson(r)) as Record<string, unknown>[];
}

// Les appels dont le numéro était inconnu de Jarvi et dont la revérification
// est due. Le « qui est dû » vient de la vue, pas d'un filtre recopié ici :
// l'échéance (24 h puis 72 h) vit à un seul endroit, avec son commentaire.
export async function appelsARevoirJarvi(limite: number): Promise<Record<string, unknown>[]> {
  const r = await rest(
    `v_a_revoir_jarvi?select=${CHAMPS_CLASSEMENT},passage&order=started_at.desc&limit=${limite}`,
  );
  if (!r.ok) return [];
  return (await corpsJson(r)) as Record<string, unknown>[];
}

export async function appelsParIdentifiants(ids: string[]): Promise<Record<string, unknown>[]> {
  if (!ids.length) return [];
  const liste = ids.map((i) => `"${i.replace(/"/g, "")}"`).join(",");
  const r = await rest(
    `calls?call_id=in.(${encodeURIComponent(liste)})&select=${CHAMPS_CLASSEMENT}`,
  );
  if (!r.ok) return [];
  return (await corpsJson(r)) as Record<string, unknown>[];
}

export async function lireCacheJarvi(e164: string): Promise<Record<string, unknown> | null> {
  const r = await rest(
    `jarvi_cache?phone_e164=eq.${encodeURIComponent(e164)}&select=*&limit=1`,
  );
  if (!r.ok) return null;
  return ((await corpsJson(r))[0] as Record<string, unknown>) ?? null;
}

export async function ecrireCacheJarvi(ligne: Record<string, unknown>): Promise<boolean> {
  const r = await rest("jarvi_cache?on_conflict=phone_e164", {
    method: "POST",
    body: JSON.stringify(ligne),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
  return r.ok;
}

// --- Transcriptions ----------------------------------------------------------

// Le plan de travail vient de la vue, pas d'un filtre recopié ici : une seule
// définition de « ce qu'il manque », partagée avec l'écran d'administration.
export async function appelsSansTranscription(
  limite: number,
  essaisMax: number,
): Promise<Record<string, unknown>[]> {
  const r = await rest(
    `v_sans_transcription?transcript_attempts=lt.${essaisMax}` +
      `&select=call_id,direction,duration_s,transcript_attempts&order=started_at.desc&limit=${limite}`,
  );
  if (!r.ok) return [];
  return (await corpsJson(r)) as Record<string, unknown>[];
}

// --- Sociétés et contacts (copie de travail de la partie CRM de Jarvi) -------

// Où en est le tour de synchronisation. Une commodité, jamais une source de
// vérité : remis à zéro, le tour recommence et tout est réécrit à l'identique.
export async function lireCurseur(nom: string): Promise<number> {
  const r = await rest(`sync_state?nom=eq.${encodeURIComponent(nom)}&select=valeur&limit=1`);
  if (!r.ok) return 0;
  const ligne = (await corpsJson(r))[0] as Record<string, unknown> | undefined;
  return typeof ligne?.valeur === "number" ? ligne.valeur : 0;
}

export async function ecrireCurseur(nom: string, valeur: number): Promise<boolean> {
  const r = await rest("sync_state?on_conflict=nom", {
    method: "POST",
    body: JSON.stringify({ nom, valeur, updated_at: new Date().toISOString() }),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
  return r.ok;
}

export async function enregistrerSocietes(lignes: Record<string, unknown>[]): Promise<boolean> {
  if (!lignes.length) return true;
  const r = await rest("companies?on_conflict=jarvi_company_id", {
    method: "POST",
    body: JSON.stringify(lignes),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
  return r.ok;
}

export async function enregistrerContacts(lignes: Record<string, unknown>[]): Promise<boolean> {
  if (!lignes.length) return true;
  const r = await rest("contacts?on_conflict=jarvi_profile_id", {
    method: "POST",
    body: JSON.stringify(lignes),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
  return r.ok;
}

// Les responsables d'une société sont remplacés en bloc : un responsable
// retiré dans Jarvi doit disparaître, et une ligne orpheline ferait apparaître
// le compte dans la liste de quelqu'un qui ne l'a plus.
export async function remplacerProspecteurs(
  societeId: string,
  prospecteurs: string[],
): Promise<boolean> {
  const cle = `jarvi_company_id=eq.${encodeURIComponent(societeId)}`;
  const suppression = await rest(`company_owners?${cle}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
  if (!suppression.ok) return false;
  if (!prospecteurs.length) return true;
  const r = await rest("company_owners", {
    method: "POST",
    body: JSON.stringify(prospecteurs.map((p) => ({
      jarvi_company_id: societeId,
      prospecteur: p,
    }))),
    headers: { Prefer: "return=minimal" },
  });
  return r.ok;
}

// Disparu de Jarvi : marqué, jamais supprimé. Les appels qui le désignent
// gardent leur fiche, et un contact réactivé retrouve son historique.
export async function archiverContactsAbsents(
  societeId: string,
  presents: string[],
): Promise<number> {
  const liste = presents.map((i) => `"${i.replace(/"/g, "")}"`).join(",");
  const exclusion = presents.length
    ? `&jarvi_profile_id=not.in.(${encodeURIComponent(liste)})`
    : "";
  const r = await rest(
    `contacts?jarvi_company_id=eq.${encodeURIComponent(societeId)}` +
      `&archived_at=is.null${exclusion}`,
    {
      method: "PATCH",
      body: JSON.stringify({ archived_at: new Date().toISOString() }),
      headers: { Prefer: "return=representation" },
    },
  );
  if (!r.ok) return 0;
  return (await corpsJson(r)).length;
}

// Rapprochement appel ↔ contact : d'abord l'identifiant de profil déjà posé
// par `classify`, sinon le numéro. Le faire en SQL plutôt qu'en boucle évite
// de rapatrier des milliers d'appels dans la fonction pour les recomparer.
export async function rattacherAppels(): Promise<number> {
  const r = await rest("rpc/rattacher_appels_contacts", {
    method: "POST",
    body: "{}",
  });
  if (!r.ok) return 0;
  const corps = await corpsJson(r);
  const valeur = corps[0];
  return typeof valeur === "number" ? valeur : 0;
}

// --- Journal des corrections et des usages -----------------------------------

export async function journaliserCorrection(ligne: Record<string, unknown>): Promise<boolean> {
  const r = await rest("corrections", {
    method: "POST",
    body: JSON.stringify(ligne),
    headers: { Prefer: "return=minimal" },
  });
  return r.ok;
}

// Plafond des revérifications manuelles : 60 par heure et par utilisateur
// (SPECS §5.2.5). Compté dans le journal, donc partagé entre instances —
// contrairement à un compteur en mémoire, il résiste aux démarrages à froid.
export async function compterRevisitesJarvi(userId: string): Promise<number> {
  const depuis = new Date(Date.now() - 3600_000).toISOString();
  const r = await rest(
    `corrections?field=eq.jarvi_recheck&author_id=eq.${encodeURIComponent(userId)}` +
      `&created_at=gte.${encodeURIComponent(depuis)}&select=id`,
    { headers: { Prefer: "count=exact", Range: "0-0" } },
  );
  if (!r.ok) return 0;
  const plage = r.headers.get("content-range") ?? "";
  const total = Number(plage.split("/")[1]);
  await r.body?.cancel();
  return Number.isFinite(total) ? total : 0;
}

// --- Complétude des journées -------------------------------------------------

export async function enregistrerJourneeVerifiee(ligne: Record<string, unknown>): Promise<boolean> {
  const r = await rest("day_status?on_conflict=day", {
    method: "POST",
    body: JSON.stringify(ligne),
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
  });
  return r.ok;
}

export async function compterAppelsDuJour(jour: string, source?: string): Promise<number> {
  const filtre = source ? `&source=eq.${source}` : "";
  const r = await rest(`calls?day=eq.${jour}${filtre}&select=call_id`, {
    headers: { Prefer: "count=exact", Range: "0-0" },
  });
  if (!r.ok) return 0;
  const plage = r.headers.get("content-range") ?? "";
  const total = Number(plage.split("/")[1]);
  await r.body?.cancel();
  return Number.isFinite(total) ? total : 0;
}

// Trace du dernier passage réussi d'une tâche planifiée : c'est le seul témoin
// qu'une tâche silencieuse n'est pas une tâche morte (docs/decisions.md, D1).
export async function noterPassageTache(nom: string, detail: unknown): Promise<boolean> {
  const r = await rest("rpc/note_job_run", {
    method: "POST",
    body: JSON.stringify({ p_name: nom, p_detail: detail ?? {} }),
  });
  return r.ok;
}

// --- Jeton des tâches planifiées ---------------------------------------------

// Le jeton n'est pas un secret de fonction mais une valeur rangée en base :
// pg_cron et la fonction lisent la même source, personne n'a à recopier quoi
// que ce soit à la main (docs/decisions.md, D2). La comparaison se fait côté
// base, en temps constant.
export async function jetonCronValide(jeton: string): Promise<boolean> {
  if (!jeton) return false;
  const r = await rest("rpc/check_cron_token", {
    method: "POST",
    body: JSON.stringify({ p_token: jeton }),
  });
  if (!r.ok) return false;
  return (await r.text()).trim() === "true";
}

// Identité de l'appelant à partir de son jeton : c'est la base qui tranche,
// jamais la fonction.
export async function utilisateurActif(jetonAppelant: string): Promise<string | null> {
  const r = await fetchAvecDelai(`${BASE}/rest/v1/rpc/current_active_user`, {
    method: "POST",
    headers: {
      apikey: CLE_SERVICE,
      Authorization: jetonAppelant,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!r.ok) return null;
  const texte = (await r.text()).trim().replace(/^"|"$/g, "");
  return texte && texte !== "null" ? texte : null;
}

// --- Administration ----------------------------------------------------------

export async function enregistrerInvitation(
  email: string,
  displayName: string,
  role: string,
  invitePar: string | null,
): Promise<boolean> {
  const r = await rest("rpc/upsert_invitation", {
    method: "POST",
    body: JSON.stringify({
      p_email: email,
      p_display_name: displayName,
      p_role: role,
      p_invited_by: invitePar,
    }),
  });
  return r.ok;
}

export async function effacerNumero(e164: string): Promise<Record<string, unknown> | null> {
  const r = await rest("rpc/erase_phone", {
    method: "POST",
    body: JSON.stringify({ p_phone: e164 }),
  });
  if (!r.ok) return null;
  const lignes = await corpsJson(r);
  return (lignes[0] as Record<string, unknown>) ?? null;
}

export async function changerActivation(userId: string, actif: boolean): Promise<number> {
  const r = await rest(`app_users?id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify({ active: actif }),
    headers: { Prefer: "return=representation" },
  });
  if (!r.ok) return 0;
  return (await corpsJson(r)).length;
}

// Vérifie, avec le jeton de l'appelant (et non la clé service), qu'il est bien
// administrateur ET passé par la double authentification. C'est la base qui
// tranche, pas la fonction : une seule définition de « admin », dans is_admin().
export async function appelantEstAdmin(jetonAppelant: string): Promise<boolean> {
  const r = await fetchAvecDelai(`${BASE}/rest/v1/rpc/is_admin`, {
    method: "POST",
    headers: {
      apikey: CLE_SERVICE,
      Authorization: jetonAppelant,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!r.ok) return false;
  const texte = (await r.text()).trim();
  return texte === "true";
}

// Envoie l'invitation par courriel (API Auth Admin). Le déclencheur en base
// refusera la création du compte si l'adresse n'a pas été inscrite avant.
export async function inviterParCourriel(email: string, redirection: string): Promise<boolean> {
  const r = await fetchAvecDelai(`${BASE}/auth/v1/invite`, {
    method: "POST",
    headers: entetes(),
    body: JSON.stringify({ email, redirect_to: redirection }),
  });
  return r.ok;
}

// Fabrique un code de connexion sans envoyer le moindre courriel.
//
// `admin/generate_link` produit le lien et le code, et les rend à l'appelant au
// lieu de les poster : c'est exactement ce qu'il faut ici. L'expéditeur intégré
// de Supabase est plafonné à deux courriels par heure — un plafond qui a laissé
// un membre dehors une journée entière — et la protection des liens de Microsoft
// 365 grille les liens avant le clic de l'utilisateur (docs/decisions.md D12).
// Un code transmis de la main à la main ne dépend ni de l'un ni de l'autre.
export async function codeConnexion(email: string, redirection: string): Promise<string | null> {
  const r = await fetchAvecDelai(`${BASE}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: entetes(),
    body: JSON.stringify({ type: "magiclink", email, redirect_to: redirection }),
  });
  if (!r.ok) return null;
  let brut: Record<string, unknown>;
  try {
    brut = await r.json() as Record<string, unknown>;
  } catch {
    return null;
  }
  // L'API REST rend le code à plat ; les bibliothèques le rangent sous
  // `properties`. On accepte les deux plutôt que de parier sur l'un — le code
  // n'est lu nulle part ailleurs, une erreur de nom ici ne lèverait aucune
  // exception et rendrait simplement « impossible » à l'écran.
  const dessous = brut.properties as Record<string, unknown> | undefined;
  const code = brut.email_otp ?? dessous?.email_otp;
  return typeof code === "string" && /^[0-9]{6,}$/.test(code) ? code : null;
}

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

export async function insererAppelSiAbsent(ligne: Record<string, unknown>): Promise<boolean> {
  const r = await rest("calls?on_conflict=call_id", {
    method: "POST",
    body: JSON.stringify(ligne),
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
  });
  return r.ok;
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

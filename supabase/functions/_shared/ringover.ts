// Client de l'API REST Ringover (SPECS §6.1 ter), utilisé par la
// réconciliation nocturne.
//
// Attention : l'API REST et les webhooks ne décrivent PAS un appel de la même
// façon. Les webhooks envoient `duration_in_seconds`, `hangup_time`,
// `is_internal`, `direction: inbound|outbound` et des horodatages epoch ; l'API
// REST renvoie `incall_duration`, `end_time`, `direction: in|out`, des dates
// ISO avec fuseau, et ignore `is_internal`. Confondre les deux modèles
// fabriquerait des lignes fausses : la traduction est faite ici, une seule fois.
//
// Vérifié sur la spécification OpenAPI officielle du 4 septembre 2026
// (https://developer.ringover.com/web/openapi_public.yml) — voir docs/ringover-api.md.

import { avecReprise, fetchAvecDelai } from "./http.ts";

const BASE = "https://public-api.ringover.com/v2";
// Ringover accepte deux requêtes par seconde et par clé : on laisse une demie
// seconde entre deux pages, ce qui suffit et n'allonge pas la nuit.
const PAUSE_PAGE_MS = 500;
const PAR_PAGE = 1000;
const PAGES_MAX = 9; // 9 000 appels : très au-delà d'une journée du cabinet

export type AppelRingover = Record<string, unknown>;

export type ResultatAppels =
  | { etat: "ok"; appels: AppelRingover[]; total: number }
  | { etat: "injoignable"; motif: string };

export function cleRingoverPresente(): boolean {
  return Boolean(Deno.env.get("ringover"));
}

// Les appels d'une journée de Paris, bornes incluses. On envoie l'heure locale
// avec son décalage plutôt que de l'UTC : sinon la journée serait décalée d'une
// ou deux heures selon la saison, et les appels du soir changeraient de jour.
export function bornesJournee(jour: string, decalage: string): { debut: string; fin: string } {
  return { debut: `${jour}T00:00:00${decalage}`, fin: `${jour}T23:59:59${decalage}` };
}

// Décalage de Paris pour une date donnée (+01:00 ou +02:00), calculé sans
// table de fuseaux : on compare l'heure de Paris à l'heure UTC.
export function decalageParis(jour: string): string {
  const reference = new Date(`${jour}T12:00:00Z`);
  const formateur = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    hour12: false,
  });
  const heureParis = Number(formateur.format(reference));
  const heures = heureParis - reference.getUTCHours();
  return `+${String(heures).padStart(2, "0")}:00`;
}

export async function appelsDuJour(jour: string): Promise<ResultatAppels> {
  const cle = Deno.env.get("ringover");
  if (!cle) return { etat: "injoignable", motif: "cle_absente" };

  const { debut, fin } = bornesJournee(jour, decalageParis(jour));
  const appels: AppelRingover[] = [];
  let total = 0;

  for (let page = 0; page < PAGES_MAX; page++) {
    const url = `${BASE}/calls?start_date=${encodeURIComponent(debut)}` +
      `&end_date=${encodeURIComponent(fin)}` +
      `&limit_count=${PAR_PAGE}&limit_offset=${page * PAR_PAGE}`;

    let reponse: Response;
    try {
      reponse = await avecReprise(() =>
        fetchAvecDelai(url, { headers: { Authorization: cle, Accept: "application/json" } })
      );
    } catch {
      return { etat: "injoignable", motif: "reseau" };
    }

    // 204 : aucun appel sur la période. Le corps est vide, il ne faut surtout
    // pas essayer de le lire comme du JSON.
    if (reponse.status === 204) break;
    if (!reponse.ok) {
      await reponse.body?.cancel();
      return { etat: "injoignable", motif: `http_${reponse.status}` };
    }

    let charge: Record<string, unknown>;
    try {
      charge = await reponse.json() as Record<string, unknown>;
    } catch {
      return { etat: "injoignable", motif: "reponse_illisible" };
    }

    const liste = Array.isArray(charge.call_list) ? charge.call_list as AppelRingover[] : [];
    if (typeof charge.total_call_count === "number") total = charge.total_call_count;
    appels.push(...liste);
    if (liste.length < PAR_PAGE) break;
    await new Promise((r) => setTimeout(r, PAUSE_PAGE_MS));
  }

  return { etat: "ok", appels: dedoublonner(appels), total };
}

// Un même appel peut apparaître plusieurs fois dans la liste : un transfert ou
// un passage par un serveur vocal crée plusieurs segments qui partagent le
// `call_id`. On compte des appels, pas des segments — sinon la journée serait
// déclarée incomplète tous les jours.
export function dedoublonner(appels: AppelRingover[]): AppelRingover[] {
  const vus = new Map<string, AppelRingover>();
  for (const appel of appels) {
    const id = identifiant(appel);
    if (!id) continue;
    // On garde le segment le plus long : c'est celui où la conversation a eu lieu.
    const present = vus.get(id);
    if (!present || dureeAppel(appel) > dureeAppel(present)) vus.set(id, appel);
  }
  return [...vus.values()];
}

export function identifiant(appel: AppelRingover): string | null {
  const v = appel.call_id;
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function dureeAppel(appel: AppelRingover): number {
  for (const clef of ["incall_duration", "total_duration"]) {
    const v = appel[clef];
    if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.round(v));
  }
  return 0;
}

// Le webhook enregistre le collaborateur sous la forme « USER22673838 » (c'est
// l'identifiant porté par l'enveloppe), l'API REST sous la forme 22673838. Sans
// cette remise en forme, le même collaborateur existerait en double et la
// moitié de ses appels seraient attribués à un inconnu.
export function identifiantCollaborateur(appel: AppelRingover): string | null {
  const utilisateur = (appel.user && typeof appel.user === "object")
    ? appel.user as Record<string, unknown>
    : {};
  const brut = utilisateur.user_id ?? appel.user_id;
  if (typeof brut === "number" && Number.isFinite(brut)) return `USER${brut}`;
  if (typeof brut === "string" && brut.trim()) {
    const texte = brut.trim();
    return /^\d+$/.test(texte) ? `USER${texte}` : texte;
  }
  return null;
}

export function collaborateur(appel: AppelRingover): {
  ringover_user_id: string;
  display_name: string;
  email: string | null;
} | null {
  const id = identifiantCollaborateur(appel);
  if (!id) return null;
  const u = (appel.user && typeof appel.user === "object")
    ? appel.user as Record<string, unknown>
    : {};
  const texte = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const nom = [texte(u.firstname), texte(u.lastname)].filter(Boolean).join(" ") ||
    texte(u.concat_name) || `Ringover ${id}`;
  return { ringover_user_id: id, display_name: nom, email: texte(u.email) || null };
}

// --- Transcriptions ----------------------------------------------------------
//
// L'option de transcription est active sur le compte Ekinox : le skill de
// préqualification l'utilise en production depuis juillet 2026. Elle ne dépend
// pas des permissions de la clé mais d'un réglage d'équipe — si elle était
// coupée, l'endpoint répondrait 401 et il faudrait le voir tout de suite,
// d'où le détail rapporté par `SondeTranscription`.

export type SondeTranscription = {
  call_id: string;
  http: number;
  etat: string | null;
  clefs: string[];
  segments: number | null;
  langue: string | null;
  caracteres: number | null;
};

export type ResultatTranscription =
  | { etat: "prete"; texte: string; langue: string | null; sonde: SondeTranscription }
  | { etat: "en_cours"; sonde: SondeTranscription }
  | { etat: "absente"; sonde: SondeTranscription }
  | { etat: "refuse"; sonde: SondeTranscription }
  | { etat: "injoignable"; motif: string };

function texteBrut(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// Une transcription diarisée : `speeches[]` porte qui parle (`speaker_id` 0 ou
// 1) et ce qui est dit. On en fait un texte lisible, une réplique par ligne —
// c'est ce que la routine lira, et ce que l'équipe verra dans la fiche appel.
export function assemblerParoles(donnees: unknown): { texte: string; segments: number } {
  const o = (donnees && typeof donnees === "object") ? donnees as Record<string, unknown> : {};
  const brut = Array.isArray(o.speeches) ? o.speeches : (Array.isArray(o.segments) ? o.segments : []);
  const lignes: string[] = [];
  for (const p of brut) {
    if (typeof p === "string") {
      if (p.trim()) lignes.push(p.trim());
      continue;
    }
    if (!p || typeof p !== "object") continue;
    const s = p as Record<string, unknown>;
    const dit = texteBrut(s.content) || texteBrut(s.text) || texteBrut(s.transcript);
    if (!dit) continue;
    const qui = s.speaker_id ?? s.speakerId ?? s.channelId ?? s.channel_id;
    // Canal 1 = l'appelant, canal 0 = l'appelé (documentation Ringover).
    const etiquette = qui === 0 || qui === "0"
      ? "Collaborateur"
      : (qui === 1 || qui === "1" ? "Interlocuteur" : null);
    lignes.push(etiquette ? `${etiquette} : ${dit}` : dit);
  }
  return { texte: lignes.join("\n"), segments: lignes.length };
}

export async function transcription(callId: string): Promise<ResultatTranscription> {
  const cle = Deno.env.get("ringover");
  if (!cle) return { etat: "injoignable", motif: "cle_absente" };

  let reponse: Response;
  try {
    reponse = await avecReprise(() =>
      fetchAvecDelai(`${BASE}/transcriptions/${encodeURIComponent(callId)}`, {
        headers: { Authorization: cle, Accept: "application/json" },
      })
    );
  } catch {
    return { etat: "injoignable", motif: "reseau" };
  }

  const sonde: SondeTranscription = {
    call_id: callId,
    http: reponse.status,
    etat: null,
    clefs: [],
    segments: null,
    langue: null,
    caracteres: null,
  };

  // 204 : la requête est passée, il n'y a simplement rien encore.
  if (reponse.status === 204) return { etat: "en_cours", sonde };
  if (reponse.status === 404) return { etat: "absente", sonde };
  if (reponse.status === 401 || reponse.status === 403) {
    await reponse.body?.cancel();
    return { etat: "refuse", sonde };
  }
  if (!reponse.ok) {
    await reponse.body?.cancel();
    return { etat: "injoignable", motif: `http_${reponse.status}` };
  }

  let charge: Record<string, unknown>;
  try {
    charge = await reponse.json() as Record<string, unknown>;
  } catch {
    return { etat: "injoignable", motif: "reponse_illisible" };
  }

  // La réponse enveloppe parfois la transcription dans une liste : on accepte
  // les deux formes plutôt que de parier sur celle qu'on verra.
  const liste = Array.isArray(charge.list) ? charge.list : (Array.isArray(charge.data) ? charge.data : null);
  const noyau = (liste && liste[0] && typeof liste[0] === "object")
    ? liste[0] as Record<string, unknown>
    : charge;

  sonde.clefs = Object.keys(noyau).slice(0, 25);
  sonde.etat = texteBrut(noyau.transcription_status) || texteBrut(noyau.status) || null;
  sonde.langue = texteBrut(noyau.language) || texteBrut(noyau.lang) || null;

  const donnees = noyau.transcription_data ?? noyau.transcription ?? noyau;
  const { texte, segments } = assemblerParoles(donnees);
  sonde.segments = segments;
  sonde.caracteres = texte.length;

  // Ringover annonce lui-même quand la transcription est terminée. Tant qu'elle
  // ne l'est pas, on ne prend rien : une transcription partielle donnerait un
  // résumé faux, et un résumé faux ne se voit pas.
  const terminee = (sonde.etat ?? "").toUpperCase() === "DONE" || (!sonde.etat && texte.length > 0);
  if (!terminee || !texte) return { etat: "en_cours", sonde };

  return { etat: "prete", texte, langue: sonde.langue, sonde };
}

export type EtatAppel = "answered" | "missed" | "voicemail" | "ended";

// `last_state` est la façon dont Ringover clôt un appel. La liste est celle de
// la spécification officielle, mais elle y est donnée comme un échantillon :
// tout état inconnu est traité comme « terminé sans réponse », jamais comme
// une conversation — dans le doute, on ne gonfle pas l'entonnoir.
export function etatDepuisRingover(appel: AppelRingover): EtatAppel {
  const etat = String(appel.last_state ?? "").toUpperCase();
  if (etat === "VOICEMAIL") return "voicemail";
  if (etat === "MISSED" || etat === "QUEUE_TIMEOUT" || etat === "NOANSWER_TRANSFERED") {
    return "missed";
  }
  if (etat === "ANSWERED" || etat === "BLIND_TRANSFERED" || etat === "PERMANENT_TRANSFERED") {
    return "answered";
  }
  if (appel.is_answered === true && dureeAppel(appel) > 0) return "answered";
  return "ended";
}

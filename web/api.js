// Accès à Supabase : connexion, lecture des vues, corrections, fonctions.
//
// Ce fichier est la seule porte vers le serveur. Deux principes :
//  - on ne demande jamais que ce que l'écran affiche (une requête par vue) ;
//  - on ne filtre rien de sensible ici. C'est la RLS qui décide de ce qu'un
//    membre a le droit de lire ; le front n'est pas une barrière de sécurité,
//    seulement une mise en forme.

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

let client = null;

export function db() {
  if (client) return client;
  if (!globalThis.supabase?.createClient) {
    throw new Error('bibliothèque Supabase absente');
  }
  client = globalThis.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return client;
}

// --- Connexion ---------------------------------------------------------------

export const REDIRECTION = `${location.origin}${location.pathname}`;

export async function envoyerLienConnexion(email) {
  // `shouldCreateUser: false` : une adresse non invitée ne doit pas provoquer
  // la création d'un compte, même vide. C'est la deuxième barrière après le
  // déclencheur en base.
  const { error } = await db().auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: REDIRECTION },
  });
  if (error) throw error;
}

export async function connexionGoogle() {
  const { error } = await db().auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: REDIRECTION, queryParams: { hd: 'cabinet-ekinox.fr' } },
  });
  if (error) throw error;
}

export async function deconnexion() {
  await db().auth.signOut();
}

export async function session() {
  const { data } = await db().auth.getSession();
  return data.session ?? null;
}

export function surChangementSession(rappel) {
  db().auth.onAuthStateChange((evenement, s) => rappel(evenement, s));
}

// Le niveau d'assurance : `aal2` signifie « second facteur vérifié dans cette
// session ». Les policies d'administration l'exigent — sans lui, `is_admin()`
// répond faux et l'écran d'administration serait vide sans explication.
export async function niveauAuthentification() {
  const { data, error } = await db().auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) return { actuel: 'aal1', requis: 'aal1' };
  return { actuel: data.currentLevel || 'aal1', requis: data.nextLevel || 'aal1' };
}

export async function facteurs() {
  const { data, error } = await db().auth.mfa.listFactors();
  if (error) throw error;
  return data.totp ?? [];
}

export async function inscrireFacteur() {
  const { data, error } = await db().auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: `Récap ${Date.now()}`,
  });
  if (error) throw error;
  return { id: data.id, qr: data.totp?.qr_code ?? '', secret: data.totp?.secret ?? '' };
}

export async function verifierFacteur(factorId, code) {
  const defi = await db().auth.mfa.challenge({ factorId });
  if (defi.error) throw defi.error;
  const { error } = await db().auth.mfa.verify({
    factorId, challengeId: defi.data.id, code,
  });
  if (error) throw error;
}

export async function retirerFacteur(factorId) {
  await db().auth.mfa.unenroll({ factorId });
}

// --- Qui suis-je -------------------------------------------------------------

export async function monProfil() {
  const { data, error } = await db()
    .from('app_users')
    .select('id, email, display_name, role, active')
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

// --- Lecture ------------------------------------------------------------------

// La transcription n'est pas dans cette liste, et c'est délibéré : l'écran du
// jour charge cinquante appels d'un coup. La fiche appel va la chercher à
// l'unité, quand on la déplie.
const CHAMPS_APPEL = 'call_id, day, started_at, direction, external_number, duration_s, status, ' +
  'kind_eff, outcome_eff, kind_manual, outcome_manual, situation, summary, next_step, ' +
  'needs_review, review_reason, jarvi_check_count, company_name, contact_name, contact_role, ' +
  'record_link, jarvi_profile_id, jarvi_company_id, user_name, ringover_user_id, source, ' +
  'machine_detection, a_transcription';

export async function appels(du, au) {
  const { data, error } = await db()
    .from('v_calls')
    .select(CHAMPS_APPEL)
    .gte('day', du)
    .lte('day', au)
    .order('started_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function completude(du, au) {
  const { data, error } = await db()
    .from('day_status')
    .select('day, webhook_count, api_count, complete, checked_at')
    .gte('day', du)
    .lte('day', au);
  if (error) throw error;
  const parJour = {};
  for (const ligne of data ?? []) parJour[ligne.day] = ligne;
  return parJour;
}

export async function collaborateurs() {
  const { data, error } = await db()
    .from('ringover_users')
    .select('ringover_user_id, display_name, active')
    .eq('active', true)
    .order('display_name');
  if (error) throw error;
  return data ?? [];
}

export async function historique(callId) {
  const { data, error } = await db()
    .from('corrections')
    .select('field, old_value, new_value, created_at, author_id')
    .eq('call_id', callId)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw error;
  return data ?? [];
}

export async function tousLesMembres() {
  const { data, error } = await db()
    .from('app_users')
    .select('id, email, display_name, role, active')
    .order('display_name');
  if (error) throw error;
  return data ?? [];
}

export async function toutesLesLignes() {
  const { data, error } = await db()
    .from('ringover_users')
    .select('ringover_user_id, display_name, email, active')
    .order('display_name');
  if (error) throw error;
  return data ?? [];
}

// Chargée seulement quand on déplie « Transcription » dans la fiche appel :
// c'est le seul endroit où quelqu'un veut vraiment lire l'échange.
export async function transcription(callId) {
  const { data, error } = await db()
    .from('calls')
    .select('transcript, transcript_fetched_at, transcript_attempts')
    .eq('call_id', callId)
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

export async function nombreSansTranscription() {
  const { count, error } = await db()
    .from('v_sans_transcription')
    .select('call_id', { count: 'exact', head: true });
  if (error) throw error;
  return count ?? 0;
}

export async function passagesTaches() {
  const { data, error } = await db().from('job_runs').select('name, ran_at, detail');
  if (error) throw error;
  const parNom = {};
  for (const ligne of data ?? []) parNom[ligne.name] = ligne;
  return parNom;
}

// --- Écriture ------------------------------------------------------------------

// Seules ces colonnes sont modifiables par un membre : le déclencheur
// `calls_guard` remet toutes les autres à leur valeur et journalise celles-ci.
// Envoyer autre chose ne produit pas d'erreur, seulement une écriture ignorée —
// d'où la liste explicite, pour que l'intention reste lisible.
export async function corriger(callId, champs) {
  const permis = ['kind_manual', 'outcome_manual', 'situation', 'summary', 'next_step', 'needs_review'];
  const charge = {};
  for (const clef of permis) if (clef in champs) charge[clef] = champs[clef];
  if (!Object.keys(charge).length) return null;
  const { error } = await db().from('calls').update(charge).eq('call_id', callId);
  if (error) throw error;
  // On relit dans `v_calls` et non dans `calls` : c'est la vue qui porte les
  // valeurs effectives (`kind_eff`, `outcome_eff`, le nom du collaborateur).
  // Elle peut ne rien renvoyer — classer un appel « hors prospection » le fait
  // sortir du rapport, et c'est exactement ce qu'on lui a demandé.
  const { data } = await db().from('v_calls').select(CHAMPS_APPEL).eq('call_id', callId).limit(1);
  return data?.[0] ?? null;
}

// Journal d'usage (SPECS §7.3) : qui a exporté, qui a écouté un enregistrement.
// Volontairement silencieux en cas d'échec — perdre une ligne de journal ne doit
// jamais empêcher quelqu'un de travailler.
export async function journaliserUsage(callId, action, note) {
  try {
    const s = await session();
    if (!s) return;
    await db().from('corrections').insert({
      call_id: callId, field: action, new_value: note ?? null, author_id: s.user.id,
    });
  } catch { /* sans conséquence */ }
}

export async function reverifierJarvi(callIds) {
  const { data, error } = await db().functions.invoke('classify', { body: { call_ids: callIds } });
  if (error) throw error;
  return data?.updated ?? [];
}

// --- Administration --------------------------------------------------------------

async function fonctionAdmin(chemin, corps) {
  const { data, error } = await db().functions.invoke(chemin, { body: corps ?? {} });
  if (error) throw error;
  return data;
}

export const inviter = (email, displayName) => fonctionAdmin('admin/invite', { email, display_name: displayName, role: 'member' });
export const activerMembre = (userId, actif) => fonctionAdmin(actif ? 'admin/activate' : 'admin/deactivate', { user_id: userId });
export const effacerNumero = (phone) => fonctionAdmin('admin/erase', { phone });
export const santeCollecte = () => fonctionAdmin('admin/webhook-test', {});
export const relancerReconciliation = (jour) => fonctionAdmin(jour ? `reconcile?day=${jour}` : 'reconcile', {});

export async function changerRole(userId, role) {
  const { error } = await db().from('app_users').update({ role }).eq('id', userId);
  if (error) throw error;
}

export async function reattribuerLigne(ringoverUserId, displayName) {
  const { error } = await db()
    .from('ringover_users')
    .update({ display_name: displayName })
    .eq('ringover_user_id', ringoverUserId);
  if (error) throw error;
}

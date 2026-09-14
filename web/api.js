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

// Le même appel envoie le code à six chiffres et le lien : c'est le gabarit de
// mail, côté Supabase, qui décide de ce qui est affiché. On garde les deux —
// mais c'est le code qui fait foi. Un lien de connexion est à usage unique, et
// la protection des liens de Microsoft 365 l'ouvre avant l'utilisateur pour
// l'analyser : il est grillé avant le clic humain. Un code se recopie à la
// main, d'un appareil à l'autre, et aucun antivirus ne le consomme.
export async function envoyerCodeConnexion(email) {
  // `shouldCreateUser: false` : une adresse non invitée ne doit pas provoquer
  // la création d'un compte, même vide. C'est la deuxième barrière après le
  // déclencheur en base.
  const { error } = await db().auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: REDIRECTION },
  });
  if (error) throw error;
}

export async function verifierCodeConnexion(email, token) {
  const { error } = await db().auth.verifyOtp({ email, token, type: 'email' });
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

// Les appels que la routine a écartés du rapport. Visibles nulle part ailleurs
// — c'est bien le but — mais une décision automatique invisible ET indéfaisable
// serait une décision qu'on subit.
export async function appelsEcartes() {
  const { data, error } = await db()
    .from('v_ecartes')
    .select('call_id, day, started_at, duration_s, direction, company_name, contact_name, hors_rapport_motif, summary, user_name')
    .limit(100);
  if (error) throw error;
  return data ?? [];
}

export async function reintegrer(callId) {
  const { data, error } = await db().rpc('reintegrer_appel', { p_call_id: callId });
  if (error) throw error;
  return data === true;
}

// --- Sociétés -------------------------------------------------------------------

// Une ligne par couple (société × prospecteur) : un compte partagé revient
// deux fois, une fois dans la liste de chacun. Tout est déjà calculé par la
// vue — le front ne fait qu'afficher, filtrer et trier.
const CHAMPS_COMPTE = 'company_id, name, sector, jarvi_url, prospecteur, nb_contacts, '
  + 'nb_contacts_appeles_par_proprietaire, nb_contacts_appeles_total, nb_contacts_avec_echange, '
  + 'nb_appels_proprietaire, dernier_appel_proprietaire_at, dernier_appel_at, dernier_appel_par, '
  + 'nb_appels, situations, situation_chaude, etat_des_lieux, etat_des_lieux_at, seuil_jours, '
  + 'jours_depuis_dernier_appel, etat';

export async function comptes() {
  const { data, error } = await db().from('v_comptes').select(CHAMPS_COMPTE).order('name');
  if (error) throw error;
  return data ?? [];
}

export async function contactsDuCompte(companyId, prospecteur) {
  const { data, error } = await db()
    .from('v_compte_contacts')
    .select('contact_id, contact_name, contact_role, jarvi_url, nb_appels, dernier_appel_at, '
      + 'dernier_appel_par, derniere_situation, appele_par_proprietaire, a_echange')
    .eq('company_id', companyId)
    .eq('prospecteur', prospecteur)
    .order('contact_name');
  if (error) throw error;
  return data ?? [];
}

export async function appelsDuCompte(companyId) {
  const { data, error } = await db()
    .from('v_compte_appels')
    .select('call_id, contact_id, day, started_at, user_name, situation, summary, next_step, '
      + 'record_link, echange, duration_s, status')
    .eq('company_id', companyId)
    .order('started_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// La recherche porte aussi sur les noms de contacts, et il y en a plusieurs
// milliers : les charger tous pour filtrer dans le navigateur serait absurde.
// On demande au serveur quelles sociétés ont un contact qui correspond.
// Les caractères qui ont un sens dans un filtre PostgREST sont retirés : une
// virgule tapée dans la case couperait la requête en deux.
export async function comptesAyantUnContact(texte) {
  const q = String(texte || '').replace(/[%*,().]/g, ' ').trim();
  if (q.length < 2) return [];
  const { data, error } = await db()
    .from('contacts')
    .select('jarvi_company_id')
    .is('archived_at', null)
    .ilike('name', `%${q}%`)
    .limit(500);
  if (error) throw error;
  return [...new Set((data ?? []).map((l) => l.jarvi_company_id))];
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
// Rattrapage : reprend les N journées précédant hier, en une seule fois.
export const rattraper = (jours) => fonctionAdmin(`reconcile?jours=${jours}`, {});
// Une tranche de sociétés, la suivante dans le tour. Le bouton ne
// « resynchronise pas tout » — 665 comptes ne tiennent pas dans une
// exécution — il avance d'un cran, comme la tâche planifiée.
export const synchroniserJarvi = () => fonctionAdmin('jarvi-sync', {});
// La sonde lit trois sociétés et n'écrit rien : elle dit si l'API publique de
// Jarvi expose bien le responsable et le secteur (docs/A_VERIFIER.md n°6).
export const sonderJarvi = () => fonctionAdmin('jarvi-sync?mode=sonde', {});

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

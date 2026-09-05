// Point d'entrée : état, routage, chargement des données, actions.
//
// L'application ne rend rien tant que la session n'est pas vérifiée : pas de
// « flash » de données pour quelqu'un qui vient d'être déconnecté (SPECS §7.2).
// Un seul cycle : on charge ce dont l'écran a besoin, on rend, on rebranche les
// événements. Pas de rendu partiel — à ces volumes, c'est inutilement subtil.

import { VERSION } from './version.js';
import * as api from './api.js';
import {
  ajouterJours, aujourdhui, dateFR, esc, joursOuvres, joursSemaine, lundiDe, versCSV,
} from './format.js';
import {
  coquille, vueAdmin, vueConnexion, vueEquipe, vueJour, vueQualifier, vueRefus, vueSemaine,
} from './vues.js';

const racine = document.getElementById('app');
const zoneToast = document.getElementById('toast');
const zoneModale = document.getElementById('modal');

const JOUR = aujourdhui();

const S = {
  phase: 'demarrage', // demarrage | connexion | refus | pret
  vue: 'jour',
  moi: null,
  email: '',
  etapeConnexion: 'adresse',
  erreurConnexion: '',
  mfa: null,
  message: '',

  aujourdhui: JOUR,
  jour: JOUR,
  mode: 'jour',
  du: lundiDe(JOUR),
  au: JOUR,
  semaine: lundiDe(JOUR),
  jours: [JOUR],
  qui: 'tous',
  sel: null,
  sfiltre: '',
  qfiltre: 'tous',
  xvue: preference('rp_xvue', 'colonnes'),
  montrerAutres: false,
  notes: {},
  reportes: new Set(),

  appels: [],
  appelsPrecedents: [],
  aQualifier: [],
  nombreAQualifier: 0,
  completude: {},
  collaborateurs: [],
  historique: [],
  transcription: null,
  transcriptionOuverte: false,
  admin: {},
  chargement: false,
  erreurChargement: '',
};

function preference(clef, defaut) {
  try {
    return localStorage.getItem(clef) || defaut;
  } catch {
    return defaut;
  }
}

function memoriser(clef, valeur) {
  try {
    localStorage.setItem(clef, valeur);
  } catch { /* navigation privée : sans conséquence */ }
}

function toast(message) {
  zoneToast.textContent = message;
  zoneToast.classList.add('on');
  clearTimeout(zoneToast._t);
  zoneToast._t = setTimeout(() => zoneToast.classList.remove('on'), 3200);
}

function modale(html) {
  if (!html) {
    zoneModale.classList.remove('open');
    zoneModale.innerHTML = '';
    return;
  }
  zoneModale.innerHTML = `<div class="box">${html}</div>`;
  zoneModale.classList.add('open');
}

// Une erreur venue du serveur ne doit jamais s'afficher telle quelle : elle
// parle de tables et de codes. On dit ce qui s'est passé, en français.
function echec(quoi, erreur) {
  console.error(quoi, erreur);
  toast(`${quoi} — réessayez dans un instant.`);
}

// --- Routage -------------------------------------------------------------------

const VUES = ['jour', 'semaine', 'qualifier', 'equipe', 'admin'];

function lireAdresse() {
  const brut = location.hash.slice(1);
  const [vue, requete] = brut.split('?');
  const p = new URLSearchParams(requete || '');
  if (VUES.includes(vue)) S.vue = vue;
  if (p.get('d')) {
    S.jour = p.get('d');
    S.mode = 'jour';
  }
  if (p.get('w')) S.semaine = lundiDe(p.get('w'));
}

function aller(vue) {
  S.vue = vue;
  S.sel = null;
  S.sfiltre = '';
  if (location.hash !== `#${vue}`) history.replaceState(null, '', `#${vue}`);
  charger();
  window.scrollTo(0, 0);
}

// --- Chargement ------------------------------------------------------------------

function periode() {
  if (S.vue === 'semaine' || S.vue === 'equipe') {
    const j = joursSemaine(S.semaine);
    return { du: j[0], au: j[4] };
  }
  if (S.mode === 'plage') return { du: S.du, au: S.au };
  return { du: S.jour, au: S.jour };
}

const pourMoi = (c) => S.qui === 'tous' || c.ringover_user_id === S.qui;

async function chargerFile() {
  const debut = ajouterJours(S.aujourdhui, -7);
  const lignes = await api.appels(debut, S.aujourdhui);
  S.aQualifier = lignes.filter((c) => c.needs_review && !S.reportes.has(c.call_id));
  S.nombreAQualifier = S.aQualifier.length;
}

async function charger() {
  S.chargement = true;
  S.erreurChargement = '';
  rendre();
  try {
    const { du, au } = periode();
    if (!S.collaborateurs.length) S.collaborateurs = await api.collaborateurs();

    let fileChargee = false;
    if (S.vue === 'qualifier') {
      await chargerFile();
      // Même tableau des deux côtés : une correction faite ici doit se voir
      // dans la fiche appel sans avoir à recharger quoi que ce soit.
      S.appels = S.aQualifier;
      fileChargee = true;
    } else if (S.vue === 'admin') {
      const [membres, lignes, taches, sansTranscription] = await Promise.all([
        api.tousLesMembres(), api.toutesLesLignes(), api.passagesTaches(),
        api.nombreSansTranscription().catch(() => 0),
      ]);
      const ecartes = await api.appelsEcartes().catch(() => []);
      let sante = null;
      try {
        sante = await api.santeCollecte();
      } catch (e) {
        console.error('état de la collecte', e);
      }
      S.admin = { membres, lignes, taches, sante, sansTranscription, ecartes };
      S.completude = await api.completude(ajouterJours(S.aujourdhui, -14), S.aujourdhui);
      S.appels = [];
    } else {
      const semaineVisible = joursSemaine(lundiDe(S.jour));
      const [lignes, jours] = await Promise.all([
        api.appels(du, au),
        api.completude(
          S.vue === 'jour' && S.mode === 'jour' ? semaineVisible[0] : du,
          S.vue === 'jour' && S.mode === 'jour' ? semaineVisible[4] : au,
        ),
      ]);
      S.completude = jours;
      // La vue Collaborateurs compare les personnes entre elles : la filtrer
      // sur une seule d'entre elles n'aurait pas de sens.
      S.appels = S.vue === 'equipe' ? lignes : lignes.filter(pourMoi);
      S.jours = S.mode === 'plage' ? joursOuvres(S.du, S.au).filter((j) => j <= S.aujourdhui) : [S.jour];

      if (S.vue === 'semaine') {
        const p = joursSemaine(ajouterJours(S.semaine, -7));
        S.appelsPrecedents = (await api.appels(p[0], p[4])).filter(pourMoi);
      }
    }
    // La pastille rouge du menu doit être juste sur tous les écrans, pas
    // seulement sur celui de la file.
    if (!fileChargee) await chargerFile().catch(() => {});
  } catch (erreur) {
    // Une panne de chargement ne doit JAMAIS ressembler à une journée sans
    // appels : les deux s'affichent avec des zéros partout, et seul le premier
    // cas demande une action. D'où ce bandeau, en plus du message fugace.
    console.error('chargement', erreur);
    S.erreurChargement = erreur?.message
      ? `Les appels n'ont pas pu être chargés (${erreur.message}).`
      : "Les appels n'ont pas pu être chargés.";
    S.appels = [];
  } finally {
    S.chargement = false;
    rendre();
  }
}

// --- Rendu ---------------------------------------------------------------------

function rendre() {
  if (S.phase === 'demarrage') {
    racine.innerHTML = `<main class="plein"><p class="eyebrow">Cabinet Ekinox</p><h1 class="serif">Récap prospection</h1><p class="chapeau">Vérification de la session…</p></main>`;
    return;
  }
  if (S.phase === 'connexion') {
    racine.innerHTML = vueConnexion(S);
    brancher();
    return;
  }
  if (S.phase === 'refus') {
    racine.innerHTML = vueRefus(S.message);
    brancher();
    return;
  }
  const bandeau = S.erreurChargement
    ? `<div class="card alerte"><div><b>${esc(S.erreurChargement)}</b>
        <div class="s">Les chiffres affichés ci-dessous sont donc faux : ce ne sont pas des zéros, c'est une absence de réponse du serveur.</div></div>
        <button class="btn sm" data-act="recharger">Réessayer</button></div>`
    : '';
  const corps = {
    jour: vueJour, semaine: vueSemaine, qualifier: vueQualifier, equipe: vueEquipe, admin: vueAdmin,
  }[S.vue](S);
  racine.innerHTML = coquille(S, bandeau + corps, VERSION);
  poserDimensions();
  brancher();
}

// La politique de sécurité du contenu interdit les attributs `style` écrits
// dans le HTML. Les quelques valeurs calculées sont donc posées ici, par
// l'interface de style du navigateur — ce que la CSP autorise.
function poserDimensions() {
  racine.querySelectorAll('[data-flex]').forEach((n) => { n.style.flex = n.dataset.flex; });
  racine.querySelectorAll('[data-h]').forEach((n) => { n.style.height = `${n.dataset.h}%`; });
  racine.querySelectorAll('[data-w]').forEach((n) => { n.style.width = `${n.dataset.w}px`; });
}

// --- Branchement des événements ---------------------------------------------------

function sur(selecteur, evenement, fonction) {
  racine.querySelectorAll(selecteur).forEach((n) => n.addEventListener(evenement, fonction));
}

function brancher() {
  sur('[data-act]', 'click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    agir(e.currentTarget.dataset.act, e.currentTarget);
  });
  sur('[data-jour]', 'click', (e) => {
    S.jour = e.currentTarget.dataset.jour;
    S.mode = 'jour';
    S.sel = null;
    charger();
  });
  sur('[data-sem]', 'click', (e) => {
    let j = ajouterJours(S.jour, 7 * Number(e.currentTarget.dataset.sem));
    while (j > S.aujourdhui) j = ajouterJours(j, -1);
    while ([0, 6].includes(new Date(`${j}T12:00:00`).getDay())) j = ajouterJours(j, -1);
    S.jour = j;
    S.sel = null;
    charger();
  });
  sur('[data-semaine]', 'click', (e) => {
    const n = Number(e.currentTarget.dataset.semaine);
    S.semaine = n === 0 ? lundiDe(S.aujourdhui) : ajouterJours(S.semaine, 7 * n);
    if (S.semaine > lundiDe(S.aujourdhui)) S.semaine = lundiDe(S.aujourdhui);
    charger();
  });
  sur('[data-mode]', 'click', (e) => {
    S.mode = e.currentTarget.dataset.mode;
    S.sel = null;
    charger();
  });
  sur('[data-preset]', 'click', (e) => {
    const p = e.currentTarget.dataset.preset;
    S.mode = 'plage';
    if (p === 'semaine') { S.du = lundiDe(S.aujourdhui); S.au = S.aujourdhui; } else if (p === 'derniere') {
      S.du = ajouterJours(lundiDe(S.aujourdhui), -7);
      S.au = ajouterJours(lundiDe(S.aujourdhui), -3);
    } else { S.du = ajouterJours(S.aujourdhui, -29); S.au = S.aujourdhui; }
    charger();
  });
  sur('#du', 'change', (e) => {
    S.du = e.target.value;
    if (S.au < S.du) S.au = S.du;
    charger();
  });
  sur('#au', 'change', (e) => {
    S.au = e.target.value;
    if (S.au < S.du) S.du = S.au;
    charger();
  });
  sur('#whoSel', 'change', (e) => { S.qui = e.target.value; S.sel = null; charger(); });
  sur('[data-qui]', 'click', (e) => { S.qui = e.currentTarget.dataset.qui; charger(); });
  sur('[data-xvue]', 'click', (e) => {
    S.xvue = e.currentTarget.dataset.xvue;
    memoriser('rp_xvue', S.xvue);
    rendre();
  });
  sur('[data-sfiltre]', 'click', (e) => {
    const v = e.currentTarget.dataset.sfiltre;
    S.sfiltre = S.sfiltre === v ? '' : v;
    S.sel = null;
    rendre();
  });
  sur('[data-qfiltre]', 'click', (e) => { S.qfiltre = e.currentTarget.dataset.qfiltre; rendre(); });
  sur('[data-allerjour]', 'click', (e) => {
    S.jour = e.currentTarget.dataset.allerjour;
    S.mode = 'jour';
    aller('jour');
  });
  sur('[data-equipe]', 'click', (e) => { S.qui = e.currentTarget.dataset.equipe; aller('semaine'); });
  sur('[data-sel]', 'click', (e) => selectionner(e.currentTarget.dataset.sel));
  sur('[data-sel]', 'keydown', (e) => {
    if (e.key === 'Enter') selectionner(e.currentTarget.dataset.sel);
  });
  sur('[data-genre]', 'click', (e) => corriger({ kind_manual: e.currentTarget.dataset.genre }));
  sur('[data-issue]', 'click', (e) => corriger({ outcome_manual: e.currentTarget.dataset.issue }));
  sur('[data-situ]', 'click', (e) => {
    const situation = e.currentTarget.dataset.situ;
    const champs = { situation };
    // Une situation « rendez-vous pris » et une issue qui dit autre chose se
    // contrediraient dans l'entonnoir : on aligne les deux.
    if (situation === 'rdv') champs.outcome_manual = 'rdv';
    corriger(champs);
  });
  sur('[data-qgenre]', 'click', (e) => {
    qualifier(e.currentTarget.dataset.id, { kind_manual: e.currentTarget.dataset.qgenre });
  });
  sur('[data-qissue]', 'click', (e) => {
    qualifier(e.currentTarget.dataset.id, { outcome_manual: e.currentTarget.dataset.qissue });
  });
  sur('[data-qnote]', 'input', (e) => { S.notes[e.target.dataset.qnote] = e.target.value; });
  sur('[data-bascule]', 'click', (e) => basculerMembre(e.currentTarget.dataset.bascule));
  sur('[data-role]', 'change', async (e) => {
    try {
      await api.changerRole(e.target.dataset.role, e.target.value);
      toast(`Rôle changé : ${e.target.value === 'admin' ? 'admin (double authentification requise)' : 'membre'}`);
    } catch (erreur) { echec('Changement de rôle impossible', erreur); }
  });
  sur('[data-ligne]', 'change', async (e) => {
    try {
      await api.reattribuerLigne(e.target.dataset.ligne, e.target.value.trim());
      toast('Ligne réattribuée — les prochains appels seront comptés à cette personne.');
    } catch (erreur) { echec('Réattribution impossible', erreur); }
  });
  sur('.depliant', 'toggle', (e) => {
    S.transcriptionOuverte = e.currentTarget.open;
    if (e.currentTarget.open) chargerTranscription();
  });
  sur('#code', 'keydown', (e) => { if (e.key === 'Enter') agir(S.etapeConnexion === 'mfa' ? 'mfa-verifier' : 'mfa-inscrire'); });
  sur('#em', 'keydown', (e) => { if (e.key === 'Enter') agir('lien'); });
}

function appelSelectionne() {
  return S.appels.find((c) => c.call_id === S.sel)
    || S.aQualifier.find((c) => c.call_id === S.sel);
}

async function selectionner(callId) {
  S.sel = callId;
  S.historique = [];
  S.transcription = null;
  S.transcriptionOuverte = false;
  rendre();
  if (window.innerWidth <= 1100) document.querySelector('.detail')?.classList.add('open');
  try {
    S.historique = await api.historique(callId);
    rendre();
  } catch { /* l'historique manquant n'empêche pas de travailler */ }
}

// La transcription n'est demandée qu'au moment où quelqu'un la déplie : c'est
// plusieurs milliers de caractères qu'on ne veut pas charger cinquante fois par
// écran du jour.
async function chargerTranscription() {
  const c = appelSelectionne();
  if (!c || S.transcription?.call_id === c.call_id) return;
  S.transcription = { call_id: c.call_id, chargement: true, texte: '' };
  rendre();
  try {
    const ligne = await api.transcription(c.call_id);
    S.transcription = { call_id: c.call_id, chargement: false, texte: ligne?.transcript ?? '' };
  } catch (erreur) {
    console.error('transcription', erreur);
    S.transcription = { call_id: c.call_id, chargement: false, texte: '' };
  }
  rendre();
}

// --- Corrections -----------------------------------------------------------------

// Remplace la ligne partout où elle est affichée. Une ligne absente veut dire
// que l'appel vient de sortir du rapport (classé hors prospection) : on l'enlève
// plutôt que de garder à l'écran une version périmée.
function remplacer(callId, ligne) {
  const maj = (liste) => {
    const i = liste.findIndex((c) => c.call_id === callId);
    if (i < 0) return liste;
    if (ligne) {
      liste[i] = ligne;
      return liste;
    }
    liste.splice(i, 1);
    return liste;
  };
  maj(S.appels);
  maj(S.aQualifier);
  S.nombreAQualifier = S.aQualifier.filter((c) => c.needs_review).length;
  if (!ligne && S.sel === callId) S.sel = null;
}

async function corriger(champs) {
  const c = appelSelectionne();
  if (!c) return;
  try {
    const ligne = await api.corriger(c.call_id, champs);
    remplacer(c.call_id, ligne);
    S.historique = ligne ? await api.historique(c.call_id) : [];
    rendre();
    toast(ligne
      ? 'Correction enregistrée — elle prime désormais sur la valeur automatique.'
      : 'Classé hors prospection — l’appel sort du rapport.');
  } catch (erreur) { echec('Enregistrement impossible', erreur); }
}

async function qualifier(callId, champs) {
  try {
    remplacer(callId, await api.corriger(callId, champs));
    rendre();
  } catch (erreur) { echec('Enregistrement impossible', erreur); }
}

async function basculerMembre(userId) {
  const membre = (S.admin.membres || []).find((u) => u.id === userId);
  if (!membre) return;
  try {
    await api.activerMembre(userId, !membre.active);
    membre.active = !membre.active;
    toast(membre.active
      ? `${membre.display_name} réactivé·e — accès rétabli.`
      : `${membre.display_name} désactivé·e — accès coupé immédiatement.`);
    rendre();
  } catch (erreur) { echec('Modification impossible', erreur); }
}

// --- Actions -----------------------------------------------------------------------

async function agir(action, bouton) {
  const id = bouton?.dataset.id;
  const appel = id ? (S.appels.find((c) => c.call_id === id) || S.aQualifier.find((c) => c.call_id === id)) : null;

  switch (action) {
    case 'lien': {
      const email = (document.getElementById('em')?.value || '').trim().toLowerCase();
      S.email = email;
      if (!email.endsWith('@cabinet-ekinox.fr')) {
        S.erreurConnexion = "Cette adresse n'est pas une adresse du cabinet.";
        rendre();
        return;
      }
      try {
        await api.envoyerLienConnexion(email);
        S.erreurConnexion = '';
        S.etapeConnexion = 'envoye';
      } catch (erreur) {
        // Supabase ne dit pas si l'adresse existe — et c'est voulu.
        S.erreurConnexion = "Envoi impossible. Si cette adresse n'a pas été invitée, demandez l'accès à Adrien.";
        console.error(erreur);
      }
      rendre();
      return;
    }
    case 'google':
      try {
        await api.connexionGoogle();
      } catch (erreur) { echec('Connexion Google impossible', erreur); }
      return;
    case 'retour':
      S.etapeConnexion = 'adresse';
      S.erreurConnexion = '';
      rendre();
      return;
    case 'mfa-inscrire': {
      const code = (document.getElementById('code')?.value || '').trim();
      try {
        await api.verifierFacteur(S.mfa.id, code);
        await demarrerSession();
      } catch (erreur) {
        S.erreurConnexion = 'Code refusé. Vérifiez l’heure de votre téléphone et réessayez.';
        console.error(erreur);
        rendre();
      }
      return;
    }
    case 'mfa-verifier': {
      const code = (document.getElementById('code')?.value || '').trim();
      try {
        const liste = await api.facteurs();
        await api.verifierFacteur(liste[0].id, code);
        await demarrerSession();
      } catch (erreur) {
        S.erreurConnexion = 'Code refusé. Réessayez avec le code affiché en ce moment.';
        console.error(erreur);
        rendre();
      }
      return;
    }
    case 'deconnexion':
      await api.deconnexion();
      location.hash = '';
      S.phase = 'connexion';
      S.etapeConnexion = 'adresse';
      S.erreurConnexion = '';
      S.moi = null;
      rendre();
      return;

    case 'fermerFiche':
      S.sel = null;
      rendre();
      return;
    case 'autres':
      S.montrerAutres = !S.montrerAutres;
      rendre();
      return;
    case 'fermerModale':
      modale(null);
      return;
    case 'recharger':
      await charger();
      return;

    case 'rec': {
      if (!appel?.record_link) return;
      modale(`<h2>Enregistrement · ${esc(appel.company_name || appel.contact_name || 'appel')}</h2>
        <p>${esc(dateFR(appel.day, true))} · ${esc(appel.user_name || '')}. L'audio n'est jamais copié dans cette application : il s'ouvre chez Ringover, avec votre propre compte, et l'écoute est journalisée.</p>
        <div class="fin"><button class="btn" data-act="fermerModale">Annuler</button>
        <button class="btn primary" data-act="ouvrirEnregistrement" data-id="${esc(appel.call_id)}">Ouvrir chez Ringover</button></div>`);
      brancherModale();
      return;
    }
    case 'ouvrirEnregistrement': {
      modale(null);
      if (!appel?.record_link) return;
      api.journaliserUsage(appel.call_id, 'listen');
      window.open(appel.record_link, '_blank', 'noopener');
      return;
    }
    case 'jcontact':
      if (appel?.jarvi_profile_id) {
        window.open(`https://app.jarvi.tech/#/crm/profiles/${encodeURIComponent(appel.jarvi_profile_id)}`, '_blank', 'noopener');
      }
      return;
    case 'jcompany':
      if (appel?.jarvi_company_id) {
        window.open(`https://app.jarvi.tech/#/crm/companies/${encodeURIComponent(appel.jarvi_company_id)}`, '_blank', 'noopener');
      }
      return;

    case 'reverifier': {
      if (!appel) return;
      toast('Recherche du numéro dans Jarvi…');
      try {
        const maj = await api.reverifierJarvi([appel.call_id]);
        const trouve = maj.filter((m) => m.kind === 'prospection').length;
        toast(trouve
          ? `Trouvé dans Jarvi : ${maj[0].company_name || maj[0].contact_name || 'contact'} — classé prospection.`
          : 'Toujours absent de Jarvi.');
        await charger();
      } catch (erreur) { echec('Revérification impossible', erreur); }
      return;
    }
    case 'reverifierTout': {
      const inconnus = S.aQualifier.filter((c) => c.kind_eff === 'inconnu').map((c) => c.call_id);
      if (!inconnus.length) return;
      toast(`Recherche de ${inconnus.length} numéros dans Jarvi…`);
      try {
        const maj = await api.reverifierJarvi(inconnus.slice(0, 25));
        const trouves = maj.filter((m) => m.kind === 'prospection').length;
        toast(trouves
          ? `${trouves} numéro${trouves > 1 ? 's' : ''} trouvé${trouves > 1 ? 's' : ''} dans Jarvi.`
          : 'Aucun de ces numéros n’est dans Jarvi.');
        await charger();
      } catch (erreur) { echec('Revérification impossible', erreur); }
      return;
    }

    case 'enregistrer': {
      const c = appelSelectionne();
      if (!c) return;
      const resume = document.getElementById('resume')?.value ?? '';
      const etape = document.getElementById('etape')?.value ?? '';
      const champs = {};
      if (resume !== (c.summary || '')) champs.summary = resume || null;
      if (etape !== (c.next_step || '')) champs.next_step = etape || null;
      if (!Object.keys(champs).length) {
        toast('Rien à enregistrer.');
        return;
      }
      await corriger(champs);
      return;
    }

    case 'qvalider': {
      if (!appel) return;
      const note = (S.notes[appel.call_id] || '').trim();
      try {
        await api.corriger(appel.call_id, {
          kind_manual: appel.kind_manual || appel.kind_eff,
          outcome_manual: appel.outcome_manual || appel.outcome_eff,
          needs_review: false,
        });
        if (note) await api.journaliserUsage(appel.call_id, 'note', note.slice(0, 300));
        delete S.notes[appel.call_id];
        toast('Qualifié — l’appel sort de la file.');
        await charger();
      } catch (erreur) { echec('Validation impossible', erreur); }
      return;
    }
    case 'qplustard':
      if (!appel) return;
      // Rien n'est écrit : l'appel reste à qualifier et reviendra demain. On le
      // met simplement de côté pour la fin de cette session.
      S.reportes.add(appel.call_id);
      S.aQualifier = S.aQualifier.filter((c) => c.call_id !== appel.call_id);
      S.nombreAQualifier = S.aQualifier.length;
      rendre();
      return;

    case 'export':
      exporter();
      return;

    case 'inviter': {
      const champ = document.getElementById('invite');
      const email = (champ?.value || '').trim().toLowerCase();
      if (!email.endsWith('@cabinet-ekinox.fr')) {
        toast('Seules les adresses @cabinet-ekinox.fr peuvent être invitées.');
        return;
      }
      try {
        await api.inviter(email, email.split('@')[0]);
        toast(`Invitation envoyée à ${email}.`);
        await charger();
      } catch (erreur) { echec('Invitation impossible', erreur); }
      return;
    }
    case 'reconcilier': {
      const incomplet = Object.values(S.completude).find((d) => d.complete === false);
      const cible = incomplet?.day || ajouterJours(S.aujourdhui, -1);
      toast('Réconciliation lancée…');
      try {
        const bilan = await api.relancerReconciliation(cible);
        toast(`Réconciliation du ${dateFR(cible, true)} : ${bilan.ajoutes} appel(s) rattrapé(s), journée ${bilan.complete ? 'complète' : 'toujours incomplète'}.`);
        await charger();
      } catch (erreur) { echec('Réconciliation impossible', erreur); }
      return;
    }
    case 'rattraper': {
      toast('Rattrapage en cours — cela peut prendre une minute…');
      try {
        const bilan = await api.rattraper(5);
        toast(`${bilan.jours} journées relues · ${bilan.ajoutes} appel(s) rattrapé(s) · ${bilan.classes} classé(s) dans Jarvi.`);
        await charger();
      } catch (erreur) { echec('Rattrapage impossible', erreur); }
      return;
    }
    case 'reintegrer': {
      if (!id) return;
      try {
        const fait = await api.reintegrer(id);
        toast(fait
          ? 'Appel remis dans le rapport — il repasse par la file « À qualifier ».'
          : 'Cet appel n’était plus écarté.');
        await charger();
      } catch (erreur) { echec('Remise impossible', erreur); }
      return;
    }
    case 'testerWebhook':
      try {
        const sante = await api.santeCollecte();
        S.admin.sante = sante;
        rendre();
        toast(sante.dernier_evenement
          ? `Dernier événement reçu le ${dateFR(sante.dernier_evenement.slice(0, 10), true)}.`
          : 'Aucun événement reçu pour l’instant.');
      } catch (erreur) { echec('Test impossible', erreur); }
      return;
    case 'effacer': {
      const numero = (document.getElementById('effacer')?.value || '').trim();
      if (!numero) {
        toast('Indiquez un numéro complet.');
        return;
      }
      modale(`<h2>Effacer ${esc(numero)} ?</h2>
        <p>Tous les appels, notes et corrections liés à ce numéro seront supprimés définitivement. L'opération est journalisée et ne peut pas être annulée.</p>
        <div class="fin"><button class="btn" data-act="fermerModale">Annuler</button>
        <button class="btn grave" data-act="effacerConfirme">Effacer définitivement</button></div>`);
      brancherModale();
      return;
    }
    case 'effacerConfirme': {
      const numero = (document.getElementById('effacer')?.value || '').trim();
      modale(null);
      try {
        const compte = await api.effacerNumero(numero);
        toast(`${compte.appels_supprimes} appel(s) effacé(s).`);
        await charger();
      } catch (erreur) { echec('Effacement impossible', erreur); }
      return;
    }
    default:
  }
}

function brancherModale() {
  zoneModale.querySelectorAll('[data-act]').forEach((n) => n.addEventListener('click', (e) => {
    e.preventDefault();
    agir(e.currentTarget.dataset.act, e.currentTarget);
  }));
}

// --- Export ---------------------------------------------------------------------

function exporter() {
  const appels = S.appels.filter((c) => c.kind_eff === 'prospection');
  if (!appels.length) {
    toast('Rien à exporter sur cette période.');
    return;
  }
  const texte = versCSV(appels, (c) => c.user_name || '');
  const { du, au } = periode();
  const nom = du === au ? `recap-${du}.csv` : `recap-${du}_${au}.csv`;
  const lien = document.createElement('a');
  lien.href = URL.createObjectURL(new Blob([texte], { type: 'text/csv;charset=utf-8' }));
  lien.download = nom;
  lien.click();
  setTimeout(() => URL.revokeObjectURL(lien.href), 5000);
  api.journaliserUsage(appels[0].call_id, 'export', `${du}→${au} · ${appels.length} appels`);
  toast(`${appels.length} appels exportés dans ${nom}.`);
}

// --- Démarrage ------------------------------------------------------------------

async function demarrerSession() {
  const s = await api.session();
  if (!s) {
    S.phase = 'connexion';
    rendre();
    return;
  }

  let profil = null;
  try {
    profil = await api.monProfil();
  } catch (erreur) {
    console.error(erreur);
  }
  if (!profil) {
    S.phase = 'refus';
    S.message = "Cette adresse n'est pas invitée, ou l'accès a été retiré. Demandez l'accès à Adrien.";
    rendre();
    return;
  }
  if (!profil.active) {
    S.phase = 'refus';
    S.message = 'Cet accès a été désactivé. Contactez Adrien.';
    rendre();
    return;
  }
  S.moi = profil;
  S.email = profil.email;

  // Un administrateur sans second facteur vérifié n'est pas administrateur pour
  // la base : `is_admin()` répond faux, et l'écran d'administration serait vide
  // sans que rien ne l'explique. On règle la question avant d'entrer.
  if (profil.role === 'admin') {
    const niveau = await api.niveauAuthentification();
    if (niveau.actuel !== 'aal2') {
      const liste = await api.facteurs();
      const verifie = liste.filter((f) => f.status === 'verified');
      S.phase = 'connexion';
      S.erreurConnexion = '';
      if (verifie.length) {
        S.etapeConnexion = 'mfa';
      } else {
        S.mfa = await api.inscrireFacteur();
        S.etapeConnexion = 'mfa-inscription';
      }
      rendre();
      return;
    }
  }

  S.phase = 'pret';
  lireAdresse();
  if (!location.hash) history.replaceState(null, '', `#${S.vue}`);
  await charger();
}

window.addEventListener('hashchange', () => {
  if (S.phase !== 'pret') return;
  const vue = location.hash.slice(1).split('?')[0];
  if (VUES.includes(vue) && vue !== S.vue) {
    lireAdresse();
    aller(vue);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (zoneModale.classList.contains('open')) {
    modale(null);
    return;
  }
  if (S.sel) {
    S.sel = null;
    rendre();
  }
});

zoneModale.addEventListener('click', (e) => {
  if (e.target === zoneModale) modale(null);
});

async function demarrer() {
  if (!globalThis.supabase?.createClient) {
    racine.innerHTML = `<main class="plein"><p class="eyebrow">Cabinet Ekinox</p><h1 class="serif">Récap prospection</h1>
      <p class="chapeau">Une partie de l'application n'a pas pu être chargée. Rechargez la page ; si le problème persiste, prévenez Adrien.</p></main>`;
    return;
  }
  api.surChangementSession((evenement) => {
    if (evenement === 'SIGNED_OUT') {
      S.phase = 'connexion';
      S.moi = null;
      rendre();
    }
  });
  try {
    await demarrerSession();
  } catch (erreur) {
    console.error(erreur);
    S.phase = 'connexion';
    S.erreurConnexion = 'La connexion au serveur a échoué. Réessayez dans un instant.';
    rendre();
  }
  // Le lien magique dépose un code dans l'adresse : une fois la session ouverte,
  // il n'a plus rien à y faire (rien de nominatif dans les URL, SPECS §7.1).
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
}

rendre();
demarrer();

// Rendu : des fonctions pures qui prennent l'état et renvoient du HTML.
// Aucun accès réseau, aucune modification d'état — ce qui rend chaque écran
// relisible seul, et permet de changer la mise en forme sans toucher à la
// logique. Les valeurs calculées (hauteurs de barres, largeurs de segments)
// voyagent en attributs `data-` : la politique de sécurité du contenu interdit
// les styles en ligne, `app.js` les pose après le rendu.

import {
  cap, clefSituation, dateFR, duree, dureeCourte, ecart, entonnoir, esc, estConversation,
  texteResume,
  etatAppel, ETIQUETTES, heureFR, initiales, joursSemaine, LIBELLE_GENRE, LIBELLE_ISSUE,
  lundiDe, numeroMasque, numeroSemaine, ORDRE_SITUATIONS, pourcent, SITUATIONS,
} from './format.js';

export const ICON = {
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"></path></svg>',
  jour: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2"></rect><path d="M3 9h18M8 2v4M16 2v4"></path></svg>',
  semaine: '<svg viewBox="0 0 24 24"><path d="M4 19V9M10 19V5M16 19v-8M22 19H2"></path></svg>',
  qualifier: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v4l3 2"></path></svg>',
  equipe: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"></circle><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"></path><circle cx="17.5" cy="9" r="2.5"></circle><path d="M16 14.5c3 .2 5.5 2.3 5.5 5.5"></path></svg>',
  admin: '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"></path></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"></path></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"></path></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M5 3l14 9-14 9z"></path></svg>',
};

const ACT = {
  rec: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M10 8l6 4-6 4z"></path></svg>',
  person: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"></circle><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"></path></svg>',
  building: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="1"></rect><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3"></path></svg>',
};

const GOOGLE = '<svg viewBox="0 0 24 24" class="g"><path d="M21.6 12.2c0-.7-.1-1.3-.2-1.9H12v3.7h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z" fill="#4285F4"/><path d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" fill="#34A853"/><path d="M6.4 14a6 6 0 0 1 0-3.9V7.5H3.1a10 10 0 0 0 0 9z" fill="#FBBC05"/><path d="M12 6c1.5 0 2.8.5 3.8 1.5l2.8-2.8A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.8 9.4 6 12 6z" fill="#EA4335"/></svg>';

// --- Fragments partagés ------------------------------------------------------

export function qui(c) {
  const nom = c.user_name || 'inconnu';
  return `<span class="who"><span class="av xs">${esc(initiales(nom))}</span>${esc(nom)}</span>`;
}

// Les trois mêmes boutons partout (SPECS §7.4.7). Grisés plutôt que masqués :
// leur absence poserait la question « où est passé le bouton ? », leur grisage
// répond « il n'y a rien à ouvrir ».
export function actions(c, grand) {
  const b = (a, icone, libelle, inactif, titre) =>
    `<button class="act${grand ? ' btn sm' : ''}" data-act="${a}" data-id="${esc(c.call_id)}"` +
    `${inactif ? ' disabled' : ''} title="${titre}" aria-label="${titre}">${icone}${grand ? libelle : ''}</button>`;
  return `<span class="acts">${
    b('rec', ACT.rec, 'Enregistrement', !c.record_link, 'Écouter l’enregistrement chez Ringover')
  }${
    b('jcontact', ACT.person, 'Contact', !c.jarvi_profile_id, 'Fiche Jarvi du contact')
  }${
    b('jcompany', ACT.building, 'Société', !c.jarvi_company_id, 'Fiche Jarvi de la société')
  }</span>`;
}

export function pastilleSituation(c) {
  let clef = c.situation;
  if (!clef && c.needs_review) clef = 'aq';
  // Sans transcription, il n'y a rien à faire qu'attendre ; avec
  // transcription mais sans résumé, c'est la routine qui est en retard.
  if (!clef && estConversation(c)) clef = c.a_transcription === false ? 'attente' : 'nosum';
  if (!clef) return '';
  const [libelle, classe] = SITUATIONS[clef] || ETIQUETTES[clef];
  return `<span class="pill ${classe}">${esc(libelle)}</span>`;
}

const titreAppel = (c) => c.company_name || c.contact_name || numeroMasque(c.external_number);

function etiquetteEtat(c) {
  if (c.needs_review) return ['À qualifier', 'warn'];
  if (c.situation) return [SITUATIONS[c.situation][0], SITUATIONS[c.situation][1]];
  if (c.outcome_eff === 'tentative') {
    return [c.status === 'voicemail' ? 'Messagerie' : 'Non décroché', 'neu'];
  }
  const classes = { court: 'warn', bache: 'crit', conversation: 'neu', rdv: 'good' };
  return [LIBELLE_ISSUE[c.outcome_eff] || '—', classes[c.outcome_eff] || 'neu'];
}

// --- Connexion ---------------------------------------------------------------

export function vueConnexion(S) {
  let etapes;
  if (S.etapeConnexion === 'envoye') {
    etapes = `<div class="pill good bloc">Lien envoyé à <b>${esc(S.email)}</b>. Ouvrez-le depuis votre boîte mail, sur cet appareil de préférence (valable une heure).</div>
      <button class="btn lg" data-act="retour">Changer d'adresse</button>`;
  } else if (S.etapeConnexion === 'mfa-inscription') {
    etapes = `<div class="field"><label>Double authentification (obligatoire pour les administrateurs)</label>
        <div class="qrbox">${S.mfa?.qr ? `<img src="${esc(S.mfa.qr)}" alt="Code à scanner dans votre application d'authentification">` : ''}</div>
        <span class="aide">Scannez ce code dans votre application d'authentification (Google Authenticator, 1Password, iCloud…), puis saisissez les six chiffres affichés.</span></div>
      <div class="field"><label for="code">Code à six chiffres</label><input id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>
      ${S.erreurConnexion ? `<div class="pill crit bloc">${esc(S.erreurConnexion)}</div>` : ''}
      <button class="btn primary lg" data-act="mfa-inscrire">Terminer l'inscription</button>
      <button class="btn lg" data-act="deconnexion">Se déconnecter</button>`;
  } else if (S.etapeConnexion === 'mfa') {
    etapes = `<div class="field"><label for="code">Code d'authentification</label>
        <input id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
        <span class="aide">Depuis votre application d'authentification. Obligatoire pour les administrateurs.</span></div>
      ${S.erreurConnexion ? `<div class="pill crit bloc">${esc(S.erreurConnexion)}</div>` : ''}
      <button class="btn primary lg" data-act="mfa-verifier">Se connecter</button>
      <button class="btn lg" data-act="deconnexion">Se déconnecter</button>`;
  } else {
    etapes = `<div class="field"><label for="em">Adresse e-mail</label><input id="em" type="email" value="${esc(S.email)}" autocomplete="email" placeholder="prenom@cabinet-ekinox.fr"></div>
      <button class="btn primary lg" data-act="lien">Recevoir un lien de connexion</button>
      <div class="sep"><i></i>ou<i></i></div>
      <button class="btn lg" data-act="google">${GOOGLE}Continuer avec Google Workspace</button>
      ${S.erreurConnexion ? `<div class="pill crit bloc">${esc(S.erreurConnexion)}</div>` : ''}
      <div class="aide">Pas de mot de passe : le lien reçu par e-mail vaut connexion. Une adresse non invitée ne peut pas créer de compte.</div>`;
  }
  return `<div class="login"><div class="side"><div class="serif">Récap<br>prospection</div>
      <div class="notes"><span>Accès réservé à l'équipe du Cabinet Ekinox.</span><span>Chaque connexion est journalisée. Données hébergées à Paris.</span></div></div>
    <div class="form"><div><h1>Connexion</h1><p class="chapeau">Utilisez votre adresse professionnelle.</p></div>${etapes}</div></div>`;
}

export function vueRefus(message) {
  return `<main class="plein"><p class="eyebrow">Cabinet Ekinox · application privée</p>
    <h1 class="serif">Accès refusé</h1>
    <p class="chapeau">${esc(message)}</p>
    <button class="btn" data-act="deconnexion">Revenir à la connexion</button></main>`;
}

// --- Charpente ----------------------------------------------------------------

export function coquille(S, corps, version) {
  const nq = S.nombreAQualifier || 0;
  const pages = [['jour', 'Jour'], ['semaine', 'Semaine'], ['qualifier', 'À qualifier'],
    ['equipe', 'Collaborateurs'], ['admin', 'Administration']]
    .filter(([v]) => v !== 'admin' || S.moi?.role === 'admin');
  const lien = ([v, l], court) => `<a href="#${v}"${S.vue === v ? ' aria-current="page"' : ''}>${ICON[v]}${
    court && l === 'Collaborateurs' ? 'Équipe' : l
  }${v === 'qualifier' && nq ? `<span class="badge">${nq}</span>` : ''}</a>`;
  const nom = S.moi?.display_name || '';
  return `<div class="shell">
    <aside class="rail">
      <div class="brand"><div class="serif">Récap prospection</div><small>Cabinet Ekinox</small></div>
      <nav class="nav">${pages.map((p) => lien(p, false)).join('')}</nav>
      <div class="me"><span class="av">${esc(initiales(nom))}</span><div class="me-txt">
        <div class="me-nom">${esc(nom)}</div>
        <div class="me-role">${S.moi?.role === 'admin' ? 'admin' : 'membre'} · <a href="#" data-act="deconnexion">déconnexion</a></div>
      </div></div>
    </aside>
    <main class="main">${corps}
      <div class="foot"><span>Récap prospection ${esc(version)}</span><span>Hébergé à Paris · accès sur invitation</span></div>
    </main>
    <nav class="tabs">${pages.filter(([v]) => v !== 'admin').map((p) => lien(p, true)).join('')}</nav>
  </div>`;
}

// --- Jour ----------------------------------------------------------------------

const COLONNES = [
  ['chaud', 'Rendez-vous & clients', 'good', ['rdv', 'client']],
  ['ouvert', 'Décideur ouvert', 'acc', ['ouvert']],
  ['porte', 'Porte d’entrée & relance', 'acc', ['porte', 'relance']],
  ['refus', 'Refus · pas de besoin', 'crit', ['direct', 'besoin', 'bache']],
  ['aq', 'À qualifier', 'warn', ['nosum']],
];

export function vueJour(S) {
  const plage = S.mode === 'plage';
  const appels = S.appels;
  const f = entonnoir(appels);
  const aq = appels.filter((c) => c.needs_review);
  const conversations = appels.filter(estConversation);
  const autres = appels.filter((c) => !estConversation(c));
  const st = S.completude[S.jour] || {};

  let etat;
  if (plage) {
    const incompletes = S.jours.filter((j) => S.completude[j]?.complete === false).length;
    etat = incompletes
      ? `<span class="pill crit">${incompletes} journée${incompletes > 1 ? 's' : ''} incomplète${incompletes > 1 ? 's' : ''}</span>`
      : `<span class="pill good">${ICON.check}${S.jours.length} journées contrôlées</span>`;
  } else if (st.complete === true) {
    etat = `<span class="pill good">${ICON.check}Journée complète · ${st.api_count} appels Ringover</span>`;
  } else if (st.complete === false) {
    etat = `<span class="pill crit">Incomplète · ${st.webhook_count} / ${st.api_count} appels reçus</span>`;
  } else {
    etat = `<span class="pill warn">En cours · ${appels.length} appels reçus</span>`;
  }

  const semaine = joursSemaine(lundiDe(S.jour));
  const barreJours = `<div class="daybar">
    <button class="btn sm" data-sem="-1" aria-label="semaine précédente">${ICON.left}</button>
    <span class="cap">S${numeroSemaine(S.jour)}</span>
    ${semaine.map((j) => {
      const d = new Date(`${j}T12:00:00`);
      const futur = j > S.aujourdhui;
      const c = S.completude[j];
      const point = c ? `<i class="dot ${c.complete === true ? 'ok' : c.complete === false ? 'ko' : 'wip'}"></i>` : '';
      return `<button class="daychip" data-jour="${j}" aria-pressed="${j === S.jour && !plage}"${futur ? ' disabled' : ''}>
        <span>${['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'][d.getDay()]}.</span><b class="num">${d.getDate()}</b>${point}</button>`;
    }).join('')}
    <button class="btn sm" data-sem="1" aria-label="semaine suivante"${lundiDe(S.jour) >= lundiDe(S.aujourdhui) ? ' disabled' : ''}>${ICON.right}</button>
    <button class="btn sm" data-jour="${S.aujourdhui}">Aujourd'hui</button>
    <button class="btn sm apart" data-mode="plage">Plage de dates</button></div>`;

  const barrePlage = `<div class="rangebar">
    <label>Du <input type="date" id="du" value="${S.du}" max="${S.aujourdhui}"></label>
    <label>au <input type="date" id="au" value="${S.au}" max="${S.aujourdhui}"></label>
    <button class="btn sm" data-preset="semaine">Cette semaine</button>
    <button class="btn sm" data-preset="derniere">Semaine dernière</button>
    <button class="btn sm" data-preset="mois">30 jours</button>
    <button class="btn sm" data-mode="jour">Retour au jour</button></div>`;

  const choixQui = `<select id="whoSel" aria-label="collaborateur"><option value="tous"${S.qui === 'tous' ? ' selected' : ''}>Toute l'équipe</option>${
    S.collaborateurs.map((u) => `<option value="${esc(u.ringover_user_id)}"${S.qui === u.ringover_user_id ? ' selected' : ''}>${esc(u.display_name)}</option>`).join('')
  }</select>`;

  const titre = plage ? `${cap(dateFR(S.du, true))} → ${dateFR(S.au, true)}` : cap(dateFR(S.jour));

  // --- état des lieux ---
  const comptes = {};
  for (const c of conversations) {
    const k = clefSituation(c);
    comptes[k] = (comptes[k] || 0) + 1;
  }
  const puces = ORDRE_SITUATIONS.filter((k) => comptes[k]).map((k) => {
    const [libelle, classe] = SITUATIONS[k] || ETIQUETTES[k];
    return `<button class="schip" data-sfiltre="${k}" aria-pressed="${S.sfiltre === k}"><i class="sdot ${classe}"></i>${esc(libelle)}<b class="num">${comptes[k]}</b></button>`;
  }).join('') + (aq.length
    ? `<button class="schip" data-sfiltre="aq" aria-pressed="${S.sfiltre === 'aq'}"><i class="sdot warn"></i>À qualifier<b class="num">${aq.length}</b></button>`
    : '');

  const societesRdv = appels.filter((c) => c.outcome_eff === 'rdv').map((c) => c.company_name).filter(Boolean);
  const stat = (l, v, s, hi) => `<div class="stat${hi ? ' hi' : ''}"><span class="v num">${v}</span><span class="l">${l}</span>${s ? `<span class="s">${esc(s)}</span>` : ''}</div>`;
  const apercu = `<div class="glance card">
    <div class="stats">${stat('appels passés', f.tentatives, 'sortants')}<span class="arrow">→</span>${
      stat('personnes eues', f.eue, pourcent(f.eue, f.tentatives))}<span class="arrow">→</span>${
      stat('vraies conversations', f.conversations, pourcent(f.conversations, f.eue))}<span class="arrow">→</span>${
      stat('rendez-vous', f.rdv, societesRdv.slice(0, 2).join(', ') || '—', true)}</div>
    <div class="sbar" aria-hidden="true">
      <i class="sans" data-flex="${Math.max(0, f.tentatives - f.eue)}"></i>
      <i class="courts" data-flex="${Math.max(0, f.eue - f.conversations)}"></i>
      <i class="conv" data-flex="${Math.max(0, f.conversations - f.rdv)}"></i>
      <i class="rdv" data-flex="${f.rdv}"></i></div>
    <div class="schips"><span class="cap">Situations</span>${puces || '<span class="rien">aucune conversation</span>'}</div>
  </div>`;

  // --- échanges ---
  let liste = conversations;
  if (S.sfiltre && S.sfiltre !== 'aq') liste = conversations.filter((c) => clefSituation(c) === S.sfiltre);
  const dateSi = (c) => (plage ? `${dateFR(c.day, true)} · ` : '');

  const carte = (c) => `<article class="kc${S.sel === c.call_id ? ' sel' : ''}">
    <button class="kcbtn" data-sel="${esc(c.call_id)}">
      <span class="kct">${esc(c.company_name || 'Société inconnue')}</span>
      <span class="kcs">${esc(c.contact_name || 'contact inconnu')}${c.contact_role ? ` · ${esc(c.contact_role)}` : ''}</span>
      ${/* La colonne dit déjà « Rendez-vous » ou « Décideur ouvert » : répéter
            l'étiquette juste en dessous n'apprend rien et alourdit la carte. */
        ['rdv', 'ouvert'].includes(c.situation) ? '' : `<span class="kcpill">${pastilleSituation(c)}</span>`}
      <span class="kcsum">${esc(texteResume(c))}</span>
      ${c.next_step ? `<span class="kcnx">→ ${esc(c.next_step)}</span>` : ''}</button>
    <span class="kcf">${qui(c)}<span class="num">${dateSi(c)}${heureFR(c.started_at)} · ${dureeCourte(c.duration_s)}</span><span class="acts">${actions(c)}</span></span>
  </article>`;

  const carteAQ = (c) => `<article class="kc aq"><button class="kcbtn" data-sel="${esc(c.call_id)}">
      <span class="kct">${esc(titreAppel(c))}</span>
      <span class="kcs">${c.kind_eff === 'inconnu' ? 'numéro absent de Jarvi' : esc(c.contact_name || '')} · ${esc(etatAppel(c))}</span>
    </button><span class="kcf">${qui(c)}<span class="num">${dateSi(c)}${heureFR(c.started_at)}</span><a class="btn sm fin" href="#qualifier">Qualifier</a></span></article>`;

  const colonnes = COLONNES.map(([id, libelle, classe, clefs]) => {
    let items = [];
    if (!(S.sfiltre === 'aq' && id !== 'aq')) {
      items = liste.filter((c) => clefs.includes(clefSituation(c)))
        .sort((a, b) => clefs.indexOf(clefSituation(a)) - clefs.indexOf(clefSituation(b)))
        .map(carte);
    }
    if (id === 'aq' && (!S.sfiltre || S.sfiltre === 'aq')) items = items.concat(aq.map(carteAQ));
    return `<section class="kcol"><h3 class="kcolh ${classe}"><span>${esc(libelle)}</span><b class="num">${items.length}</b></h3>${
      items.join('') || `<div class="kempty">Aucun${id === 'aq' ? '' : ' échange'} sur la période</div>`}</section>`;
  }).join('');

  const tableauListe = S.sfiltre === 'aq' ? [] : liste;
  const tableau = `<div class="card"><div class="tbl"><table class="xt"><thead><tr>
      <th>Entreprise · contact</th><th>Qui · ${plage ? 'date' : 'heure'}</th><th>Situation</th><th>Résumé</th><th>Étape suivante</th><th><span class="sr">Actions</span></th>
    </tr></thead><tbody>${tableauListe.map((c) => `<tr class="row${S.sel === c.call_id ? ' sel' : ''}" data-sel="${esc(c.call_id)}" tabindex="0">
      <td class="c-company"><b>${esc(c.company_name || '—')}</b><span class="s">${esc(c.contact_name || 'inconnu')}${c.contact_role ? ` · ${esc(c.contact_role)}` : ''}</span></td>
      <td class="nowrap">${esc(c.user_name || '—')}<span class="s num">${dateSi(c)}${heureFR(c.started_at)} · ${dureeCourte(c.duration_s)}</span></td>
      <td>${pastilleSituation(c)}</td>
      <td class="sumcell">${esc(texteResume(c))}</td>
      <td class="nxcell">${esc(c.next_step || '—')}</td>
      <td class="actcell">${actions(c)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Aucune conversation sur la période.</td></tr>'}
    </tbody></table></div>
    <div class="cards">${tableauListe.map((c) => `<div class="ccard${S.sel === c.call_id ? ' sel' : ''}"><button class="ccardbtn" data-sel="${esc(c.call_id)}">
      <span class="t"><span>${esc(c.company_name || '—')}</span>${pastilleSituation(c)}</span>
      <span class="m">${esc(c.contact_name || 'inconnu')} · ${esc(c.user_name || '')} · <span class="num">${heureFR(c.started_at)}</span></span>
      <span class="r">${esc(texteResume(c))}</span>${c.next_step ? `<span class="kcnx">→ ${esc(c.next_step)}</span>` : ''}</button>${actions(c, true)}</div>`).join('')}</div></div>
    ${aq.length && S.sfiltre !== 'aq' ? `<div class="sect mt"><span class="n">${aq.length} appel${aq.length > 1 ? 's' : ''} à qualifier — <a href="#qualifier">ouvrir la file</a></span></div>` : ''}`;

  const groupes = ORDRE_SITUATIONS
    .map((k) => [k, tableauListe.filter((c) => clefSituation(c) === k)])
    .filter(([, arr]) => arr.length);
  const ligne = (c) => `<div class="xrow${S.sel === c.call_id ? ' sel' : ''}"><button class="xmain" data-sel="${esc(c.call_id)}">
      <span class="xc1"><b>${esc(c.company_name || 'Société inconnue')}</b><span class="s">${esc(c.contact_name || 'contact inconnu')}${c.contact_role ? ` · ${esc(c.contact_role)}` : ''}</span></span>
      <span class="xc2">${qui(c)}<span class="num">${dateSi(c)}${heureFR(c.started_at)} · ${dureeCourte(c.duration_s)}</span></span>
      <span class="xc3">${esc(texteResume(c))}</span>
      <span class="xc4">${pastilleSituation(c)}</span></button><span class="xacts">${actions(c)}</span></div>`;
  const vueListe = (groupes.map(([k, arr]) => {
    const [libelle, classe] = SITUATIONS[k] || ETIQUETTES[k];
    return `<section class="xg"><h3 class="xgh"><i class="sdot ${classe}"></i>${esc(libelle)}<span class="n">${arr.length}</span></h3>${arr.map(ligne).join('')}</section>`;
  }).join('') || '<div class="card empty">Aucune conversation sur la période.</div>')
    + (aq.length && S.sfiltre !== 'aq'
      ? `<section class="xg"><h3 class="xgh"><i class="sdot warn"></i>À qualifier<span class="n">${aq.length}</span></h3>${
        aq.map((c) => `<div class="xrow"><button class="xmain" data-sel="${esc(c.call_id)}">
          <span class="xc1"><b>${esc(titreAppel(c))}</b><span class="s">${c.kind_eff === 'inconnu' ? 'numéro absent de Jarvi' : esc(c.contact_name || '')}</span></span>
          <span class="xc2">${qui(c)}<span class="num">${heureFR(c.started_at)}</span></span>
          <span class="xc3 doux">${esc(etatAppel(c))}</span>
          <span class="xc4"><span class="pill warn">À qualifier</span></span></button>
          <span class="xacts"><a class="btn sm" href="#qualifier">Qualifier</a></span></div>`).join('')}</section>`
      : '');

  const echanges = { colonnes: `<div class="kboard">${colonnes}</div>`, tableau, liste: vueListe }[S.xvue];
  const segment = `<span class="seg">${['colonnes', 'tableau', 'liste'].map((v) =>
    `<button data-xvue="${v}" aria-pressed="${S.xvue === v}">${cap(v)}</button>`).join('')}</span>`;

  // --- autres appels ---
  const reste = (S.sfiltre && S.sfiltre !== 'aq') ? [] : autres;
  const htmlAutres = reste.length ? `<div class="card"><div class="tbl calls"><table><thead><tr>
      <th>Entreprise</th><th>Contact</th><th>Qui</th><th>${plage ? 'Date' : 'Heure'}</th><th>Durée</th><th>État</th><th><span class="sr">Actions</span></th>
    </tr></thead><tbody>${reste.map((c) => {
      const [libelle, classe] = etiquetteEtat(c);
      return `<tr class="row${S.sel === c.call_id ? ' sel' : ''}" data-sel="${esc(c.call_id)}" tabindex="0">
        <td><b>${esc(c.company_name || '—')}</b>${c.kind_eff === 'inconnu' ? `<span class="s num">${esc(numeroMasque(c.external_number))}</span>` : ''}</td>
        <td>${esc(c.contact_name || 'inconnu')}<span class="s">${esc(c.contact_role || '')}</span></td>
        <td>${esc(c.user_name || '—')}</td>
        <td class="num nowrap">${plage ? `<span class="s">${dateFR(c.day, true)}</span>` : ''}${heureFR(c.started_at)}</td>
        <td class="num">${c.status === 'answered' ? dureeCourte(c.duration_s) : '—'}</td>
        <td><span class="pill ${classe}">${esc(libelle)}</span></td>
        <td class="actcell">${actions(c)}</td></tr>`;
    }).join('')}</tbody></table></div>
    <div class="cards">${reste.map((c) => {
      const [libelle, classe] = etiquetteEtat(c);
      return `<div class="ccard${S.sel === c.call_id ? ' sel' : ''}"><button class="ccardbtn" data-sel="${esc(c.call_id)}">
        <span class="t"><span>${esc(titreAppel(c))}</span><span class="pill ${classe}">${esc(libelle)}</span></span>
        <span class="m">${esc(c.contact_name || numeroMasque(c.external_number))}</span>
        <span class="m">${esc(c.user_name || '')} · <span class="num">${heureFR(c.started_at)}</span></span></button>${actions(c, true)}</div>`;
    }).join('')}</div></div>` : '<div class="card empty">Aucun autre appel sur la période.</div>';

  return `<div class="head"><div>
      <div class="cap">${plage ? `Plage de dates · ${S.jours.length} jours ouvrés` : `Semaine ${numeroSemaine(S.jour)}`}</div>
      <h1>${esc(titre)}</h1><div class="sub">${etat}</div></div>
    <div class="toolbar">${choixQui}<button class="btn" data-act="export">Exporter</button></div></div>
  ${plage ? barrePlage : barreJours}
  <div class="espace"></div>
  ${apercu}
  <div class="split${S.sel ? '' : ' nosel'}"><section>
    <div class="sect mt"><h2>Échanges</h2><span class="n">${liste.length} conversation${liste.length > 1 ? 's' : ''}${
      S.sfiltre ? ' · filtre actif — <a href="#" data-sfiltre="">tout afficher</a>' : ''}</span><span class="fin">${segment}</span></div>
    ${echanges}
    <div class="sect mt2"><h2>Autres appels</h2><span class="n">${autres.length} · messageries, non décrochés, appels courts</span>
      <button class="btn sm fin" data-act="autres">${S.montrerAutres ? 'Masquer' : 'Afficher'}</button></div>
    ${S.montrerAutres ? htmlAutres : ''}
  </section>${ficheAppel(S)}</div><div class="backdrop${S.sel ? ' open' : ''}" data-act="fermerFiche"></div>`;
}

// --- Fiche appel -----------------------------------------------------------------

const LIBELLE_CHAMP = {
  kind: 'type', outcome: 'issue', situation: 'situation', summary: 'résumé',
  next_step: 'étape suivante', needs_review: 'qualification', jarvi_recheck: 'revérification Jarvi',
  export: 'export', listen: 'écoute',
};

// Repliée par défaut, et chargée seulement à l'ouverture : une transcription
// pèse plusieurs milliers de caractères, et on ne la lit qu'en cas de doute sur
// le résumé. C'est aussi ce qui permet de la garder hors de l'écran du jour.
function transcriptionDepliante(S, c) {
  if (c.a_transcription === false) {
    return `<div class="hist"><span>Transcription en attente — Ringover ne l’a pas encore rendue.</span></div>`;
  }
  const etat = S.transcription;
  let contenu;
  if (!etat || etat.call_id !== c.call_id) {
    contenu = '<p class="doux">Cliquez pour charger la transcription.</p>';
  } else if (etat.chargement) {
    contenu = '<p class="doux">Chargement…</p>';
  } else if (etat.texte) {
    contenu = `<pre class="transcript">${esc(etat.texte)}</pre>`;
  } else {
    contenu = '<p class="doux">Transcription vide ou indisponible.</p>';
  }
  return `<details class="depliant"${S.transcriptionOuverte ? ' open' : ''}>
    <summary>Transcription</summary>${contenu}</details>`;
}

export function ficheAppel(S) {
  const c = S.appels.find((x) => x.call_id === S.sel) || S.aQualifier?.find((x) => x.call_id === S.sel);
  if (!c) return '';
  const bouton = (attribut, valeur, libelle, actif) =>
    `<button class="opt" data-${attribut}="${valeur}" aria-pressed="${actif}">${esc(libelle)}</button>`;
  return `<aside class="card detail${S.sel ? ' open' : ''}">
    <div class="detail-head"><div>
      <div class="cap">Fiche appel · ${dateFR(c.day, true)}</div>
      <div class="serif title">${esc(titreAppel(c))}</div>
      <div class="qui">${esc(c.contact_name || 'contact inconnu')}${c.contact_role ? ` · ${esc(c.contact_role)}` : ''}</div>
    </div><button class="btn sm" data-act="fermerFiche" aria-label="fermer">✕</button></div>
    <div class="links">
      ${c.kind_eff === 'inconnu' ? `<button class="btn sm" data-act="reverifier" data-id="${esc(c.call_id)}">${ICON.refresh}Revérifier dans Jarvi</button>` : ''}
      <button class="btn sm" data-act="rec" data-id="${esc(c.call_id)}"${c.record_link ? '' : ' disabled'}>${ACT.rec}Enregistrement</button>
      <button class="btn sm" data-act="jcontact" data-id="${esc(c.call_id)}"${c.jarvi_profile_id ? '' : ' disabled'}>${ACT.person}Contact Jarvi</button>
      <button class="btn sm" data-act="jcompany" data-id="${esc(c.call_id)}"${c.jarvi_company_id ? '' : ' disabled'}>${ACT.building}Société Jarvi</button>
    </div>
    <div class="grid2">
      <div><div class="cap">Sens</div>${c.direction === 'in' ? 'Entrant' : 'Sortant'}</div>
      <div><div class="cap">Collaborateur</div>${esc(c.user_name || '—')}</div>
      <div><div class="cap">Heure</div><span class="num">${heureFR(c.started_at)}</span></div>
      <div><div class="cap">Durée</div><span class="num">${c.status === 'answered' ? duree(c.duration_s) : esc(etatAppel(c))}</span></div>
      <div><div class="cap">Numéro</div><span class="num">${esc(numeroMasque(c.external_number))}</span></div>
      <div><div class="cap">Source</div>${c.source === 'webhook' ? 'webhook Ringover' : 'API (réconciliation)'}</div>
    </div>
    <div><div class="cap bloc-titre">Type d'appel</div><div class="opts">${
      bouton('genre', 'prospection', LIBELLE_GENRE.prospection, c.kind_eff === 'prospection')
    }${bouton('genre', 'hors_prospection', LIBELLE_GENRE.hors_prospection, c.kind_eff === 'hors_prospection')}</div></div>
    <div><div class="cap bloc-titre">Issue</div><div class="opts">${
      ['tentative', 'bache', 'conversation', 'rdv']
        .map((k) => bouton('issue', k, LIBELLE_ISSUE[k], c.outcome_eff === k)).join('')}</div></div>
    <div><div class="cap bloc-titre">Situation</div><div class="opts">${
      Object.keys(SITUATIONS).map((k) => bouton('situ', k, SITUATIONS[k][0], c.situation === k)).join('')}</div></div>
    <div class="field"><label for="resume">Résumé de l'échange</label><textarea id="resume" placeholder="Rédigé deux fois par jour depuis la transcription Ringover ; corrigez librement.">${esc(c.summary || '')}</textarea></div>
    <div class="field"><label for="etape">Étape suivante</label><input id="etape" value="${esc(c.next_step || '')}" placeholder="Relance, rendez-vous, personne à appeler…"></div>
    ${transcriptionDepliante(S, c)}
    <div class="ligne-actions"><button class="btn primary pleine" data-act="enregistrer">Enregistrer</button></div>
    <div class="hist">${(S.historique || []).map((h) => `<span><span class="num">${heureFR(h.created_at)} ${dateFR(h.created_at.slice(0, 10), true)}</span> · ${
      esc(LIBELLE_CHAMP[h.field] || h.field)}${h.new_value ? ` → ${esc(String(h.new_value).slice(0, 60))}` : ''}</span>`).join('')
      || '<span>Aucune correction pour l’instant.</span>'}</div></aside>`;
}

// --- Semaine ----------------------------------------------------------------------

export function vueSemaine(S) {
  const jours = joursSemaine(S.semaine);
  const f = entonnoir(S.appels);
  const g = entonnoir(S.appelsPrecedents);
  const parJour = jours.map((j) => ({ j, ...entonnoir(S.appels.filter((c) => c.day === j)) }));
  const maxi = Math.max(1, ...parJour.map((x) => x.tentatives));

  const societes = {};
  for (const c of S.appels) {
    if (c.kind_eff === 'prospection' && c.status === 'answered' && c.company_name) {
      societes[c.company_name] = (societes[c.company_name] || 0) + 1;
    }
  }
  const top = Object.entries(societes).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const incompletes = jours.filter((j) => S.completude[j]?.complete === false).length;

  const barres = parJour.map((x) => {
    const d = new Date(`${x.j}T12:00:00`);
    return `<div class="bar${x.j === S.aujourdhui ? ' today' : ''}">
      <div class="tip">${cap(dateFR(x.j))} · ${x.tentatives} tentatives · ${x.eue} personne eue · ${x.conversations} conversations · ${x.rdv} RDV</div>
      <button class="stack" data-allerjour="${x.j}" aria-label="ouvrir ${dateFR(x.j)}">
        <span class="b1" data-h="${Math.max(0, ((x.tentatives - x.eue) / maxi) * 100)}"></span>
        <span class="b2" data-h="${(x.eue / maxi) * 100}"></span></button>
      <span class="lbl">${['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'][d.getDay()]}. ${d.getDate()}</span></div>`;
  }).join('');

  const tuile = (l, v, e, d) => `<div class="card kpi"><span class="cap">${l}</span><span class="v num">${v} <small class="e">${e || ''}</small></span><span class="d">${d}</span></div>`;

  return `<div class="head"><div><div class="cap">Semaine ${numeroSemaine(S.semaine)}</div>
      <h1>${cap(dateFR(jours[0]))} → ${dateFR(jours[4])}</h1>
      <div class="sub">${incompletes
        ? `<span class="pill crit">${incompletes} journée${incompletes > 1 ? 's' : ''} incomplète${incompletes > 1 ? 's' : ''} — chiffres sous-estimés</span>`
        : `<span class="pill good">${ICON.check}Journées contrôlées complètes</span>`}</div></div>
    <div class="toolbar"><span class="seg">
      <button data-semaine="-1" aria-label="semaine précédente">${ICON.left}</button>
      <button data-semaine="0">Cette semaine</button>
      <button data-semaine="1"${S.semaine >= lundiDe(S.aujourdhui) ? ' disabled' : ''} aria-label="semaine suivante">${ICON.right}</button>
    </span><button class="btn" data-act="export">Exporter la semaine</button></div></div>
  <div class="chips"><button class="chip" data-qui="tous" aria-pressed="${S.qui === 'tous'}">Toute l'équipe</button>${
    S.collaborateurs.map((u) => `<button class="chip" data-qui="${esc(u.ringover_user_id)}" aria-pressed="${S.qui === u.ringover_user_id}">${esc(u.display_name)}</button>`).join('')}</div>
  <div class="espace"></div>
  <div class="kpis">${tuile('Tentatives', f.tentatives, ecart(f.tentatives, g.tentatives), 'appels sortants composés')}${
    tuile('Personne eue', f.eue, pourcent(f.eue, f.tentatives), 'décroché')}${
    tuile('Vraies conversations', f.conversations, pourcent(f.conversations, f.eue), 'information exploitable')}${
    tuile('Rendez-vous', f.rdv, ecart(f.rdv, g.rdv), 'pris cette semaine')}</div>
  <div class="split large">
    <section class="card pad"><div class="sect"><h2>Appels de prospection par jour</h2><span class="n">clic sur une barre pour ouvrir la journée</span></div>
      <div class="wk"><div class="bars">${barres}</div>
        <div class="legend"><span><i class="eue"></i>Personne eue</span><span><i class="sans"></i>Sans réponse ou messagerie</span></div></div></section>
    <section class="card pad"><div class="sect"><h2>Entreprises touchées</h2><span class="n">${Object.keys(societes).length}</span></div>
      <table><tbody>${top.map(([n, v]) => `<tr><td class="pl0">${esc(n)}</td><td class="num tr pr0">${v} échange${v > 1 ? 's' : ''}</td></tr>`).join('')
        || '<tr><td class="empty">Aucun échange</td></tr>'}</tbody></table>
      <div class="sect mt"><h2>Rendez-vous</h2></div>
      ${S.appels.filter((c) => c.outcome_eff === 'rdv').map((c) => `<div class="rdvligne"><span><b>${esc(c.company_name || '—')}</b> · ${esc(c.contact_name || '')}</span><span class="quand">${dateFR(c.day, true)} · ${esc(c.user_name || '')}</span></div>`).join('')
        || '<div class="empty pt">Aucun rendez-vous cette semaine</div>'}</section></div>`;
}

// --- À qualifier --------------------------------------------------------------------

export function vueQualifier(S) {
  const file = S.aQualifier.filter((c) => c.needs_review);
  const filtre = S.qfiltre || 'tous';
  const liste = file.filter((c) => filtre === 'tous'
    || (filtre === 'inconnu' ? c.kind_eff === 'inconnu' : c.outcome_eff === 'court'));
  const nInconnus = file.filter((c) => c.kind_eff === 'inconnu').length;
  const nCourts = file.filter((c) => c.outcome_eff === 'court').length;

  if (!file.length) {
    return `<div class="head"><div><h1>À qualifier</h1><div class="sub">Tout est à jour.</div></div></div>
      <div class="card empty">Aucun appel en attente. Les numéros absents de Jarvi et les appels courts arrivent ici tout seuls.</div>`;
  }

  const intro = `<div class="card qintro"><div class="texte">Deux questions par appel, puis <b>Valider</b> : <b>est-ce de la prospection</b> et <b>ce que ça a donné</b>. Un appel arrive ici quand son numéro est absent du CRM Jarvi ou quand il a duré moins d'une minute. Tant qu'il n'est pas tranché, il reste dans le rapport du jour avec l'étiquette « À qualifier ».</div>
    <button class="btn" data-act="reverifierTout"${nInconnus ? '' : ' disabled'}>${ICON.refresh}${
      nInconnus > 1 ? `Revérifier les ${nInconnus} inconnus dans Jarvi` : 'Revérifier l’inconnu dans Jarvi'}</button>
    <div class="chips"><button class="chip" data-qfiltre="tous" aria-pressed="${filtre === 'tous'}">Tous · ${file.length}</button>
      <button class="chip" data-qfiltre="inconnu" aria-pressed="${filtre === 'inconnu'}">Numéro inconnu · ${nInconnus}</button>
      <button class="chip" data-qfiltre="court" aria-pressed="${filtre === 'court'}">Appel court · ${nCourts}</button></div></div>`;

  const pourquoi = (c) => (c.review_reason === 'inconnu'
    ? `<span class="pill warn">Numéro absent de Jarvi${c.jarvi_check_count > 1 ? ' · revérifié' : ''}</span>`
    : `<span class="pill warn">Appel court · ${duree(c.duration_s)}</span>`);
  const pret = (c) => c.kind_eff !== 'inconnu' && c.outcome_eff !== 'court';

  const items = liste.map((c) => `<div class="qitem">
    <div class="qhead"><div>
      <div class="cap">${dateFR(c.day, true)} · ${heureFR(c.started_at)} · ${esc(c.user_name || '—')} · ${c.direction === 'in' ? 'entrant' : 'sortant'}</div>
      <div class="qtitle">${esc(c.company_name || c.contact_name || 'Numéro inconnu')}${c.company_name && c.contact_name ? ` <span class="doux">· ${esc(c.contact_name)}</span>` : ''}</div>
      <div class="qsub num">${esc(numeroMasque(c.external_number))} · ${esc(etatAppel(c))}</div></div>
      <div class="droite">${pourquoi(c)}${c.kind_eff === 'inconnu' ? `<button class="btn sm" data-act="reverifier" data-id="${esc(c.call_id)}">${ICON.refresh}Revérifier dans Jarvi</button>` : ''}${actions(c, true)}</div></div>
    <div class="qgrid">
      <div><div class="qq">1. Est-ce de la prospection ?</div><div class="opts">${
        ['prospection', 'hors_prospection'].map((k) => `<button class="opt" data-qgenre="${k}" data-id="${esc(c.call_id)}" aria-pressed="${c.kind_eff === k}">${LIBELLE_GENRE[k]}</button>`).join('')}</div></div>
      <div><div class="qq">2. Ce que ça a donné</div><div class="opts">${
        [['tentative', 'Répondeur / rien'], ['bache', 'Bâché'], ['conversation', 'Vraie conversation'], ['rdv', 'Rendez-vous']]
          .map(([k, l]) => `<button class="opt" data-qissue="${k}" data-id="${esc(c.call_id)}" aria-pressed="${c.outcome_eff === k}">${l}</button>`).join('')}</div></div></div>
    <div class="qfoot"><input class="qnote" data-qnote="${esc(c.call_id)}" placeholder="Note (facultatif) : décideur, besoin, prochaine étape…" value="${esc(S.notes?.[c.call_id] || '')}">
      <button class="btn primary" data-act="qvalider" data-id="${esc(c.call_id)}"${pret(c) ? '' : ' disabled'} title="${pret(c) ? 'Valider' : 'Répondez aux deux questions'}">Valider</button>
      <button class="btn" data-act="qplustard" data-id="${esc(c.call_id)}">Plus tard</button></div></div>`).join('');

  return `<div class="head"><div><h1>À qualifier</h1>
    <div class="sub">${file.length} appel${file.length > 1 ? 's' : ''} des 7 derniers jours attendent une réponse</div></div></div>
    ${intro}<div class="qlist">${items || '<div class="card empty">Rien dans ce filtre.</div>'}</div>`;
}

// --- Collaborateurs ------------------------------------------------------------------

export function vueEquipe(S) {
  const jours = joursSemaine(S.semaine);
  const lignes = S.collaborateurs.map((u) => {
    const siens = S.appels.filter((c) => c.ringover_user_id === u.ringover_user_id);
    return { u, f: entonnoir(siens), total: siens.length };
  }).sort((a, b) => b.f.tentatives - a.f.tentatives);
  const maxi = Math.max(1, ...lignes.map((r) => r.f.tentatives));

  return `<div class="head"><div><div class="cap">Semaine ${numeroSemaine(S.semaine)}</div><h1>Collaborateurs</h1>
      <div class="sub">Activité de prospection par personne · ${cap(dateFR(jours[0], true))} → ${dateFR(jours[4], true)}</div></div>
    <div class="toolbar"><span class="seg">
      <button data-semaine="-1" aria-label="semaine précédente">${ICON.left}</button>
      <button data-semaine="0">Cette semaine</button>
      <button data-semaine="1"${S.semaine >= lundiDe(S.aujourdhui) ? ' disabled' : ''} aria-label="semaine suivante">${ICON.right}</button></span></div></div>
  <div class="card tbl"><table><thead><tr><th>Collaborateur</th><th>Tentatives</th><th>Personne eue</th><th>Taux</th><th>Conversations</th><th>RDV</th><th>Appels de prospection</th></tr></thead>
    <tbody>${lignes.map((r) => `<tr class="row" data-equipe="${esc(r.u.ringover_user_id)}">
      <td><span class="jaugeligne"><span class="av sm">${esc(initiales(r.u.display_name))}</span><b>${esc(r.u.display_name)}</b></span></td>
      <td class="num"><span class="jaugeligne"><span class="jauge" data-w="${Math.round((r.f.tentatives / maxi) * 90)}"></span>${r.f.tentatives}</span></td>
      <td class="num">${r.f.eue}</td><td class="num">${pourcent(r.f.eue, r.f.tentatives)}</td>
      <td class="num">${r.f.conversations}</td><td class="num"><b>${r.f.rdv}</b></td><td class="num">${r.total}</td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">Aucun appel cette semaine.</td></tr>'}</tbody></table></div>
  <div class="sect mt"><span class="n">Cliquer sur une ligne ouvre la semaine filtrée sur cette personne.</span></div>`;
}

// --- Administration -------------------------------------------------------------------

export function vueAdmin(S) {
  const a = S.admin || {};
  const quand = (iso) => (iso ? `${dateFR(iso.slice(0, 10), true)} à ${heureFR(iso)}` : 'jamais');
  const jourIncomplet = Object.values(S.completude).find((d) => d.complete === false);
  const resumes = a.taches?.resumes;
  const reconcile = a.taches?.reconcile;
  const transcripts = a.taches?.transcripts;
  const invalides = Number(a.sante?.signatures_invalides_7j ?? 0);

  return `<div class="head"><div><h1>Administration</h1>
    <div class="sub">Comptes, lignes Ringover, état de la collecte, données.</div></div></div>
  <div class="admin">
    <section class="card"><h2>Utilisateurs</h2>
      <div class="intro">Aucune inscription libre : un compte n'existe que s'il est invité ici. Désactiver coupe l'accès à la requête suivante.</div>
      <table><thead><tr><th class="pl0">Personne</th><th>Rôle</th><th class="tr pr0">Actif</th></tr></thead>
        <tbody>${(a.membres || []).map((u) => `<tr>
          <td class="pl0"><b>${esc(u.display_name)}</b><span class="s">${esc(u.email)}</span></td>
          <td><select class="mini" data-role="${esc(u.id)}"${u.id === S.moi?.id ? ' disabled' : ''}>
            <option value="member"${u.role === 'member' ? ' selected' : ''}>membre</option>
            <option value="admin"${u.role === 'admin' ? ' selected' : ''}>admin</option></select></td>
          <td class="tr pr0"><button class="switch" role="switch" aria-checked="${u.active}" data-bascule="${esc(u.id)}"${u.id === S.moi?.id ? ' disabled' : ''} aria-label="activer ${esc(u.display_name)}"></button></td></tr>`).join('')}
        </tbody></table>
      <div class="row2"><input id="invite" type="email" placeholder="prenom@cabinet-ekinox.fr"><button class="btn primary" data-act="inviter">Inviter</button></div></section>

    <section class="card"><h2>Lignes Ringover</h2>
      <div class="intro">Le nom affiché pour chaque ligne Ringover. À corriger quand une ligne change de main.</div>
      <table><tbody>${(a.lignes || []).map((l) => `<tr>
        <td class="pl0 num">${esc(l.ringover_user_id)}</td>
        <td class="pr0"><input class="pleine" data-ligne="${esc(l.ringover_user_id)}" value="${esc(l.display_name)}"></td></tr>`).join('')
        || '<tr><td class="empty">Aucune ligne connue pour l’instant.</td></tr>'}</tbody></table></section>

    <section class="card"><h2>État de la collecte</h2>
      <div class="etats">
        <span><span class="led${a.sante?.dernier_evenement ? '' : ' crit'}"></span> Webhook Ringover · dernier événement ${quand(a.sante?.dernier_evenement)}</span>
        <span><span class="led${transcripts ? '' : ' warn'}"></span> Transcriptions Ringover · ${transcripts ? `dernier passage ${quand(transcripts.ran_at)}` : 'jamais exécutées'}${
          a.sansTranscription ? ` · <b>${a.sansTranscription}</b> appel${a.sansTranscription > 1 ? 's' : ''} en attente` : ' · rien en attente'}</span>
        <span><span class="led${reconcile ? '' : ' warn'}"></span> Réconciliation nocturne · ${reconcile ? `dernier passage ${quand(reconcile.ran_at)}` : 'jamais exécutée'}</span>
        <span><span class="led${resumes ? '' : ' warn'}"></span> Résumés et tags · ${resumes ? `dernier passage ${quand(resumes.ran_at)}` : 'jamais exécutés'}</span>
        <span><span class="led${invalides ? ' warn' : ''}"></span> Signatures invalides sur 7 jours : ${invalides}</span>
      </div>
      <div class="row2">
        <button class="btn sm" data-act="reconcilier">${jourIncomplet ? `Relancer la réconciliation du ${dateFR(jourIncomplet.day, true)}` : 'Relancer la réconciliation d’hier'}</button>
        <button class="btn sm" data-act="testerWebhook">Tester la collecte</button>
        <button class="btn sm" data-act="rattraper">Rattraper les 5 derniers jours</button></div>
      <div class="note">Une tâche qui s'arrête ne prévient personne : ces trois dates sont le seul moyen de voir qu'elle tourne encore.</div></section>

    <section class="card"><h2>Données et sécurité</h2>
      <div class="etats">
        <span><span class="led"></span> Conservation : appels 24 mois · événements bruts 90 jours · cache Jarvi 30 jours</span>
        <span><span class="led"></span> Double authentification active sur votre compte</span>
        <span><span class="led"></span> Hébergement Supabase Paris · chiffrement au repos</span></div>
      <div class="row2"><input id="effacer" placeholder="Numéro à effacer (droit RGPD)"><button class="btn sm danger" data-act="effacer">Effacer</button></div>
      <div class="note">L'effacement supprime définitivement tous les appels et corrections liés à ce numéro.</div></section>
  </div>`;
}

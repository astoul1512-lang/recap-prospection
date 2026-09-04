// Mise en forme et vocabulaire — aucune donnée, aucun réseau.
// Tout ce qui touche à l'affichage d'un appel passe par ici, pour qu'un même
// chiffre soit écrit de la même façon partout dans l'application.

export const FR_JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
export const FR_MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

// Échappement systématique. Les noms de société et les résumés viennent de
// Jarvi, de Modjo et de la saisie de l'équipe : jamais insérés tels quels.
export function esc(valeur) {
  return String(valeur ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

// --- Jours -----------------------------------------------------------------
// Les dates manipulées ici sont des jours de Paris au format AAAA-MM-JJ, jamais
// des instants : on les lit à midi pour qu'aucun changement d'heure ne les fasse
// basculer sur la veille.

const midi = (jour) => new Date(`${jour}T12:00:00`);

export function jourISO(date) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const v = Object.fromEntries(p.map((x) => [x.type, x.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

export const aujourdhui = () => jourISO(new Date());

export function ajouterJours(jour, n) {
  const d = midi(jour);
  d.setDate(d.getDate() + n);
  return jourISO(d);
}

export function lundiDe(jour) {
  const d = midi(jour);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return jourISO(d);
}

export function numeroSemaine(jour) {
  const d = midi(jour);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const n = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - n);
  const debut = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil((((t - debut) / 86400000) + 1) / 7);
}

export const joursSemaine = (lundi) => [0, 1, 2, 3, 4].map((i) => ajouterJours(lundi, i));

export function joursOuvres(du, au) {
  const sortie = [];
  let jour = du;
  // Garde-fou : une plage saisie à l'envers ou démesurée ne doit pas boucler.
  for (let i = 0; jour <= au && i < 400; i++) {
    const wd = midi(jour).getDay();
    if (wd >= 1 && wd <= 5) sortie.push(jour);
    jour = ajouterJours(jour, 1);
  }
  return sortie;
}

export function dateFR(jour, court) {
  const d = midi(jour);
  const n = d.getDate() === 1 ? '1er' : d.getDate();
  if (court) return `${FR_JOURS[d.getDay()].slice(0, 3)}. ${n} ${FR_MOIS[d.getMonth()].slice(0, 4)}.`;
  return `${FR_JOURS[d.getDay()]} ${n} ${FR_MOIS[d.getMonth()]}`;
}

// L'heure d'un appel est celle de Paris, pas celle du téléphone qui consulte :
// un membre en déplacement doit lire le même rapport que les autres.
export function heureFR(instantISO) {
  if (!instantISO) return '—';
  const d = new Date(instantISO);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit',
  }).format(d);
}

// --- Durées et proportions --------------------------------------------------

export function duree(s) {
  const n = Number(s) || 0;
  if (n < 60) return `${n} s`;
  const m = Math.floor(n / 60);
  const r = n % 60;
  return r ? `${m} min ${String(r).padStart(2, '0')} s` : `${m} min`;
}

export function dureeCourte(s) {
  const n = Number(s) || 0;
  return n >= 60 ? `${Math.floor(n / 60)} min` : `${n} s`;
}

export const pourcent = (a, b) => (b ? `${Math.round((a / b) * 100)} %` : '—');

export function ecart(a, b) {
  if (!b) return '';
  const d = a - b;
  return `<span class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d} vs S-1</span>`;
}

// --- Numéros ----------------------------------------------------------------

// Rien de nominatif à l'écran ni dans les URL (SPECS §7.1) : un numéro s'affiche
// amputé de ses quatre derniers chiffres. Assez pour reconnaître un appel qu'on
// vient de passer, pas assez pour constituer un fichier.
export function numeroMasque(e164) {
  const brut = String(e164 || '').trim();
  if (!brut || !brut.startsWith('+')) return brut || 'numéro inconnu';
  const chiffres = brut.slice(1);
  if (chiffres.length < 8) return brut;
  if (chiffres.startsWith('33')) {
    const n = chiffres.slice(2);
    return `+33 ${n[0]} ${n.slice(1, 3)} ${n.slice(3, 5)} •• ••`;
  }
  return `+${chiffres.slice(0, chiffres.length - 4)} •• ••`;
}

export const initiales = (nom) => String(nom || '?').trim().slice(0, 2).toUpperCase();

// --- Vocabulaire (SPECS §1.3) -----------------------------------------------

export const SITUATIONS = {
  rdv: ['Rendez-vous pris', 'good'],
  ouvert: ['Décideur ouvert', 'acc'],
  porte: ['Porte d’entrée nommée', 'acc'],
  client: ['Client actif', 'good'],
  direct: ['Recrute en direct', 'crit'],
  besoin: ['Pas de besoin', 'neu'],
  relance: ['Relance à prévoir', 'warn'],
  bache: ['Bâché', 'crit'],
};

// Deux étiquettes qui ressemblent à des situations sans en être : elles disent
// l'état du traitement, pas ce qu'a donné l'appel.
export const ETIQUETTES = {
  aq: ['À qualifier', 'warn'],
  nosum: ['Résumé à compléter', 'warn'],
};

export const ORDRE_SITUATIONS = ['rdv', 'ouvert', 'porte', 'relance', 'client', 'direct', 'besoin', 'bache', 'nosum'];

export const LIBELLE_ISSUE = {
  tentative: 'Tentative',
  court: 'Court · à qualifier',
  bache: 'Bâché',
  conversation: 'Conversation',
  rdv: 'Rendez-vous',
};

export const LIBELLE_GENRE = {
  prospection: 'Prospection',
  hors_prospection: 'Hors prospection',
  inconnu: 'Inconnu',
};

// --- Lecture d'un appel ------------------------------------------------------

export const estConversation = (c) => c.kind_eff === 'prospection' && c.status === 'answered' &&
  (c.duration_s || 0) >= 60;

// La clé de rangement d'une conversation dans les colonnes : sa situation, ou
// « résumé à compléter » tant que personne ni la tâche du soir n'a écrit.
export const clefSituation = (c) => c.situation || 'nosum';

export function etatAppel(c) {
  if (c.status === 'answered') return `appel court ${duree(c.duration_s)}`;
  if (c.status === 'voicemail') return 'messagerie';
  return 'non décroché';
}

// L'entonnoir (SPECS §1.2). Il porte sur les appels du rapport — prospection
// **et** numéros encore inconnus : un numéro qu'on n'a pas su rattacher reste
// un appel qu'on a bel et bien composé. C'est la définition de §1.2 et celle de
// la vue `v_funnel_day` ; les exclure ferait paraître l'effort plus faible
// qu'il n'est, et le taux de décroché plus flatteur.
export function entonnoir(appels) {
  return {
    tentatives: appels.filter((c) => c.direction === 'out').length,
    eue: appels.filter((c) => c.status === 'answered').length,
    conversations: appels.filter((c) => c.outcome_eff === 'conversation' || c.outcome_eff === 'rdv').length,
    rdv: appels.filter((c) => c.outcome_eff === 'rdv').length,
  };
}

// --- Export CSV (SPECS §10.8) ------------------------------------------------

export function versCSV(appels, nomCollaborateur) {
  const colonnes = ['jour', 'heure', 'sens', 'collaborateur', 'entreprise', 'contact', 'fonction',
    'issue', 'situation', 'duree_s', 'resume', 'etape_suivante'];
  const propre = (v) => `"${String(v ?? '').replace(/[\r\n;]+/g, ' ').replace(/"/g, '""')}"`;
  const lignes = appels.map((c) => [
    c.day,
    heureFR(c.started_at),
    c.direction === 'in' ? 'entrant' : 'sortant',
    nomCollaborateur(c),
    c.company_name || '',
    c.contact_name || '',
    c.contact_role || '',
    c.outcome_eff || '',
    c.situation ? SITUATIONS[c.situation][0] : '',
    c.duration_s ?? 0,
    c.summary || '',
    c.next_step || '',
  ].map(propre).join(';'));
  // Le point-virgule et la marque d'ordre des octets sont ce qu'attend Excel en
  // français : sans eux, le fichier s'ouvre en une seule colonne illisible.
  return `﻿${colonnes.join(';')}\n${lignes.join('\n')}`;
}

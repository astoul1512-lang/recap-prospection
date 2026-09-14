import { estEgal, estFaux, estVrai } from "../_shared/verifs.ts";
import {
  actionDemandee,
  emailInvitable,
  motDePasseAleatoire,
  nomAffiche,
  roleValide,
  uuidValide,
} from "./valide.ts";

Deno.test("invitations : seul le domaine du cabinet passe", () => {
  estEgal(emailInvitable("alexandre@cabinet-ekinox.fr"), "alexandre@cabinet-ekinox.fr");
  estEgal(emailInvitable("  Alexandre@Cabinet-Ekinox.FR  "), "alexandre@cabinet-ekinox.fr", "espaces et majuscules");
  estEgal(emailInvitable("quelquun@gmail.com"), null, "domaine extérieur");
  estEgal(emailInvitable("attaquant@cabinet-ekinox.fr.exemple.com"), null, "domaine qui imite le nôtre");
  estEgal(emailInvitable("pas-une-adresse"), null);
  estEgal(emailInvitable(""), null);
  estEgal(emailInvitable(42), null);
});

Deno.test("rôles : rien d'autre que admin ou member", () => {
  estEgal(roleValide("admin"), "admin");
  estEgal(roleValide("member"), "member");
  estEgal(roleValide(undefined), "member", "valeur par défaut");
  estEgal(roleValide(""), "member");
  estEgal(roleValide("superadmin"), null);
  estEgal(roleValide(true), null);
});

Deno.test("nom affiché : déduit de l'adresse quand il manque", () => {
  estEgal(nomAffiche("Alexandre Durand", "a@cabinet-ekinox.fr"), "Alexandre Durand");
  estEgal(nomAffiche(undefined, "alexandre.durand@cabinet-ekinox.fr"), "Alexandre Durand");
  estEgal(nomAffiche("   ", "remy@cabinet-ekinox.fr"), "Remy");
});

Deno.test("identifiants : un uuid mal formé ne doit jamais atteindre la base", () => {
  estEgal(uuidValide("3f2504e0-4f89-11d3-9a0c-0305e82c3301"), "3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  estEgal(uuidValide("3F2504E0-4F89-11D3-9A0C-0305E82C3301"), "3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  estEgal(uuidValide("' or 1=1 --"), null, "tentative d'injection");
  estEgal(uuidValide("123"), null);
  estEgal(uuidValide(null), null);
});

Deno.test("routage : seules les actions prévues existent", () => {
  const base = "https://exemple.functions.supabase.co/admin";
  estEgal(actionDemandee(`${base}/invite`), "invite");
  estEgal(actionDemandee(`${base}/deactivate`), "deactivate");
  estEgal(actionDemandee(`${base}/webhook-test`), "webhook-test");
  estEgal(actionDemandee(`${base}/password`), "password", "mot de passe refait par l'administrateur");
  estEgal(actionDemandee(`${base}/invite/`), "invite", "barre oblique finale tolérée");
  estEgal(actionDemandee(`${base}/erase?x=1`), "erase", "les paramètres n'entrent pas dans le routage");
  estEgal(actionDemandee(base), null, "sans action");
  estEgal(actionDemandee(`${base}/supprimer-tout`), null, "action inventée");
});

// Le mot de passe est recopié à la main depuis un message Slack : sa forme
// compte autant que sa force. Un « l » pris pour un « 1 » et la personne croit
// que l'application est cassée.
Deno.test("mot de passe : lisible, sans caractère qui se confond", () => {
  for (let i = 0; i < 200; i += 1) {
    const m = motDePasseAleatoire();
    estVrai(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/.test(m), `forme inattendue : ${m}`);
    estFaux(/[ilo01]/.test(m), `caractère ambigu dans ${m}`);
  }
});

Deno.test("mot de passe : deux appels ne donnent jamais le même", () => {
  const vus = new Set<string>();
  for (let i = 0; i < 500; i += 1) vus.add(motDePasseAleatoire());
  estEgal(vus.size, 500, "collision : le tirage n'est pas aléatoire");
});

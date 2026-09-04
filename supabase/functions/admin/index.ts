// Fonction d'administration : inviter, activer/désactiver, effacer un numéro,
// tester la collecte. Réservée aux administrateurs passés par la double
// authentification (SPECS §5.6).
//
// La passerelle Supabase vérifie déjà le JWT (verify_jwt = true) : elle garantit
// que l'appelant est connecté, pas qu'il est administrateur. C'est la base qui
// tranche, via is_admin(), avec le jeton de l'appelant — jamais avec la clé
// service role. Une seule définition de « admin », en un seul endroit.

import { log, logErreur } from "../_shared/log.ts";
import { reponse, servir } from "../_shared/http.ts";
import { chargeSansVerification } from "../_shared/signature.ts";
import { versE164 } from "../_shared/phone.ts";
import {
  appelantEstAdmin,
  changerActivation,
  configurationPresente,
  effacerNumero,
  enregistrerInvitation,
  inviterParCourriel,
  santeWebhook,
} from "../_shared/db.ts";
import { actionDemandee, emailInvitable, nomAffiche, roleValide, uuidValide } from "./valide.ts";

const FN = "admin";
const SITE = Deno.env.get("site_url") ?? "https://astoul1512-lang.github.io/recap-prospection/";

async function corps(req: Request): Promise<Record<string, unknown>> {
  try {
    const valeur = await req.json();
    return valeur && typeof valeur === "object" ? valeur as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

servir(async (req: Request): Promise<Response> => {
  const debut = Date.now();
  if (req.method !== "POST") return reponse(405);
  if (!configurationPresente()) {
    logErreur({ fn: FN, etape: "configuration" });
    return reponse(500);
  }

  const action = actionDemandee(req.url);
  if (!action) return reponse(404);

  const autorisation = req.headers.get("Authorization") ?? "";
  if (!autorisation) return reponse(401);
  if (!(await appelantEstAdmin(autorisation))) {
    log({ fn: FN, etape: "refus", action, motif: "pas_admin_ou_sans_mfa" });
    return reponse(403, { erreur: "acces_refuse" });
  }
  const auteur = uuidValide(chargeSansVerification(autorisation)?.sub);
  const donnees = await corps(req);

  try {
    switch (action) {
      case "invite": {
        const email = emailInvitable(donnees.email);
        const role = roleValide(donnees.role);
        if (!email) return reponse(400, { erreur: "email_hors_domaine" });
        if (!role) return reponse(400, { erreur: "role_invalide" });

        // L'ordre compte : le déclencheur en base refuse la création d'un compte
        // dont l'adresse n'est pas déjà inscrite. Inviter avant d'inscrire, c'est
        // envoyer un courriel dont le lien échouera.
        const inscrite = await enregistrerInvitation(email, nomAffiche(donnees.display_name, email), role, auteur);
        if (!inscrite) return reponse(500, { erreur: "inscription_impossible" });

        const envoye = await inviterParCourriel(email, SITE);
        log({ fn: FN, etape: "invite", role, envoye, ms: Date.now() - debut });
        return envoye
          ? reponse(200, { invite: true })
          : reponse(202, { invite: false, note: "adresse_inscrite_courriel_non_envoye" });
      }

      case "activate":
      case "deactivate": {
        const userId = uuidValide(donnees.user_id);
        if (!userId) return reponse(400, { erreur: "user_id_invalide" });
        const actif = action === "activate";
        const lignes = await changerActivation(userId, actif);
        log({ fn: FN, etape: action, lignes, ms: Date.now() - debut });
        return lignes > 0 ? reponse(200, { actif }) : reponse(404, { erreur: "utilisateur_introuvable" });
      }

      case "erase": {
        // Droit à l'effacement : on exige un numéro normalisable, jamais un
        // fragment. Un effacement approximatif effacerait les appels d'autrui.
        const e164 = versE164(donnees.phone);
        if (!e164) return reponse(400, { erreur: "numero_invalide" });
        const compte = await effacerNumero(e164);
        if (!compte) return reponse(500, { erreur: "effacement_impossible" });
        log({ fn: FN, etape: "erase", auteur, ...compte, ms: Date.now() - debut });
        return reponse(200, compte);
      }

      case "webhook-test": {
        const sante = await santeWebhook();
        if (!sante) return reponse(500, { erreur: "etat_indisponible" });
        return reponse(200, sante);
      }
    }
  } catch (erreur) {
    logErreur({
      fn: FN,
      etape: "execution",
      action,
      erreur: erreur instanceof Error ? erreur.message : "inconnue",
    });
    return reponse(500, { erreur: "echec" });
  }

  return reponse(404);
});

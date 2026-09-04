// Vérification de la signature des webhooks Ringover : JWT signé en HS512 avec
// le secret `ringover_webhook`, transmis dans l'en-tête X-Ringover-Webhook-Signature.
//
// Aucune dépendance externe : uniquement Web Crypto, présent dans Deno. Une
// brique de sécurité ne doit pas dépendre d'un paquet tiers qu'on ne relit pas.
// C'est ce contrôle — pas l'anti-rejeu — qui protège réellement le point d'entrée.

const encodeur = new TextEncoder();

export type ControleSignature = {
  valide: boolean;
  alg: string | null;
  charge: Record<string, unknown> | null;
  motif: string | null;
};

function base64urlVersOctets(entree: string): Uint8Array | null {
  try {
    const b64 = entree.replace(/-/g, "+").replace(/_/g, "/");
    const complete = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const binaire = atob(complete);
    const octets = new Uint8Array(binaire.length);
    for (let i = 0; i < binaire.length; i++) octets[i] = binaire.charCodeAt(i);
    return octets;
  } catch {
    return null;
  }
}

function octetsVersBase64url(octets: Uint8Array): string {
  let binaire = "";
  for (const o of octets) binaire += String.fromCharCode(o);
  return btoa(binaire).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decoderJson(partie: string): Record<string, unknown> | null {
  const octets = base64urlVersOctets(partie);
  if (!octets) return null;
  try {
    const valeur = JSON.parse(new TextDecoder().decode(octets));
    return valeur && typeof valeur === "object" ? valeur as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// Comparaison à temps constant : on ne sort jamais de la boucle au premier
// octet différent. Sinon la durée de la réponse permet de deviner la signature
// attendue octet par octet.
function egalTempsConstant(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let ecart = 0;
  for (let i = 0; i < a.length; i++) ecart |= a[i] ^ b[i];
  return ecart === 0;
}

async function cle(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    encodeur.encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
}

export async function verifierJwtHs512(jeton: string, secret: string): Promise<ControleSignature> {
  const vide = { valide: false, alg: null, charge: null };
  if (!jeton || !secret) return { ...vide, motif: "signature_absente" };

  const parties = jeton.trim().replace(/^Bearer\s+/i, "").split(".");
  if (parties.length !== 3) return { ...vide, motif: "format_invalide" };

  const [entete, corps, signature] = parties;
  const enteteJson = decoderJson(entete);
  if (!enteteJson) return { ...vide, motif: "entete_illisible" };

  const alg = typeof enteteJson.alg === "string" ? enteteJson.alg : null;
  const charge = decoderJson(corps);

  // On refuse tout autre algorithme, y compris « none » : accepter l'algorithme
  // annoncé par l'émetteur est la faille classique des vérifications de JWT.
  if (alg !== "HS512") return { valide: false, alg, charge, motif: "algorithme_inattendu" };

  const fournie = base64urlVersOctets(signature);
  if (!fournie) return { valide: false, alg, charge, motif: "signature_illisible" };

  const attendue = new Uint8Array(
    await crypto.subtle.sign("HMAC", await cle(secret), encodeur.encode(`${entete}.${corps}`)),
  );
  if (!egalTempsConstant(fournie, attendue)) {
    return { valide: false, alg, charge, motif: "signature_incorrecte" };
  }
  return { valide: true, alg, charge, motif: null };
}

// Lit la charge d'un JWT SANS vérifier sa signature. À n'utiliser que pour un
// jeton déjà validé en amont (la passerelle Supabase vérifie les JWT des
// fonctions avec verify_jwt = true). Le nom est explicite pour que personne ne
// s'en serve comme d'un contrôle de sécurité.
export function chargeSansVerification(jeton: string): Record<string, unknown> | null {
  const parties = jeton.trim().replace(/^Bearer\s+/i, "").split(".");
  if (parties.length !== 3) return null;
  return decoderJson(parties[1]);
}

// Fabrique un jeton valide. Utilisé uniquement par les tests, jamais en production.
export async function signerJwtHs512(charge: Record<string, unknown>, secret: string): Promise<string> {
  const entete = octetsVersBase64url(encodeur.encode(JSON.stringify({ alg: "HS512", typ: "JWT" })));
  const corps = octetsVersBase64url(encodeur.encode(JSON.stringify(charge)));
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await cle(secret), encodeur.encode(`${entete}.${corps}`)),
  );
  return `${entete}.${corps}.${octetsVersBase64url(signature)}`;
}

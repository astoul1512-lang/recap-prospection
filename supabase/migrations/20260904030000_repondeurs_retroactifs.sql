-- =====================================================================
-- Récap prospection — rattrapage des répondeurs déjà reçus
--
-- La colonne `machine_detection` n'existait pas quand les premiers appels
-- réels sont arrivés : Ringover annonçait bien « répondeur », mais personne
-- n'écoutait. L'information n'est pas perdue pour autant — le journal brut
-- conserve chaque message reçu, et c'est précisément à ça qu'il sert.
--
-- Sans ce rattrapage, la file « À qualifier » s'ouvrirait sur une vingtaine
-- de messageries à trancher à la main, et les chiffres d'avant le déploiement
-- ne seraient pas comparables à ceux d'après : deux règles différentes sur un
-- même tableau, c'est un tableau qu'on ne peut plus lire.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Récupérer la détection depuis le journal brut
-- ---------------------------------------------------------------------
with detection as (
  select call_id,
         max(payload -> 'data' ->> 'answering_machine_detection') as valeur
  from private.webhook_events
  where event = 'hangup'
    and signature_ok
    and call_id is not null
    and payload -> 'data' ->> 'answering_machine_detection' is not null
  group by call_id
)
update public.calls c
   set machine_detection = d.valeur
  from detection d
 where d.call_id = c.call_id
   and c.machine_detection is null;

-- ---------------------------------------------------------------------
-- 2. Appliquer la règle, exactement celle du webhook
--
-- Un répondeur reconnu, sur un appel de moins d'une minute, devient une
-- messagerie : hors de l'entonnoir (SPECS §1.2 exclut les messageries des
-- « personnes eues ») et hors de la file.
--
-- Trois refus explicites, dans l'ordre de gravité :
--  - jamais sur un appel qu'un humain a déjà tranché (`reviewed_at`) ;
--  - jamais sur une issue corrigée à la main (`outcome_manual`) ;
--  - jamais au-delà d'une minute, où une conversation prise pour un
--    répondeur serait une perte sèche.
-- ---------------------------------------------------------------------
update public.calls
   set status = 'voicemail',
       outcome = 'tentative',
       needs_review = false,
       review_reason = null
 where machine_detection = 'MACHINE'
   and status = 'answered'
   and coalesce(duration_s, 0) < 60
   and outcome_manual is null
   and reviewed_at is null;

-- =====================================================================
-- Récap prospection — nouvelle provenance de transcription : l'API Ringover
--
-- Seule dans sa migration, et c'est volontaire : Postgres refuse d'utiliser
-- une valeur d'énumération dans la transaction qui vient de l'ajouter. La
-- migration suivante peut s'en servir, celle-ci ne le pourrait pas.
--
-- Voir docs/decisions.md, D7.
-- =====================================================================

alter type public.transcript_source add value if not exists 'ringover_api';

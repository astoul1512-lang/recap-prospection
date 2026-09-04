-- =====================================================================
-- Récap prospection — accès contrôlé au schéma privé + correctif d'audit
-- Migration additive (la migration initiale n'est jamais modifiée).
--
-- Pourquoi : le schéma `private` n'est pas exposé à l'API REST, et ne doit
-- jamais l'être (SPECS §3.3.8). Les edge functions ne peuvent donc pas y
-- écrire directement. On ouvre exactement quatre portes, nommées, réservées
-- à la clé service role : rien d'autre ne passe.
-- =====================================================================

-- --------------------------------------------------------------------
-- 1. Journal brut des webhooks
-- --------------------------------------------------------------------
create or replace function public.log_webhook_event(
  p_event text,
  p_call_id text,
  p_attempt integer,
  p_signature_ok boolean,
  p_payload jsonb
) returns void
language sql security definer set search_path = public, private as $$
  insert into private.webhook_events (event, call_id, attempt, signature_ok, payload)
  values (coalesce(p_event, 'inconnu'), p_call_id, p_attempt,
          coalesce(p_signature_ok, false), coalesce(p_payload, '{}'::jsonb));
$$;

-- --------------------------------------------------------------------
-- 2. État de santé de la collecte (écran Administration, §7.4)
-- --------------------------------------------------------------------
create or replace function public.webhook_health()
returns table (
  dernier_evenement timestamptz,
  evenements_7j bigint,
  signatures_invalides_7j bigint
)
language sql security definer set search_path = public, private as $$
  select max(received_at),
         count(*) filter (where received_at > now() - interval '7 days'),
         count(*) filter (where received_at > now() - interval '7 days' and not signature_ok)
  from private.webhook_events;
$$;

-- --------------------------------------------------------------------
-- 3. Invitation : inscrire l'adresse AVANT de créer le compte auth,
--    sinon le déclencheur on_auth_user_check la refuse.
-- --------------------------------------------------------------------
create or replace function public.upsert_invitation(
  p_email text,
  p_display_name text,
  p_role text,
  p_invited_by uuid
) returns void
language sql security definer set search_path = public, private as $$
  insert into private.invitations (email, display_name, role, invited_by)
  values (lower(trim(p_email)), p_display_name,
          coalesce(p_role, 'member')::public.app_role, p_invited_by)
  on conflict (email) do update
    set display_name = excluded.display_name,
        role = excluded.role;
$$;

-- --------------------------------------------------------------------
-- 4. Droit à l'effacement (RGPD) : tout ce qui concerne un numéro.
--    Les corrections liées partent en cascade avec les appels.
-- --------------------------------------------------------------------
create or replace function public.erase_phone(p_phone text)
returns table (appels_supprimes integer, cache_supprime integer)
language plpgsql security definer set search_path = public, private as $$
declare
  n_appels integer;
  n_cache integer;
begin
  delete from public.calls where external_number = p_phone;
  get diagnostics n_appels = row_count;
  delete from public.jarvi_cache where phone_e164 = p_phone;
  get diagnostics n_cache = row_count;
  return query select n_appels, n_cache;
end $$;

-- --------------------------------------------------------------------
-- Ces quatre fonctions contournent la RLS : elles ne sont ouvertes qu'à la
-- clé service role, donc uniquement aux edge functions. Par défaut Postgres
-- les rendrait exécutables par tout le monde — d'où les revoke explicites.
-- --------------------------------------------------------------------
revoke all on function public.log_webhook_event(text, text, integer, boolean, jsonb) from public, anon, authenticated;
revoke all on function public.webhook_health() from public, anon, authenticated;
revoke all on function public.upsert_invitation(text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.erase_phone(text) from public, anon, authenticated;

grant execute on function public.log_webhook_event(text, text, integer, boolean, jsonb) to service_role;
grant execute on function public.webhook_health() to service_role;
grant execute on function public.upsert_invitation(text, text, text, uuid) to service_role;
grant execute on function public.erase_phone(text) to service_role;

-- --------------------------------------------------------------------
-- Correctif : la table corrections sert aussi de journal d'usage (export CSV,
-- écoute d'un enregistrement, revérification Jarvi — SPECS §7.3). La migration
-- initiale n'accorde aux membres qu'un droit de lecture : ces journalisations
-- échoueraient silencieusement. On ouvre l'insertion, strictement bornée :
-- chacun ne peut écrire qu'en son nom, et seulement ces trois motifs.
-- --------------------------------------------------------------------
drop policy if exists corrections_member_insert on public.corrections;
create policy corrections_member_insert on public.corrections
  for insert to authenticated
  with check (
    public.is_active_user()
    and author_id = auth.uid()
    and field in ('export', 'listen', 'jarvi_recheck')
  );

-- =====================================================================
-- Récap prospection — écarter un appel se justifie, et se défait
--
-- La colonne `hors_rapport` existe depuis hier. Il lui manquait deux choses
-- pour être honnête : dire **pourquoi**, et pouvoir revenir en arrière.
--
-- Un appel qui disparaît du rapport sans motif, c'est une décision qu'on ne
-- peut pas discuter. Et une décision automatique qu'on ne peut pas défaire,
-- c'est une décision qu'on finit par subir.
-- =====================================================================

alter table public.calls add column if not exists hors_rapport_motif text;

comment on column public.calls.hors_rapport_motif is
  'En une phrase, pourquoi cet appel a été écarté du rapport. Écrit par la '
  'routine en même temps que hors_rapport ; affiché tel quel sur l''écran '
  'd''administration.';

-- ---------------------------------------------------------------------
-- Réintégrer un appel écarté
--
-- Réservé aux administrateurs, comme tout ce qui touche à ce qui est visible
-- par l'équipe. La décision est journalisée dans `corrections` : c'est une
-- correction humaine comme une autre, et elle doit se voir dans l'historique
-- de la fiche appel.
--
-- `needs_review` est remis à vrai : un appel qu'on réintègre n'a plus de tag
-- fiable — celui que la routine avait posé valait pour un appel qu'elle
-- comptait écarter. Autant le reposer à la main.
-- ---------------------------------------------------------------------
create or replace function public.reintegrer_appel(p_call_id text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if not public.is_admin() then
    raise exception 'reserve_admin' using errcode = '42501';
  end if;

  update public.calls
     set hors_rapport = false,
         hors_rapport_motif = null,
         needs_review = true,
         review_reason = 'court',
         reviewed_at = null,
         reviewed_by = null
   where call_id = p_call_id
     and hors_rapport;

  if not found then return false; end if;

  insert into public.corrections (call_id, field, old_value, new_value, author_id)
  values (p_call_id, 'hors_rapport', 'true', 'false', uid);
  return true;
end $$;

revoke all on function public.reintegrer_appel(text) from public, anon;
grant execute on function public.reintegrer_appel(text) to authenticated;

-- ---------------------------------------------------------------------
-- Ce que l'écran d'administration montre
--
-- Une vue plutôt qu'une requête dans le front : c'est la même règle que
-- partout ailleurs, la définition de « écarté » vit à un seul endroit.
-- ---------------------------------------------------------------------
create or replace view public.v_ecartes with (security_invoker = true) as
select c.call_id,
       c.day,
       c.started_at,
       c.duration_s,
       c.direction,
       c.company_name,
       c.contact_name,
       c.hors_rapport_motif,
       c.summary,
       ru.display_name as user_name
from public.calls c
left join public.ringover_users ru on ru.ringover_user_id = c.ringover_user_id
where c.hors_rapport
order by c.started_at desc;

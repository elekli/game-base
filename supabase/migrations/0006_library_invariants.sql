grant app_migrator to postgres;
set local role app_migrator;

alter table app_private.external_game_identities
  add constraint external_game_identities_id_medium_unique unique (id, medium);

alter table app_private.games
  add constraint games_external_identity_medium_fk
  foreign key (external_game_identity_id, medium)
  references app_private.external_game_identities (id, medium);

delete from app_private.source_contributions old_sc
where old_sc.role = 'developer'
  and exists (
    select 1 from app_private.source_contributions preferred_sc
    where preferred_sc.identity_id = old_sc.identity_id
      and preferred_sc.source_contributor_id = old_sc.source_contributor_id
      and preferred_sc.role = 'design'
  );

update app_private.source_contributions
set role = 'design'
where role = 'developer';

insert into app_private.contributors (name, entity_kind, source_provider, source_contributor_id)
select distinct on (i.provider, sc.source_contributor_id) sc.name, sc.entity_kind, i.provider, sc.source_contributor_id
from app_private.source_contributions sc
join app_private.external_game_identities i on i.id = sc.identity_id
order by i.provider, sc.source_contributor_id, sc.id
on conflict (source_provider, source_contributor_id) where source_provider is not null do update
set name = excluded.name, entity_kind = excluded.entity_kind;

update app_private.source_contributions sc
set contributor_id = c.id
from app_private.external_game_identities i
join app_private.contributors c
  on c.source_provider = i.provider
where sc.identity_id = i.id
  and c.source_contributor_id = sc.source_contributor_id
  and sc.contributor_id is null;

alter table app_private.source_contributions
  alter column contributor_id set not null;

alter table app_private.source_contributions
  drop constraint if exists source_contributions_role_check;

alter table app_private.source_contributions
  add constraint source_contributions_role_check
  check (role in ('design', 'art', 'publisher'));

delete from app_private.manual_contributions old_mc
where old_mc.role = 'developer'
  and exists (
    select 1 from app_private.manual_contributions preferred_mc
    where preferred_mc.game_id = old_mc.game_id
      and preferred_mc.contributor_id = old_mc.contributor_id
      and preferred_mc.role = 'design'
  );

update app_private.manual_contributions
set role = 'design'
where role = 'developer';

alter table app_private.manual_contributions
  drop constraint if exists manual_contributions_role_check;

alter table app_private.manual_contributions
  add constraint manual_contributions_role_check
  check (role in ('design', 'art', 'publisher'));

reset role;
revoke app_migrator from postgres;

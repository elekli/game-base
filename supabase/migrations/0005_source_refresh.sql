grant app_migrator to postgres;
set local role app_migrator;

create table if not exists app_private.bgg_current_metrics (
  identity_id uuid primary key references app_private.external_game_identities(id) on delete cascade,
  weight numeric(3, 2) check (weight is null or (weight >= 1 and weight <= 5)),
  strategy_rank integer check (strategy_rank is null or strategy_rank >= 1),
  last_successful_sync_at timestamptz
);

create index if not exists bgg_current_metrics_weight_idx on app_private.bgg_current_metrics (weight);
create index if not exists bgg_current_metrics_rank_idx on app_private.bgg_current_metrics (strategy_rank);

alter table app_private.bgg_current_metrics enable row level security;
drop policy if exists runtime_bgg_current_metrics on app_private.bgg_current_metrics;
create policy runtime_bgg_current_metrics on app_private.bgg_current_metrics for all to app_runtime using (true) with check (true);

reset role;
revoke app_migrator from postgres;

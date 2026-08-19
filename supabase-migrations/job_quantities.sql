-- job_quantities: the current job's raw BuilderTrend takeoff measurements.
--
-- Singleton row (id = 1). Mirrors what previously lived ONLY in the Google
-- Sheet's "2026 CUSTOM PLAN" tab, cells I3:I12 (BUILDING AREA) and I18:I29
-- (QUANTITIES). The extension's "Write to Sheet" action now upserts this
-- row alongside its existing Sheet write (Sheet kept as a mirror/fallback,
-- same pattern the webpage's calc-engine already uses for pricing data).
-- "Write to Estimate" reads this row instead of re-reading the Sheet.
--
-- Field names match ROW_TO_FIELD in the webpage's index.html calc-engine
-- exactly, so quantity_formula text in cost_items (e.g. "=I4+I5") can be
-- evaluated against this row the same way on both the webpage and the
-- extension.
--
-- Security note: RLS below allows the anon key to select/insert/update
-- this table, matching how the rest of this project already treats the
-- anon key as fully public (it's embedded in client-side JS with no
-- additional gate). This table only ever holds ONE job's in-progress
-- measurements at a time — the same scope the Sheet already had. If you
-- want tighter control later, replace the anon policies below with ones
-- scoped to an authenticated Supabase session.

create table if not exists job_quantities (
  id                  integer primary key default 1,
  basement_sf         numeric not null default 0,
  floor1_sf           numeric not null default 0,
  floor2_sf           numeric not null default 0,
  floor3_sf           numeric not null default 0,
  attic_storage_sf    numeric not null default 0,
  habitable_attic_sf  numeric not null default 0,
  front_porch_sf      numeric not null default 0,
  rear_porch_sf       numeric not null default 0,
  rear_deck_sf        numeric not null default 0,
  garage_sf           numeric not null default 0,
  exterior_doors      numeric not null default 0,
  windows             numeric not null default 0,
  baths               numeric not null default 0,
  cabinets_lf         numeric not null default 0,
  countertop_lf       numeric not null default 0,
  staircases          numeric not null default 0,
  porch_columns       numeric not null default 0,
  garage_doors        numeric not null default 0,
  interior_doors      numeric not null default 0,
  carpet_sf           numeric not null default 0,
  hardwood_sf         numeric not null default 0,
  tile_sf             numeric not null default 0,
  updated_at          timestamptz not null default now(),
  constraint job_quantities_singleton check (id = 1)
);

insert into job_quantities (id) values (1)
  on conflict (id) do nothing;

alter table job_quantities enable row level security;

drop policy if exists "job_quantities anon select" on job_quantities;
create policy "job_quantities anon select" on job_quantities
  for select using (true);

drop policy if exists "job_quantities anon insert" on job_quantities;
create policy "job_quantities anon insert" on job_quantities
  for insert with check (true);

drop policy if exists "job_quantities anon update" on job_quantities;
create policy "job_quantities anon update" on job_quantities
  for update using (true) with check (true);

-- The 3 reference houses' raw measurements (Kiawah/Sanibel/Vero — the same
-- I3:I29 values that live in each "2026 MASTER PLAN <HOUSE>" tab). These
-- were never migrated before now: cost_items/house_rates only ever stored
-- each cost item's COMPUTED quantity for a house, not the raw underlying
-- measurements (basement_sf, floor1_sf, etc.) themselves. The webpage's
-- "load a base plan" dropdown needs the raw values to prefill its
-- measurement form — this table is what makes that possible without
-- reading the Sheet.
--
-- Separate from job_quantities on purpose: job_quantities holds real
-- client jobs (sensitive), so it stays authenticated-only. This table
-- holds only the 3 fixed reference houses — same sensitivity as
-- cost_items/house_rates (already anon-readable), safe to read publicly.

create table reference_house_measurements (
  house               text primary key,  -- 'kiawah' | 'sanibel' | 'vero'
  basement_sf         numeric default 0,
  floor1_sf           numeric default 0,
  floor2_sf           numeric default 0,
  floor3_sf           numeric default 0,
  attic_storage_sf    numeric default 0,
  habitable_attic_sf  numeric default 0,
  front_porch_sf      numeric default 0,
  rear_porch_sf       numeric default 0,
  rear_deck_sf        numeric default 0,
  garage_sf           numeric default 0,
  exterior_doors      numeric default 0,
  windows             numeric default 0,
  baths               numeric default 0,
  cabinets_lf         numeric default 0,
  countertop_lf       numeric default 0,
  staircases          numeric default 0,
  porch_columns       numeric default 0,
  garage_doors        numeric default 0,
  interior_doors      numeric default 0,
  carpet_sf           numeric default 0,
  hardwood_sf         numeric default 0,
  tile_sf             numeric default 0,
  updated_at          timestamptz default now()
);

alter table reference_house_measurements enable row level security;

create policy "reference_house_measurements_select_anon" on reference_house_measurements
  for select to anon using (true);

create policy "reference_house_measurements_select_authenticated" on reference_house_measurements
  for select to authenticated using (true);

create policy "reference_house_measurements_upsert_admin" on reference_house_measurements
  for insert to authenticated
  with check (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

create policy "reference_house_measurements_update_admin" on reference_house_measurements
  for update to authenticated
  using (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

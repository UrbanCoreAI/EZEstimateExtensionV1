-- Keel EZ Estimate — Supabase schema
-- Run this whole file in Supabase SQL Editor in one go.
-- Every table gets RLS enabled + explicit policies in the SAME statement block —
-- never a moment where a table exists without RLS on (Gap 1).

-- ─────────────────────────────────────────────────────────────
-- 0. rate_admins — created first because cost_items/house_rates/
--    site_options/job_quantities policies below reference it via
--    "exists (select 1 from rate_admins ...)". Policies for this
--    table itself stay down in section 5, in their original spot.
-- ─────────────────────────────────────────────────────────────
create table rate_admins (
  id         serial primary key,
  email      text unique not null,
  added_by   text,
  added_at   timestamptz default now()
);

alter table rate_admins enable row level security;

-- ─────────────────────────────────────────────────────────────
-- 1. cost_items — the 74 line items, one row each
-- ─────────────────────────────────────────────────────────────
create table cost_items (
  id                serial primary key,
  section           text not null,
  sort_order        integer not null,
  cost_code         text,
  item_name         text not null unique, -- required for the migration script's upsert (Gap 5)
  calc_basis        text not null,        -- plain-English "priced per" description (Sheet column C)
  quantity_formula  text not null,        -- e.g. "floor1_sf+floor2_sf+floor3_sf", "fixed", or a single field name
  is_fixed          boolean not null default false  -- true = quantity is always 1
);

alter table cost_items enable row level security;

-- Anyone signed in (via Supabase Auth) can read the rate list — needed so both
-- the extension and the webpage can compute estimates. True anonymous (no
-- session at all) is denied — matches Gap 1's anon-key-must-be-rejected test.
create policy "cost_items_select_authenticated" on cost_items
  for select to authenticated using (true);

-- Only users listed in rate_admins can write.
create policy "cost_items_insert_admin" on cost_items
  for insert to authenticated
  with check (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

create policy "cost_items_update_admin" on cost_items
  for update to authenticated
  using (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

create policy "cost_items_delete_admin" on cost_items
  for delete to authenticated
  using (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

-- ─────────────────────────────────────────────────────────────
-- 2. house_rates — one row per (cost item × reference house)
-- ─────────────────────────────────────────────────────────────
create table house_rates (
  id             serial primary key,
  cost_item_id   integer not null references cost_items(id) on delete cascade,
  house          text not null check (house in ('kiawah','sanibel','vero')),
  amount         numeric not null,
  quantity       numeric not null,
  unique (cost_item_id, house)   -- required for the migration script's upsert (Gap 5)
);

alter table house_rates enable row level security;

create policy "house_rates_select_authenticated" on house_rates
  for select to authenticated using (true);

create policy "house_rates_insert_admin" on house_rates
  for insert to authenticated
  with check (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

create policy "house_rates_update_admin" on house_rates
  for update to authenticated
  using (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

create policy "house_rates_delete_admin" on house_rates
  for delete to authenticated
  using (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

-- ─────────────────────────────────────────────────────────────
-- 3. site_options — the 18 upgrade choices
-- ─────────────────────────────────────────────────────────────
create table site_options (
  id            serial primary key,
  category      text not null,
  option_label  text not null,
  cost          numeric not null,
  sort_order    integer not null,
  notes         text,
  unique (category, option_label)   -- required for the migration script's upsert (Gap 5)
);

alter table site_options enable row level security;

create policy "site_options_select_authenticated" on site_options
  for select to authenticated using (true);

create policy "site_options_insert_admin" on site_options
  for insert to authenticated
  with check (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

create policy "site_options_update_admin" on site_options
  for update to authenticated
  using (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

create policy "site_options_delete_admin" on site_options
  for delete to authenticated
  using (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

-- ─────────────────────────────────────────────────────────────
-- 4. job_quantities — one row per in-progress estimate
--    (replaces the extension writing into sheet cells I3:I29,
--     plus sales_notes replacing the "SALES NOTES" tab)
-- ─────────────────────────────────────────────────────────────
create table job_quantities (
  id                  serial primary key,
  job_label           text,
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
  exterior_doors      integer default 0,
  windows             integer default 0,
  baths               numeric default 0,
  cabinets_lf         numeric default 0,
  countertop_lf       numeric default 0,
  staircases          integer default 0,
  porch_columns       integer default 0,
  garage_doors        integer default 0,
  interior_doors      integer default 0,
  carpet_sf           numeric default 0,
  hardwood_sf         numeric default 0,
  tile_sf             numeric default 0,
  sales_notes         text default '',
  created_by          text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

alter table job_quantities enable row level security;

-- Job quantities are per-user working data, not shared rate config —
-- any authenticated user can read/write their own; admins can read all.
create policy "job_quantities_select_own_or_admin" on job_quantities
  for select to authenticated
  using (created_by = auth.jwt() ->> 'email'
         or exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

create policy "job_quantities_insert_own" on job_quantities
  for insert to authenticated
  with check (created_by = auth.jwt() ->> 'email');

create policy "job_quantities_update_own_or_admin" on job_quantities
  for update to authenticated
  using (created_by = auth.jwt() ->> 'email'
         or exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'))
  with check (created_by = auth.jwt() ->> 'email'
         or exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

create policy "job_quantities_delete_own_or_admin" on job_quantities
  for delete to authenticated
  using (created_by = auth.jwt() ->> 'email'
         or exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

-- ─────────────────────────────────────────────────────────────
-- 5. rate_admins policies — table itself created up in section 0
-- ─────────────────────────────────────────────────────────────
-- Any signed-in user can check the admin list (needed so the webpage can
-- decide whether to show edit controls at all), but only existing admins
-- can add/remove admins. The very FIRST admin has to be seeded via the
-- migration script using the service_role key (which bypasses RLS) —
-- there's no other way to bootstrap the first row.
create policy "rate_admins_select_authenticated" on rate_admins
  for select to authenticated using (true);

create policy "rate_admins_insert_admin" on rate_admins
  for insert to authenticated
  with check (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

create policy "rate_admins_update_admin" on rate_admins
  for update to authenticated
  using (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

create policy "rate_admins_delete_admin" on rate_admins
  for delete to authenticated
  using (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

-- ─────────────────────────────────────────────────────────────
-- 6. change_log — audit trail, immutable (no update/delete policy at all)
-- ─────────────────────────────────────────────────────────────
create table change_log (
  id          serial primary key,
  changed_by  text not null,
  changed_at  timestamptz default now(),
  item_label  text not null,
  field       text,       -- e.g. "amount", "quantity", "quantity_formula"
  old_value   text,
  new_value   text
);

alter table change_log enable row level security;

create policy "change_log_select_admin" on change_log
  for select to authenticated
  using (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

create policy "change_log_insert_admin" on change_log
  for insert to authenticated
  with check (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

-- No update/delete policy on change_log at all — RLS with zero policies for
-- an operation means that operation is denied outright. The log is immutable
-- by design; even admins cannot edit or delete past entries through the API.

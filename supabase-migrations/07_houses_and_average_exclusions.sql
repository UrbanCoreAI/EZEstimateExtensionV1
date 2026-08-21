-- Adds a real "houses" table so base plans (Kiawah, Sanibel, Vero, and any
-- future ones) are data, not hardcoded strings scattered across the admin
-- page and the extension. Also adds house_rates.include_in_average, since
-- the Sheet's Custom Plan tab already has several items whose AVERAGE()
-- formula quietly drops some houses — that behavior needs to live in
-- Supabase now, since this system is moving off the Sheet entirely.
--
-- Run this whole file in the Supabase SQL Editor in one go.

-- ─────────────────────────────────────────────────────────────
-- 1. houses — replaces the hardcoded check (house in ('kiawah',...))
--    constraint on house_rates. Adding a new base plan going forward is
--    an insert into this table (the admin page gets a small "+ Add Base
--    Plan" control for this) — no code change, no Sheet tab needed.
-- ─────────────────────────────────────────────────────────────
create table if not exists houses (
  id         serial primary key,
  key        text not null unique,   -- matches house_rates.house exactly, e.g. 'kiawah'
  label      text not null,          -- display name, e.g. 'Kiawah'
  sort_order integer not null default 0
);

alter table houses enable row level security;

drop policy if exists "houses_select_anon" on houses;
create policy "houses_select_anon" on houses
  for select using (true);

drop policy if exists "houses_insert_admin" on houses;
create policy "houses_insert_admin" on houses
  for insert to authenticated
  with check (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

drop policy if exists "houses_update_admin" on houses;
create policy "houses_update_admin" on houses
  for update to authenticated
  using (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

drop policy if exists "houses_delete_admin" on houses;
create policy "houses_delete_admin" on houses
  for delete to authenticated
  using (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

-- Seed with the 6 base plans that already exist as "2026 MASTER PLAN X"
-- tabs in the Sheet today (Kiawah/Sanibel/Vero from the original migration,
-- plus Sullivan/Bonaire/Catalina which were added later and never made it
-- into house_rates.house's hardcoded constraint below).
insert into houses (key, label, sort_order) values
  ('kiawah',   'Kiawah',   1),
  ('sanibel',  'Sanibel',  2),
  ('vero',     'Vero',     3),
  ('sullivan', 'Sullivan', 4),
  ('bonaire',  'Bonaire',  5),
  ('catalina', 'Catalina', 6)
on conflict (key) do nothing;

-- ─────────────────────────────────────────────────────────────
-- 2. house_rates.house: drop the 3-house-only constraint, point it at
--    the new houses table instead via a foreign key.
-- ─────────────────────────────────────────────────────────────
alter table house_rates drop constraint if exists house_rates_house_check;

alter table house_rates
  add constraint house_rates_house_fkey
  foreign key (house) references houses(key);

-- ─────────────────────────────────────────────────────────────
-- 3. house_rates.include_in_average — per (cost item, house), whether
--    that house's rate counts toward the Custom-Plan-style average unit
--    cost for that item. Defaults to true (average everyone), matching
--    every item except the 9 seeded as false below.
-- ─────────────────────────────────────────────────────────────
alter table house_rates
  add column if not exists include_in_average boolean not null default true;

-- ─────────────────────────────────────────────────────────────
-- 4. One-time backfill matching EXACTLY what the live Sheet's Custom Plan
--    AVERAGE() formulas do today, verified by reading every cost item's
--    actual unit-cost value across all 6 house tabs and checking which
--    subset of houses the Custom Plan value averages to (2026-08-21).
--
--    Every item averages all 6 houses EXCEPT these 9, which only ever
--    averaged Kiawah/Sanibel/Vero — Sullivan/Bonaire/Catalina were added
--    to the Sheet later and these 9 formulas were never updated to
--    include them. Whether that's intentional or an oversight in the
--    Sheet, this preserves today's actual behavior exactly; nothing
--    changes on the day this ships. The values for these 9 items on
--    Sullivan/Bonaire/Catalina also look like placeholder/inconsistent
--    data (e.g. several show the exact same number across houses, or
--    numbers 100-1000x off from Kiawah/Sanibel/Vero's) — worth a look
--    before ever flipping these back on via the admin page's checkboxes.
-- ─────────────────────────────────────────────────────────────
update house_rates
set include_in_average = false
where house in ('sullivan', 'bonaire', 'catalina')
  and cost_item_id in (
    select id from cost_items where item_name in (
      'Concrete Flatwork Turnkey',
      'Appliances Allowance',
      'Cabinets Allowance',
      'Carpets Allowance',
      'Counterop Allowance',
      'Hardwood Allowance',
      'Lighting Fixture Allowance',
      'Plumbing Fixture Allowance',
      'Tile Selection Allowance'
    )
  );

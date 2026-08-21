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
-- 3. house_rates rows for Sullivan/Bonaire/Catalina — these never
--    existed in house_rates at all (only Kiawah/Sanibel/Vero were ever
--    migrated in). Values are each house's own Amount (col E) and
--    Quantity (col D), read directly from their "2026 MASTER PLAN X"
--    Sheet tab on 2026-08-21 — 75 items x 3 houses = 225 rows. This is
--    what makes these houses' actual rates available at all, not just
--    their average-inclusion flag below. Skips any item_name with no
--    match in cost_items (none expected — verify row count is 225 after
--    running: select count(*) from house_rates where house in
--    ('sullivan','bonaire','catalina')).
-- ─────────────────────────────────────────────────────────────
insert into house_rates (cost_item_id, house, amount, quantity)
select v.cost_item_id, v.house, v.amount, v.quantity
from (values
  ((select id from cost_items where item_name = 'Plans'), 'sullivan', 2000, 1),
  ((select id from cost_items where item_name = 'Permits/ Fees'), 'sullivan', 1000, 1),
  ((select id from cost_items where item_name = 'Soil Tests'), 'sullivan', 550, 1),
  ((select id from cost_items where item_name = '3rd Party Inspections'), 'sullivan', 300, 1),
  ((select id from cost_items where item_name = 'Dumpsters'), 'sullivan', 2400, 1),
  ((select id from cost_items where item_name = 'Port or Potty'), 'sullivan', 690, 1),
  ((select id from cost_items where item_name = 'Municipal Tap Fees'), 'sullivan', 0, 1),
  ((select id from cost_items where item_name = 'Utilities'), 'sullivan', 500, 1),
  ((select id from cost_items where item_name = 'Surveying'), 'sullivan', 3275, 1),
  ((select id from cost_items where item_name = 'Lot Clearing/ Site Prep'), 'sullivan', 1125, 1),
  ((select id from cost_items where item_name = 'Backfill/ Grading'), 'sullivan', 2600, 1),
  ((select id from cost_items where item_name = 'Duct Blaster and Blower Door Test'), 'sullivan', 1350, 1),
  ((select id from cost_items where item_name = 'Exterior Paint (Porch Beams, Etc.)'), 'sullivan', 0, 1),
  ((select id from cost_items where item_name = 'Rough Grading'), 'sullivan', 1100, 1),
  ((select id from cost_items where item_name = 'Touch up Clean'), 'sullivan', 165, 1),
  ((select id from cost_items where item_name = 'Final Clean'), 'sullivan', 165, 1),
  ((select id from cost_items where item_name = 'Final Grade'), 'sullivan', 4220, 1),
  ((select id from cost_items where item_name = 'Punch out'), 'sullivan', 800, 1),
  ((select id from cost_items where item_name = 'Job Allocation'), 'sullivan', 18750, 1),
  ((select id from cost_items where item_name = 'Powerwash'), 'sullivan', 265, 1),
  ((select id from cost_items where item_name = 'Misc Cost'), 'sullivan', 1817, 1),
  ((select id from cost_items where item_name = 'Builders Risk Insurance'), 'sullivan', 640, 1),
  ((select id from cost_items where item_name = 'Quality Inspection'), 'sullivan', 275, 1),
  ((select id from cost_items where item_name = 'Framing Material'), 'sullivan', 8680, 1423),
  ((select id from cost_items where item_name = 'Roof Trusses'), 'sullivan', 3813.87, 1423),
  ((select id from cost_items where item_name = 'Framing Labor'), 'sullivan', 7394, 1423),
  ((select id from cost_items where item_name = 'Siding Labor/ Siding Turnkey'), 'sullivan', 11610, 1304),
  ((select id from cost_items where item_name = 'Floor Trusses'), 'sullivan', 0, 1304),
  ((select id from cost_items where item_name = 'HVAC Rough In 50%'), 'sullivan', 5071, 1304),
  ((select id from cost_items where item_name = 'HVAC Trim Out 50%'), 'sullivan', 5071, 1304),
  ((select id from cost_items where item_name = 'Electrical Labor Rough-In (60%)'), 'sullivan', 4567.8, 1304),
  ((select id from cost_items where item_name = 'Electrical Labor Trim Out (40%)'), 'sullivan', 3045.2, 1304),
  ((select id from cost_items where item_name = 'Insulation Walls and Ceilings'), 'sullivan', 1692, 1304),
  ((select id from cost_items where item_name = 'Insulation Blown'), 'sullivan', 1920, 1304),
  ((select id from cost_items where item_name = 'Drywall'), 'sullivan', 7377, 1304),
  ((select id from cost_items where item_name = 'Interior Trim Material'), 'sullivan', 770.23, 1304),
  ((select id from cost_items where item_name = 'Interior Trim Labor'), 'sullivan', 1434.4, 1304),
  ((select id from cost_items where item_name = 'Interior Paint'), 'sullivan', 4107.6, 1304),
  ((select id from cost_items where item_name = 'Rough Cleaning'), 'sullivan', 339.04, 1304),
  ((select id from cost_items where item_name = 'Roofing'), 'sullivan', 6210, 1407),
  ((select id from cost_items where item_name = 'Gutters'), 'sullivan', 810, 1407),
  ((select id from cost_items where item_name = 'Stone/ Gravel'), 'sullivan', 8275, 1304),
  ((select id from cost_items where item_name = 'Footings'), 'sullivan', 8240, 1304),
  ((select id from cost_items where item_name = 'Foundation'), 'sullivan', 14600, 1304),
  ((select id from cost_items where item_name = 'Termite Treatment'), 'sullivan', 156.48, 1304),
  ((select id from cost_items where item_name = 'Insulation Crawlspace'), 'sullivan', 1108, 1304),
  ((select id from cost_items where item_name = 'Concrete Flatwork Turnkey'), 'sullivan', 2500, 1),
  ((select id from cost_items where item_name = 'Interior Stairs'), 'sullivan', 0, 0),
  ((select id from cost_items where item_name = 'Exterior Doors'), 'sullivan', 2182.65, 2),
  ((select id from cost_items where item_name = 'Windows'), 'sullivan', 2637.92, 9),
  ((select id from cost_items where item_name = 'Garage Overhead Doors'), 'sullivan', 0, 0),
  ((select id from cost_items where item_name = 'Plumbing Labor Rough In (60%)'), 'sullivan', 4320, 2),
  ((select id from cost_items where item_name = 'Plumbing Trim Out (40%)'), 'sullivan', 2880, 2),
  ((select id from cost_items where item_name = 'Interior Door'), 'sullivan', 1764.61, 13),
  ((select id from cost_items where item_name = 'Exterior Paint'), 'sullivan', 1900, 3),
  ((select id from cost_items where item_name = 'Porch Columns'), 'sullivan', 1641.83, 3),
  ((select id from cost_items where item_name = 'Decks/ Porches Turnkey'), 'sullivan', 4084, 103),
  ((select id from cost_items where item_name = 'Aluminum Rails'), 'sullivan', 2390, 103),
  ((select id from cost_items where item_name = 'SALES TO EDIT - PERMIT FEES'), 'sullivan', 2200, 1),
  ((select id from cost_items where item_name = 'SALES TO EDIT - LOT COST'), 'sullivan', 0, 1),
  ((select id from cost_items where item_name = 'SALES TO EDIT - MISC.'), 'sullivan', 0, 1),
  ((select id from cost_items where item_name = 'SALES TO EDIT - REALTOR'), 'sullivan', 11200, 1304),
  ((select id from cost_items where item_name = 'Accessories Allowance'), 'sullivan', 2462, 1304),
  ((select id from cost_items where item_name = 'Appliances Allowance'), 'sullivan', 1753, 1),
  ((select id from cost_items where item_name = 'Cabinets Allowance'), 'sullivan', 9362, 34),
  ((select id from cost_items where item_name = 'Carpets Allowance'), 'sullivan', 1350, 557),
  ((select id from cost_items where item_name = 'Counterop Allowance'), 'sullivan', 2880, 29),
  ((select id from cost_items where item_name = 'Hardwood Allowance'), 'sullivan', 4470, 600),
  ((select id from cost_items where item_name = 'Lighting Fixture Allowance'), 'sullivan', 1784, 1304),
  ((select id from cost_items where item_name = 'Plumbing Fixture Allowance'), 'sullivan', 3386, 2),
  ((select id from cost_items where item_name = 'Tile Selection Allowance'), 'sullivan', 6385, 266),
  ((select id from cost_items where item_name = 'Clearing Allowance'), 'sullivan', 3500, 1),
  ((select id from cost_items where item_name = 'Driveway Allowance'), 'sullivan', 4000, 1),
  ((select id from cost_items where item_name = 'Landscaping Allowance'), 'sullivan', 950, 1304),
  ((select id from cost_items where item_name = 'Tap Fees'), 'sullivan', 12236, 1),
  ((select id from cost_items where item_name = 'Plans'), 'bonaire', 2000, 1),
  ((select id from cost_items where item_name = 'Permits/ Fees'), 'bonaire', 1000, 1),
  ((select id from cost_items where item_name = 'Soil Tests'), 'bonaire', 550, 1),
  ((select id from cost_items where item_name = '3rd Party Inspections'), 'bonaire', 300, 1),
  ((select id from cost_items where item_name = 'Dumpsters'), 'bonaire', 2400, 1),
  ((select id from cost_items where item_name = 'Port or Potty'), 'bonaire', 690, 1),
  ((select id from cost_items where item_name = 'Municipal Tap Fees'), 'bonaire', 0, 1),
  ((select id from cost_items where item_name = 'Utilities'), 'bonaire', 500, 1),
  ((select id from cost_items where item_name = 'Surveying'), 'bonaire', 3275, 1),
  ((select id from cost_items where item_name = 'Lot Clearing/ Site Prep'), 'bonaire', 1125, 1),
  ((select id from cost_items where item_name = 'Backfill/ Grading'), 'bonaire', 2600, 1),
  ((select id from cost_items where item_name = 'Duct Blaster and Blower Door Test'), 'bonaire', 1350, 1),
  ((select id from cost_items where item_name = 'Exterior Paint (Porch Beams, Etc.)'), 'bonaire', 0, 1),
  ((select id from cost_items where item_name = 'Rough Grading'), 'bonaire', 1100, 1),
  ((select id from cost_items where item_name = 'Touch up Clean'), 'bonaire', 165, 1),
  ((select id from cost_items where item_name = 'Final Clean'), 'bonaire', 165, 1),
  ((select id from cost_items where item_name = 'Final Grade'), 'bonaire', 4220, 1),
  ((select id from cost_items where item_name = 'Punch out'), 'bonaire', 1200, 1),
  ((select id from cost_items where item_name = 'Job Allocation'), 'bonaire', 21250, 1),
  ((select id from cost_items where item_name = 'Powerwash'), 'bonaire', 350, 1),
  ((select id from cost_items where item_name = 'Misc Cost'), 'bonaire', 2840, 1),
  ((select id from cost_items where item_name = 'Builders Risk Insurance'), 'bonaire', 0, 1),
  ((select id from cost_items where item_name = 'Quality Inspection'), 'bonaire', 275, 1),
  ((select id from cost_items where item_name = 'Framing Material'), 'bonaire', 23705, 3528),
  ((select id from cost_items where item_name = 'Roof Trusses'), 'bonaire', 15981.32, 3528),
  ((select id from cost_items where item_name = 'Framing Labor'), 'bonaire', 20859, 3528),
  ((select id from cost_items where item_name = 'Siding Labor/ Siding Turnkey'), 'bonaire', 29950, 3237),
  ((select id from cost_items where item_name = 'Floor Trusses'), 'bonaire', 11189.95, 2775),
  ((select id from cost_items where item_name = 'HVAC Rough In 50%'), 'bonaire', 9547, 2775),
  ((select id from cost_items where item_name = 'HVAC Trim Out 50%'), 'bonaire', 9547, 2775),
  ((select id from cost_items where item_name = 'Electrical Labor Rough-In (60%)'), 'bonaire', 8276.7, 2775),
  ((select id from cost_items where item_name = 'Electrical Labor Trim Out (40%)'), 'bonaire', 5517.8, 2775),
  ((select id from cost_items where item_name = 'Insulation Walls and Ceilings'), 'bonaire', 4673, 2775),
  ((select id from cost_items where item_name = 'Insulation Blown'), 'bonaire', 2880, 2775),
  ((select id from cost_items where item_name = 'Drywall'), 'bonaire', 18236, 2775),
  ((select id from cost_items where item_name = 'Interior Trim Material'), 'bonaire', 2492.83, 2775),
  ((select id from cost_items where item_name = 'Interior Trim Labor'), 'bonaire', 3830, 2775),
  ((select id from cost_items where item_name = 'Interior Paint'), 'bonaire', 10552.5, 2775),
  ((select id from cost_items where item_name = 'Rough Cleaning'), 'bonaire', 871, 2775),
  ((select id from cost_items where item_name = 'Roofing'), 'bonaire', 16960, 2240),
  ((select id from cost_items where item_name = 'Gutters'), 'bonaire', 1378, 2240),
  ((select id from cost_items where item_name = 'Stone/ Gravel'), 'bonaire', 8275, 1949),
  ((select id from cost_items where item_name = 'Footings'), 'bonaire', 12080, 1949),
  ((select id from cost_items where item_name = 'Foundation'), 'bonaire', 25300, 1949),
  ((select id from cost_items where item_name = 'Termite Treatment'), 'bonaire', 339.72, 1949),
  ((select id from cost_items where item_name = 'Insulation Crawlspace'), 'bonaire', 1774, 1487),
  ((select id from cost_items where item_name = 'Concrete Flatwork Turnkey'), 'bonaire', 8748.25, 462),
  ((select id from cost_items where item_name = 'Interior Stairs'), 'bonaire', 627.52, 1),
  ((select id from cost_items where item_name = 'Exterior Doors'), 'bonaire', 4492.65, 2),
  ((select id from cost_items where item_name = 'Windows'), 'bonaire', 6718.33, 24),
  ((select id from cost_items where item_name = 'Garage Overhead Doors'), 'bonaire', 3100, 21),
  ((select id from cost_items where item_name = 'Plumbing Labor Rough In (60%)'), 'bonaire', 6840, 3),
  ((select id from cost_items where item_name = 'Plumbing Trim Out (40%)'), 'bonaire', 4560, 3),
  ((select id from cost_items where item_name = 'Interior Door'), 'bonaire', 3681.63, 1485),
  ((select id from cost_items where item_name = 'Exterior Paint'), 'bonaire', 2775, 3),
  ((select id from cost_items where item_name = 'Porch Columns'), 'bonaire', 3764.27, 3),
  ((select id from cost_items where item_name = 'Decks/ Porches Turnkey'), 'bonaire', 10459, 291),
  ((select id from cost_items where item_name = 'Aluminum Rails'), 'bonaire', 4360, 135),
  ((select id from cost_items where item_name = 'SALES TO EDIT - PERMIT FEES'), 'bonaire', 2200, 1),
  ((select id from cost_items where item_name = 'SALES TO EDIT - LOT COST'), 'bonaire', 0, 1),
  ((select id from cost_items where item_name = 'SALES TO EDIT - MISC.'), 'bonaire', 1200, 1),
  ((select id from cost_items where item_name = 'SALES TO EDIT - REALTOR'), 'bonaire', 20650, 2775),
  ((select id from cost_items where item_name = 'Accessories Allowance'), 'bonaire', 4753.6, 2775),
  ((select id from cost_items where item_name = 'Appliances Allowance'), 'bonaire', 1753, 1),
  ((select id from cost_items where item_name = 'Cabinets Allowance'), 'bonaire', 12483.28, 40),
  ((select id from cost_items where item_name = 'Carpets Allowance'), 'bonaire', 4104, 1085),
  ((select id from cost_items where item_name = 'Counterop Allowance'), 'bonaire', 3704, 33),
  ((select id from cost_items where item_name = 'Hardwood Allowance'), 'bonaire', 8965, 266),
  ((select id from cost_items where item_name = 'Lighting Fixture Allowance'), 'bonaire', 2874.43, 2775),
  ((select id from cost_items where item_name = 'Plumbing Fixture Allowance'), 'bonaire', 7491.49, 3),
  ((select id from cost_items where item_name = 'Tile Selection Allowance'), 'bonaire', 10657.5, 266),
  ((select id from cost_items where item_name = 'Clearing Allowance'), 'bonaire', 3500, 1),
  ((select id from cost_items where item_name = 'Driveway Allowance'), 'bonaire', 4000, 1),
  ((select id from cost_items where item_name = 'Landscaping Allowance'), 'bonaire', 1800, 1949),
  ((select id from cost_items where item_name = 'Tap Fees'), 'bonaire', 12236, 1),
  ((select id from cost_items where item_name = 'Plans'), 'catalina', 2000, 1),
  ((select id from cost_items where item_name = 'Permits/ Fees'), 'catalina', 1000, 1),
  ((select id from cost_items where item_name = 'Soil Tests'), 'catalina', 550, 1),
  ((select id from cost_items where item_name = '3rd Party Inspections'), 'catalina', 300, 1),
  ((select id from cost_items where item_name = 'Dumpsters'), 'catalina', 2400, 1),
  ((select id from cost_items where item_name = 'Port or Potty'), 'catalina', 690, 1),
  ((select id from cost_items where item_name = 'Municipal Tap Fees'), 'catalina', 0, 1),
  ((select id from cost_items where item_name = 'Utilities'), 'catalina', 500, 1),
  ((select id from cost_items where item_name = 'Surveying'), 'catalina', 3275, 1),
  ((select id from cost_items where item_name = 'Lot Clearing/ Site Prep'), 'catalina', 1125, 1),
  ((select id from cost_items where item_name = 'Backfill/ Grading'), 'catalina', 2600, 1),
  ((select id from cost_items where item_name = 'Duct Blaster and Blower Door Test'), 'catalina', 1350, 1),
  ((select id from cost_items where item_name = 'Exterior Paint (Porch Beams, Etc.)'), 'catalina', 0, 1),
  ((select id from cost_items where item_name = 'Rough Grading'), 'catalina', 1100, 1),
  ((select id from cost_items where item_name = 'Touch up Clean'), 'catalina', 165, 1),
  ((select id from cost_items where item_name = 'Final Clean'), 'catalina', 165, 1),
  ((select id from cost_items where item_name = 'Final Grade'), 'catalina', 4220, 1),
  ((select id from cost_items where item_name = 'Punch out'), 'catalina', 1200, 1),
  ((select id from cost_items where item_name = 'Job Allocation'), 'catalina', 21000, 1),
  ((select id from cost_items where item_name = 'Powerwash'), 'catalina', 265, 1),
  ((select id from cost_items where item_name = 'Misc Cost'), 'catalina', 2216.5, 1),
  ((select id from cost_items where item_name = 'Builders Risk Insurance'), 'catalina', 0, 1),
  ((select id from cost_items where item_name = 'Quality Inspection'), 'catalina', 275, 1),
  ((select id from cost_items where item_name = 'Framing Material'), 'catalina', 18450, 2607),
  ((select id from cost_items where item_name = 'Roof Trusses'), 'catalina', 4190.8, 2607),
  ((select id from cost_items where item_name = 'Framing Labor'), 'catalina', 11781.75, 2607),
  ((select id from cost_items where item_name = 'Siding Labor/ Siding Turnkey'), 'catalina', 16445, 2498),
  ((select id from cost_items where item_name = 'Floor Trusses'), 'catalina', 7163.29, 2103),
  ((select id from cost_items where item_name = 'HVAC Rough In 50%'), 'catalina', 8848, 2103),
  ((select id from cost_items where item_name = 'HVAC Trim Out 50%'), 'catalina', 8848, 2103),
  ((select id from cost_items where item_name = 'Electrical Labor Rough-In (60%)'), 'catalina', 6447.75, 2103),
  ((select id from cost_items where item_name = 'Electrical Labor Trim Out (40%)'), 'catalina', 4298.5, 2103),
  ((select id from cost_items where item_name = 'Insulation Walls and Ceilings'), 'catalina', 3252, 2103),
  ((select id from cost_items where item_name = 'Insulation Blown'), 'catalina', 1530, 2103),
  ((select id from cost_items where item_name = 'Drywall'), 'catalina', 12920, 2103),
  ((select id from cost_items where item_name = 'Interior Trim Material'), 'catalina', 1616.04, 2103),
  ((select id from cost_items where item_name = 'Interior Trim Labor'), 'catalina', 2313.3, 2103),
  ((select id from cost_items where item_name = 'Interior Paint'), 'catalina', 6624.45, 2103),
  ((select id from cost_items where item_name = 'Rough Cleaning'), 'catalina', 546.78, 2103),
  ((select id from cost_items where item_name = 'Roofing'), 'catalina', 7175, 1456),
  ((select id from cost_items where item_name = 'Gutters'), 'catalina', 994, 1456),
  ((select id from cost_items where item_name = 'Stone/ Gravel'), 'catalina', 7775, 1366),
  ((select id from cost_items where item_name = 'Footings'), 'catalina', 8340, 1366),
  ((select id from cost_items where item_name = 'Foundation'), 'catalina', 15090, 1366),
  ((select id from cost_items where item_name = 'Termite Treatment'), 'catalina', 163.92, 1366),
  ((select id from cost_items where item_name = 'Insulation Crawlspace'), 'catalina', 825, 971),
  ((select id from cost_items where item_name = 'Concrete Flatwork Turnkey'), 'catalina', 4536.25, 395),
  ((select id from cost_items where item_name = 'Interior Stairs'), 'catalina', 627.52, 1),
  ((select id from cost_items where item_name = 'Exterior Doors'), 'catalina', 2350.12, 2),
  ((select id from cost_items where item_name = 'Windows'), 'catalina', 5947.55, 19),
  ((select id from cost_items where item_name = 'Garage Overhead Doors'), 'catalina', 3100, 21),
  ((select id from cost_items where item_name = 'Plumbing Labor Rough In (60%)'), 'catalina', 5760, 2.5),
  ((select id from cost_items where item_name = 'Plumbing Trim Out (40%)'), 'catalina', 3840, 2.5),
  ((select id from cost_items where item_name = 'Interior Door'), 'catalina', 2512.22, 21),
  ((select id from cost_items where item_name = 'Exterior Paint'), 'catalina', 1450, 2),
  ((select id from cost_items where item_name = 'Porch Columns'), 'catalina', 1111.22, 2),
  ((select id from cost_items where item_name = 'Decks/ Porches Turnkey'), 'catalina', 8584, 90),
  ((select id from cost_items where item_name = 'Aluminum Rails'), 'catalina', 2500, 90),
  ((select id from cost_items where item_name = 'SALES TO EDIT - PERMIT FEES'), 'catalina', 2200, 1),
  ((select id from cost_items where item_name = 'SALES TO EDIT - LOT COST'), 'catalina', 0, 1),
  ((select id from cost_items where item_name = 'SALES TO EDIT - MISC.'), 'catalina', 860, 1),
  ((select id from cost_items where item_name = 'SALES TO EDIT - REALTOR'), 'catalina', 15050, 2103),
  ((select id from cost_items where item_name = 'Accessories Allowance'), 'catalina', 3818.49, 2103),
  ((select id from cost_items where item_name = 'Appliances Allowance'), 'catalina', 1753, 1),
  ((select id from cost_items where item_name = 'Cabinets Allowance'), 'catalina', 12344.03, 53),
  ((select id from cost_items where item_name = 'Carpets Allowance'), 'catalina', 2700, 895),
  ((select id from cost_items where item_name = 'Counterop Allowance'), 'catalina', 3860, 29),
  ((select id from cost_items where item_name = 'Hardwood Allowance'), 'catalina', 6353.75, 215),
  ((select id from cost_items where item_name = 'Lighting Fixture Allowance'), 'catalina', 2386.94, 2103),
  ((select id from cost_items where item_name = 'Plumbing Fixture Allowance'), 'catalina', 6121.02, 2.5),
  ((select id from cost_items where item_name = 'Tile Selection Allowance'), 'catalina', 7629, 266),
  ((select id from cost_items where item_name = 'Clearing Allowance'), 'catalina', 3500, 1),
  ((select id from cost_items where item_name = 'Driveway Allowance'), 'catalina', 4000, 1),
  ((select id from cost_items where item_name = 'Landscaping Allowance'), 'catalina', 1425, 1366),
  ((select id from cost_items where item_name = 'Tap Fees'), 'catalina', 12236, 1)
) as v(cost_item_id, house, amount, quantity)
where v.cost_item_id is not null
on conflict (cost_item_id, house) do update
  set amount = excluded.amount, quantity = excluded.quantity;

-- ─────────────────────────────────────────────────────────────
-- 4. house_rates.include_in_average — per (cost item, house), whether
--    that house's rate counts toward the Custom-Plan-style average unit
--    cost for that item. Defaults to true (average everyone), matching
--    every item except the 9 seeded as false below.
-- ─────────────────────────────────────────────────────────────
alter table house_rates
  add column if not exists include_in_average boolean not null default true;

-- ─────────────────────────────────────────────────────────────
-- 5. One-time backfill matching EXACTLY what the live Sheet's Custom Plan
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

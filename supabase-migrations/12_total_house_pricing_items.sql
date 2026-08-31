-- Adds the 9 "Total ..." line items from the Base House Pricing section of
-- each house tab (2026 MASTER PLAN <HOUSE>) as real cost_items rows.
--
-- These were never migrated, so Import from Sheet — which only ever
-- UPDATES an existing cost_items row matched by exact name, never creates
-- one — silently skipped these 9 Sheet rows entirely. With no cost_items
-- row, fetchUnitCostsFromSupabase() (extension) has nothing to look up,
-- which is why every item under BuilderTrend's "Base House Pricing"
-- section got no unit cost written on Write to Estimate, and why the
-- admin webpage showed these rows blank instead of their Sheet values.
--
-- admin/index.html's buildRowsForTab() has matching code to read each
-- house tab's unusual two-row layout for these 9 items (name + unit cost
-- together on one row, quantity on the row above) and populate
-- house_rates from it during Import from Sheet.
--
-- Safe to re-run: skips any name that already exists.

insert into cost_items (section, sort_order, item_name, calc_basis, quantity_formula, is_fixed)
select 'Base House Pricing',
       (select coalesce(max(sort_order), 0) from cost_items) + v.rn,
       v.item_name, v.calc_basis, v.quantity_formula, v.is_fixed
from (values
  (1, 'Total Fixed Cost', 'Fixed cost per house (no quantity)', 'sheet_total_row', true),
  (2, 'Total Finished SF & Unfinished (Under Roof)', 'Per sq ft — finished + unfinished, under roof', 'sheet_total_row', false),
  (3, 'Total Finished SF & Unfinished SF (Under Roof Excluding Porches)', 'Per sq ft — finished + unfinished, under roof, excluding porches', 'sheet_total_row', false),
  (4, 'Total Finished SF', 'Per sq ft — finished only', 'sheet_total_row', false),
  (5, 'Total 1st Floor, Garage & Porch SF', 'Per sq ft — 1st floor + garage + porch', 'sheet_total_row', false),
  (6, 'Total 1st Floor Finished, 1st Floor Unfinished & Garage', 'Per sq ft — 1st floor finished + unfinished + garage', 'sheet_total_row', false),
  (7, 'Total Finished 1st Floor SF', 'Per sq ft — 1st floor finished only', 'sheet_total_row', false),
  (8, 'Total Garage SF', 'Per sq ft — garage only', 'sheet_total_row', false),
  (9, 'Total for Decks & Porches', 'Per sq ft — decks + porches', 'sheet_total_row', false)
) as v(rn, item_name, calc_basis, quantity_formula, is_fixed)
where not exists (select 1 from cost_items c where c.item_name = v.item_name);

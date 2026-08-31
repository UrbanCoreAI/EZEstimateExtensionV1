-- Adds the 9 "Total ..." line items from the Base House Pricing section of
-- each house tab (2026 MASTER PLAN <HOUSE>) as real cost_items rows, WITH
-- their cost_code set to their actual Sheet row number.
--
-- cost_code is what the admin webpage's grid view uses as the row number
-- for display alignment (see loadSheetData's itemByRow) — leaving it null
-- (as an earlier version of this migration did) makes every row collide
-- at row 0, which is why only one of the 9 ever appeared, sitting above
-- "BASE HOUSE PRICING" instead of in its real position, and the other 8
-- silently vanished. It's also what admin/index.html's Import-from-Sheet
-- code now reads directly to find each item's row in the Sheet, so this
-- one column drives both places correctly.
--
-- Safe to re-run: inserts any missing row, and (re)sets cost_code on ones
-- that already exist under these names.

insert into cost_items (section, sort_order, cost_code, item_name, calc_basis, quantity_formula, is_fixed)
select 'Base House Pricing',
       (select coalesce(max(sort_order), 0) from cost_items) + v.rn,
       v.cost_code, v.item_name, v.calc_basis, v.quantity_formula, v.is_fixed
from (values
  (1, '26', 'Total Fixed Cost', 'Fixed cost per house (no quantity)', 'sheet_total_row', true),
  (2, '31', 'Total Finished SF & Unfinished (Under Roof)', 'Per sq ft — finished + unfinished, under roof', 'sheet_total_row', false),
  (3, '34', 'Total Finished SF & Unfinished SF (Under Roof Excluding Porches)', 'Per sq ft — finished + unfinished, under roof, excluding porches', 'sheet_total_row', false),
  (4, '48', 'Total Finished SF', 'Per sq ft — finished only', 'sheet_total_row', false),
  (5, '52', 'Total 1st Floor, Garage & Porch SF', 'Per sq ft — 1st floor + garage + porch', 'sheet_total_row', false),
  (6, '58', 'Total 1st Floor Finished, 1st Floor Unfinished & Garage', 'Per sq ft — 1st floor finished + unfinished + garage', 'sheet_total_row', false),
  (7, '61', 'Total Finished 1st Floor SF', 'Per sq ft — 1st floor finished only', 'sheet_total_row', false),
  (8, '64', 'Total Garage SF', 'Per sq ft — garage only', 'sheet_total_row', false),
  (9, '79', 'Total for Decks & Porches', 'Per sq ft — decks + porches', 'sheet_total_row', false)
) as v(rn, cost_code, item_name, calc_basis, quantity_formula, is_fixed)
where not exists (select 1 from cost_items c where c.item_name = v.item_name);

-- In case an earlier run of this file already inserted these 9 rows
-- without a cost_code, backfill it now by name.
update cost_items set cost_code = '26' where item_name = 'Total Fixed Cost';
update cost_items set cost_code = '31' where item_name = 'Total Finished SF & Unfinished (Under Roof)';
update cost_items set cost_code = '34' where item_name = 'Total Finished SF & Unfinished SF (Under Roof Excluding Porches)';
update cost_items set cost_code = '48' where item_name = 'Total Finished SF';
update cost_items set cost_code = '52' where item_name = 'Total 1st Floor, Garage & Porch SF';
update cost_items set cost_code = '58' where item_name = 'Total 1st Floor Finished, 1st Floor Unfinished & Garage';
update cost_items set cost_code = '61' where item_name = 'Total Finished 1st Floor SF';
update cost_items set cost_code = '64' where item_name = 'Total Garage SF';
update cost_items set cost_code = '79' where item_name = 'Total for Decks & Porches';

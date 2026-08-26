-- houses.tab_name: the EXACT sheet tab text for this base plan (e.g.
-- "2026 MASTER PLAN CORONADO"), instead of the admin page reconstructing
-- "2026 MASTER PLAN " + label.toUpperCase() everywhere. That
-- reconstruction hardcoded the year to 2026 — a tab from a future year
-- ("2027 MASTER PLAN X") would never match. Storing the real tab name
-- once, at the point a house is added, makes the lookup correct
-- regardless of year and removes the hardcoded-2026 assumption from
-- every place that reads it (loadHouses' tab switcher, getHouseTabs(),
-- the active-tab-to-house match in loadSheetData()).
--
-- Backfilled for the existing 6 houses using the same "2026 MASTER PLAN
-- <LABEL>" pattern they were always assumed to follow.

alter table houses add column if not exists tab_name text;

update houses set tab_name = '2026 MASTER PLAN ' || upper(label) where tab_name is null;

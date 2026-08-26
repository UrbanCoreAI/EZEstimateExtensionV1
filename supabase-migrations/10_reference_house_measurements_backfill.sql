-- reference_house_measurements only ever had rows for the original 3
-- houses (Kiawah/Sanibel/Vero) — Sullivan, Bonaire, and Catalina were
-- added to houses/house_rates in 07_houses_and_average_exclusions.sql
-- but never backfilled here, so the webpage's "Load Base Plan" dropdown
-- (which reads this table to prefill the measurement form) throws
-- "Reference house ... not found in Supabase" for any of the 3 newer
-- houses. Same class of gap as 07, different table.
--
-- Values pulled directly from each house's own "2026 MASTER PLAN <NAME>"
-- tab in the Sheet (BUILDING AREA LOCATION / QUANTITIES sections, rows
-- 3-29 — the same raw-measurement rows ROW_TO_FIELD maps in index.html
-- and calc-engine.js), same source used for the original 3 houses.

insert into reference_house_measurements (
  house, basement_sf, floor1_sf, floor2_sf, floor3_sf, attic_storage_sf,
  habitable_attic_sf, front_porch_sf, rear_porch_sf, rear_deck_sf, garage_sf,
  exterior_doors, windows, baths, cabinets_lf, countertop_lf, staircases,
  porch_columns, garage_doors, interior_doors, carpet_sf, hardwood_sf, tile_sf
) values
  ('sullivan', 0, 1304, 0,    0, 0, 0, 103, 0,   16, 0,   2, 9,  2,   34, 29, 0, 3, 0, 13, 557,  600,  266),
  ('bonaire',  0, 1487, 1288, 0, 0, 0, 135, 156, 0,  462, 2, 24, 3,   40, 33, 1, 3, 1, 21, 1485, 1085, 266),
  ('catalina', 0, 971,  1132, 0, 0, 0, 90,  0,   19, 395, 2, 19, 2.5, 53, 29, 1, 2, 1, 21, 0,    895,  215)
on conflict (house) do update set
  basement_sf = excluded.basement_sf, floor1_sf = excluded.floor1_sf, floor2_sf = excluded.floor2_sf,
  floor3_sf = excluded.floor3_sf, attic_storage_sf = excluded.attic_storage_sf,
  habitable_attic_sf = excluded.habitable_attic_sf, front_porch_sf = excluded.front_porch_sf,
  rear_porch_sf = excluded.rear_porch_sf, rear_deck_sf = excluded.rear_deck_sf, garage_sf = excluded.garage_sf,
  exterior_doors = excluded.exterior_doors, windows = excluded.windows, baths = excluded.baths,
  cabinets_lf = excluded.cabinets_lf, countertop_lf = excluded.countertop_lf, staircases = excluded.staircases,
  porch_columns = excluded.porch_columns, garage_doors = excluded.garage_doors,
  interior_doors = excluded.interior_doors, carpet_sf = excluded.carpet_sf, hardwood_sf = excluded.hardwood_sf,
  tile_sf = excluded.tile_sf, updated_at = now();

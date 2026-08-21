-- Full formula fidelity: cost_items gains the two other formula columns the
-- Sheet's Custom Plan tab actually has per line item (E = amount formula,
-- F = unit cost formula), so the admin tool can show/edit every column with
-- a pencil, not just quantity_formula (D).
--
-- These are stored as literal Sheet formula text, same convention as
-- quantity_formula — e.g. amount_formula = "=D27*F27",
-- unit_cost_formula = "=AVERAGE('2026 MASTER PLAN KIAWAH'!F27,'2026 MASTER
-- PLAN SANIBEL'!F27,'2026 MASTER PLAN VERO'!F27)". Every real line item
-- follows this exact uniform pattern (confirmed via a full Sheet audit) —
-- the one known deviation (Custom Plan's F47, missing the VERO reference)
-- is a section-SUBTOTAL row, not a tracked cost item, so it's out of scope
-- here and is being left exactly as-is in the Sheet per instruction.

alter table cost_items add column amount_formula text;
alter table cost_items add column unit_cost_formula text;

-- The Sheet's SITE OPTIONS tab also has a Quantity column (0/1 — which
-- option is currently "selected" for a given job) that was never migrated.
-- It's a plain free-entry number in the Sheet (no checkbox/dropdown), so
-- it's represented the same way here.
alter table site_options add column quantity numeric default 0;

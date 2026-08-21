-- Adds the basement grand-total formula as its own stored, editable,
-- sync'd field — Supabase is the real source of truth for this formula
-- text; the Sheet's ADDITIONAL PRICING!B7 cell is just its backup mirror
-- (kept in sync via the existing sync tool, same as everything else).
--
-- Note: unlike cost_items' amount_formula/unit_cost_formula, this formula
-- IS meaningful as a live Sheet formula (references other cells on the
-- same tab: B2-B6) — but the actual calculation used by the webpage/
-- extension still comes from computeBasementLineItems() in code, which
-- already implements the identical logic procedurally and is unaffected.
-- This field exists for fidelity/display/sync, not because the calc
-- engine parses it.

alter table basement_pricing add column total_cost_formula text
  default '=IF(B5>0, B2+(B5*B3), 0) + IF(B6>0, IF(B5=0,B2,0) + B6*(B3+B4), 0)';

update basement_pricing set total_cost_formula = '=IF(B5>0, B2+(B5*B3), 0) + IF(B6>0, IF(B5=0,B2,0) + B6*(B3+B4), 0)' where id = 1;

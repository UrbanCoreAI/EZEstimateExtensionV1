-- allowance_tier_settings: the Good/Better/Best multipliers applied per
-- allowance line item in the Write to Estimate flow.
--
-- Good = 1.0 (baseline, no upgrade note), Better = 1.1, Best = 1.5.
--
-- Applies to two groups of allowances, each with its own independent
-- Good/Better/Best selection (13 dropdowns total) but sharing this single
-- set of multiplier values:
--   Quantity-driven group (multiplier scales the written QUANTITY):
--     Accessories Allowance, Appliance Allowance, Cabinet Allowance,
--     Carpet Allowance, Countertop Allowance, Hardwood Flooring Allowance,
--     Lighting Fixture Allowance, Plumbing Fixture Allowance, Tile Allowance
--   Fixed-price group (multiplier scales the selected site option's DOLLAR
--   amount, on top of whichever option is chosen):
--     Clearing Allowance, Driveway Allowance, Landscaping Allowance, Tap Fees
--
-- Selecting Better/Best also replaces that line's description with
-- "Upgrade: Better" / "Upgrade: Best" (Good writes nothing). Tier
-- selections themselves are never persisted — chosen fresh each run.
--
-- Singleton row (id = 1), same pattern as basement_pricing and
-- client_preview_settings.

create table if not exists allowance_tier_settings (
  id                integer primary key default 1,
  good_multiplier   numeric not null default 1.0,
  better_multiplier numeric not null default 1.1,
  best_multiplier   numeric not null default 1.5,
  updated_at        timestamptz not null default now(),
  constraint allowance_tier_settings_singleton check (id = 1)
);

insert into allowance_tier_settings (id) values (1)
  on conflict (id) do nothing;

alter table allowance_tier_settings enable row level security;

drop policy if exists "allowance_tier_settings anon select" on allowance_tier_settings;
create policy "allowance_tier_settings anon select" on allowance_tier_settings
  for select using (true);

drop policy if exists "allowance_tier_settings authenticated update" on allowance_tier_settings;
create policy "allowance_tier_settings authenticated update" on allowance_tier_settings
  for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Basement pricing redesign — basement is fully split into Finished/Unfinished
-- lines priced by their own dedicated formula (fixed cost + $/SF shell +
-- $/SF finish-out), written as their own BuilderTrend line items under
-- Custom Selection Allowances, instead of silently folding into Framing
-- Material/Roof Trusses/Framing Labor's total-area quantity.
--
-- basement_sf on job_quantities is retired from active use (kept, not
-- dropped, so nothing breaks if something still references the column
-- name) — nothing reads or writes it anymore. Sheet cell I3 is likewise no
-- longer touched by any code path.

alter table job_quantities add column finished_basement_sf numeric default 0;
alter table job_quantities add column unfinished_basement_sf numeric default 0;

-- Single-row table — the 3 constants for the basement pricing formula.
-- Admin-editable via admin/index.html's new "Additional Pricing" tab.
create table basement_pricing (
  id                     integer primary key default 1,
  fixed_cost_per_house   numeric not null default 2500,
  shell_cost_per_sf      numeric not null default 35,
  finish_cost_per_sf     numeric not null default 48.5,
  updated_at             timestamptz default now(),
  constraint basement_pricing_single_row check (id = 1)
);

insert into basement_pricing (id, fixed_cost_per_house, shell_cost_per_sf, finish_cost_per_sf)
values (1, 2500, 35, 48.5);

alter table basement_pricing enable row level security;

create policy "basement_pricing_select_anon" on basement_pricing
  for select to anon using (true);

create policy "basement_pricing_select_authenticated" on basement_pricing
  for select to authenticated using (true);

create policy "basement_pricing_update_admin" on basement_pricing
  for update to authenticated
  using (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from rate_admins ra where ra.email = auth.jwt() ->> 'email'));

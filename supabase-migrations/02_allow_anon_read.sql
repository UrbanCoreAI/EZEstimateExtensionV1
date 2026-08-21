-- Adds read-only anon access to the three rate tables so the public
-- webpage and the extension (neither of which signs into Supabase Auth —
-- they use Google OAuth for the Sheet and the anon key for Supabase) can
-- compute an estimate from Supabase directly.
--
-- Scope, deliberately narrow: SELECT only, on cost_items/house_rates/
-- site_options only. Every insert/update/delete policy stays
-- authenticated-only, unchanged — this does not open up writes, and does
-- not touch job_quantities, rate_admins, or change_log (those keep
-- requiring a real signed-in session).

create policy "cost_items_select_anon" on cost_items
  for select to anon using (true);

create policy "house_rates_select_anon" on house_rates
  for select to anon using (true);

create policy "site_options_select_anon" on site_options
  for select to anon using (true);

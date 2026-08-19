-- client_preview_settings: the multipliers used to build the low/high price
-- range shown in the Client Preview proposal text (e.g. "$X - $Y"), pulled
-- out of hardcoded 0.99 / 1.10 literals that were duplicated in both
-- popup.js (runClientPreviewFlow) and tabpicker.js (selectTabForClientPreview).
--
-- Singleton row (id = 1), same pattern as basement_pricing.
--
-- Security note: matches the existing pattern for pricing-constant tables —
-- anon (the extension) can only SELECT; INSERT/UPDATE requires an
-- authenticated Supabase session (the admin webpage's own login gate).
-- If your other pricing tables (basement_pricing, cost_items) use a
-- different write policy than "authenticated", adjust the two policies
-- below to match before running this.

create table if not exists client_preview_settings (
  id                      integer primary key default 1,
  lower_range_multiplier  numeric not null default 0.99,
  upper_range_multiplier  numeric not null default 1.10,
  updated_at              timestamptz not null default now(),
  constraint client_preview_settings_singleton check (id = 1)
);

insert into client_preview_settings (id) values (1)
  on conflict (id) do nothing;

alter table client_preview_settings enable row level security;

drop policy if exists "client_preview_settings anon select" on client_preview_settings;
create policy "client_preview_settings anon select" on client_preview_settings
  for select using (true);

drop policy if exists "client_preview_settings authenticated update" on client_preview_settings;
create policy "client_preview_settings authenticated update" on client_preview_settings
  for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

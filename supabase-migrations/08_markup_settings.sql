-- markup_settings: the markup percentage written onto every BuilderTrend
-- line item during Write to Estimate, replacing whatever markup
-- BuilderTrend's own template defaults to (previously untouched, e.g. its
-- default 33.33%).
--
-- Singleton row (id = 1), same pattern as basement_pricing,
-- client_preview_settings, and allowance_tier_settings.

create table if not exists markup_settings (
  id             integer primary key default 1,
  markup_percent numeric not null default 30,
  updated_at     timestamptz not null default now(),
  constraint markup_settings_singleton check (id = 1)
);

insert into markup_settings (id) values (1)
  on conflict (id) do nothing;

alter table markup_settings enable row level security;

drop policy if exists "markup_settings anon select" on markup_settings;
create policy "markup_settings anon select" on markup_settings
  for select using (true);

drop policy if exists "markup_settings authenticated update" on markup_settings;
create policy "markup_settings authenticated update" on markup_settings
  for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

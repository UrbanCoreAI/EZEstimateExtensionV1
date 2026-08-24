-- notification_settings: who gets emailed when the webpage's Write to
-- Estimate flow runs with "Notify Estimator of Custom Pricing Needed"
-- turned on. Singleton row (id = 1), same pattern as markup_settings/
-- allowance_tier_settings.
--
-- recipient_email can hold a single address or a comma-separated list —
-- the send-pricing-notification Edge Function splits on commas.

create table if not exists notification_settings (
  id             integer primary key default 1,
  recipient_email text not null default '',
  updated_at     timestamptz not null default now(),
  constraint notification_settings_singleton check (id = 1)
);

insert into notification_settings (id) values (1)
  on conflict (id) do nothing;

alter table notification_settings enable row level security;

drop policy if exists "notification_settings anon select" on notification_settings;
create policy "notification_settings anon select" on notification_settings
  for select using (true);

drop policy if exists "notification_settings authenticated update" on notification_settings;
create policy "notification_settings authenticated update" on notification_settings
  for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

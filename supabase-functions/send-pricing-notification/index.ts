// Supabase Edge Function: send-pricing-notification
//
// Called from tabpicker.js (running injected into the BuilderTrend tab)
// right after a webpage-initiated Write to Estimate finishes writing the
// Realtor Fees line — never from the extension's own popup/panel Write to
// Estimate paths. Emails whoever is set in notification_settings the job
// name and the list of items that were written with "pricing subject to
// change" because they were flagged for custom pricing.
//
// Request body: { jobName: string, jobUrl?: string, items: { name: string, price: number }[] }
// Response: { ok: true } or { ok: false, error: string }
//
// ── One-time setup needed before this works ──────────────────────────────
// 1. Deploy this function: `supabase functions deploy send-pricing-notification`
//    (requires the Supabase CLI logged into this project), or paste this
//    file's contents into the Supabase Dashboard's Edge Functions editor
//    and create a function named exactly "send-pricing-notification" there.
// 2. Create a Resend account (resend.com) and verify a sending domain (or
//    use their shared test domain while testing).
// 3. Set two secrets on this function (Dashboard → Edge Functions →
//    send-pricing-notification → Secrets, or `supabase secrets set`):
//      RESEND_API_KEY   — from the Resend dashboard
//      NOTIFY_FROM_EMAIL — the verified "from" address, e.g.
//                          estimates@yourdomain.com
//    SUPABASE_URL and SUPABASE_ANON_KEY are already available to every
//    Edge Function automatically — no need to set those yourself.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  try {
    const { jobName, jobUrl, items } = await req.json();

    if (!jobName || typeof jobName !== 'string') {
      throw new Error('Missing or invalid "jobName"');
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('Missing or empty "items" list — nothing to notify about');
    }
    // items is [{ name, price }, ...] — price is whatever the item was just
    // written to the estimate at. jobUrl is optional (older callers may not
    // send it yet) — falls back to the generic Estimate app URL so the
    // email still has *a* link either way.
    const safeJobUrl = (typeof jobUrl === 'string' && jobUrl) ? jobUrl : 'https://buildertrend.net/app/Estimate';

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!
    );

    const { data: settings, error: settingsErr } = await supabase
      .from('notification_settings')
      .select('recipient_email')
      .eq('id', 1)
      .single();

    if (settingsErr) throw new Error('Could not read notification_settings: ' + settingsErr.message);

    const recipients = (settings?.recipient_email || '')
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean);

    if (!recipients.length) {
      throw new Error('notification_settings.recipient_email is empty — set it in the admin page\'s NOTIFICATIONS tab first');
    }

    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    const fromEmail = Deno.env.get('NOTIFY_FROM_EMAIL');
    if (!resendApiKey || !fromEmail) {
      throw new Error('RESEND_API_KEY / NOTIFY_FROM_EMAIL not configured on this Edge Function');
    }

    const formatPrice = (n: number) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const itemListHtml = items.map((it: { name: string; price: number }) => `<li>${escapeHtml(it.name)} — currently priced at ${formatPrice(it.price)}</li>`).join('');
    const itemListText = items.map((it: { name: string; price: number }) => '- ' + it.name + ' — currently priced at ' + formatPrice(it.price)).join('\n');

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + resendApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: recipients,
        subject: `Custom pricing needed — ${jobName}`,
        html: `<p>The estimate for <strong>${escapeHtml(jobName)}</strong> was just written to BuilderTrend with the following item(s) flagged as needing custom pricing:</p><ul>${itemListHtml}</ul><p>Their descriptions were marked "Pricing is subject to change."</p><p><a href="${escapeHtml(safeJobUrl)}">Open this job's Estimate in BuilderTrend</a></p>`,
        text: `The estimate for ${jobName} was just written to BuilderTrend with the following item(s) flagged as needing custom pricing:\n\n${itemListText}\n\nTheir descriptions were marked "Pricing is subject to change."\n\nOpen this job's Estimate: ${safeJobUrl}`,
      }),
    });

    if (!emailRes.ok) {
      const body = await emailRes.text();
      throw new Error('Resend API returned ' + emailRes.status + ': ' + body);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
});

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

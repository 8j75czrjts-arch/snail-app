-- Optional: the clock that makes the nags fire. Run AFTER schema.sql and after the Vercel deploy.
--
-- Vercel's free plan only allows a cron once a day, which is too coarse for "9 PM, 10:30 PM, 11:30 PM"
-- nags. Supabase can call the API every 15 minutes instead:
--   1. Dashboard -> Database -> Extensions: enable pg_cron and pg_net.
--   2. Replace the two placeholders below, then run this once.
--
-- (Any other pinger works too: cron-job.org, a GitHub Actions schedule, etc. It just needs to send
--  POST https://YOUR-APP.vercel.app/api?r=cron  with the header  X-Cron-Secret: <CRON_SECRET>.)

select cron.schedule(
  'snail-nags',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://YOUR-APP.vercel.app/api?r=cron',
    headers := jsonb_build_object('x-cron-secret', 'YOUR_CRON_SECRET', 'content-type', 'application/json'),
    body    := '{}'::jsonb
  );
  $$
);

-- To stop it later:  select cron.unschedule('snail-nags');

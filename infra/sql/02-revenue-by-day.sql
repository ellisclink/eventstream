-- Revenue per day and currency from purchase events (cents), de-duplicated.
WITH purchases AS (
  SELECT DISTINCT event_id, event_date,
         json_extract_scalar(payload, '$.currency') AS currency,
         CAST(json_extract_scalar(payload, '$.price_cents') AS bigint) AS price_cents
  FROM eventstream.events
  WHERE event_type = 'purchase'
    AND dt >= date_format(current_date - interval '30' day, '%Y-%m-%d')
)
SELECT event_date, currency, count(*) AS purchases, sum(price_cents) AS revenue_cents
FROM purchases
GROUP BY event_date, currency
ORDER BY event_date DESC, revenue_cents DESC;

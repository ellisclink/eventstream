-- Share of archived rows that are redeliveries (same event_id archived more than once).
SELECT dt,
       count(*) AS rows,
       count(DISTINCT event_id) AS unique_events,
       round(1 - CAST(count(DISTINCT event_id) AS double) / count(*), 4) AS duplicate_rate
FROM eventstream.events
WHERE dt >= date_format(current_date - interval '7' day, '%Y-%m-%d')
GROUP BY dt
ORDER BY dt DESC;

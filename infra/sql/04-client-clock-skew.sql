-- How far client clocks drift from server receive time (seconds), per day (last 7 days).
SELECT event_date,
       approx_percentile(date_diff('second', from_iso8601_timestamp(occurred_at), from_iso8601_timestamp(received_at)), 0.5) AS p50_skew_s,
       approx_percentile(date_diff('second', from_iso8601_timestamp(occurred_at), from_iso8601_timestamp(received_at)), 0.99) AS p99_skew_s
FROM eventstream.events
WHERE dt >= date_format(current_date - interval '7' day, '%Y-%m-%d')
GROUP BY event_date
ORDER BY event_date DESC;

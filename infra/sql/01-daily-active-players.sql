-- Daily active players and events per day, de-duplicated by event_id (last 30 days).
WITH events AS (
  SELECT DISTINCT event_id, player_id, event_date
  FROM eventstream.events
  WHERE dt >= date_format(current_date - interval '30' day, '%Y-%m-%d')
)
SELECT event_date,
       count(DISTINCT player_id) AS active_players,
       count(*) AS events
FROM events
GROUP BY event_date
ORDER BY event_date DESC;

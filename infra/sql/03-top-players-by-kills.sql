-- Top 20 players by kills over the last 7 days, with win rate.
WITH matches AS (
  SELECT DISTINCT event_id, player_id,
         json_extract_scalar(payload, '$.result') AS result,
         CAST(json_extract_scalar(payload, '$.kills') AS integer) AS kills
  FROM eventstream.events
  WHERE event_type = 'match_end'
    AND dt >= date_format(current_date - interval '7' day, '%Y-%m-%d')
)
SELECT player_id,
       count(*) AS matches,
       sum(kills) AS kills,
       round(avg(CASE WHEN result = 'win' THEN 1.0 ELSE 0.0 END), 3) AS win_rate
FROM matches
GROUP BY player_id
ORDER BY kills DESC
LIMIT 20;

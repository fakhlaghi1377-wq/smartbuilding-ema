V21 Prediction Dashboard — Unknown load warning only for high load

Replace:
- live-appliance-predictions.html
- live-appliance-predictions-v21.js
- live-appliance-predictions-v21.css

Behavior:
- No "inactive/no active load" message.
- No low/medium warning text.
- Warning is hidden unless UNKNOWN is ON and:
    >=500 W  -> High consumption
    >=1000 W -> Very high consumption
- Delta I and approximate power remain visible.
- No new Supabase query; Egress unchanged.

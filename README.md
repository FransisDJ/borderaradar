
# Borderadarbot — FULL OSINT EXTREME

This repository is a Netlify-deployable project that:
- Runs a scheduled Netlify Function every 1 minute to fetch *trusted* news feeds (Reuters, AP, BBC, Al Jazeera, gov sources)
- Cross-checks events across multiple sources before sending to Telegram (min 2 trusted sources OR direct gov source)
- Geotags events to preset border sectors, scores severity, deduplicates, and persists state in a GitHub Gist
- Sends verified updates to your Telegram bot
- Serves a public `/api/latest` endpoint and a static site with a Leaflet map showing recent events

## Setup (summary)

1. Create repo on GitHub and push this project.
2. Create a GitHub Gist named `borderadar_state.json` with:
```json
{
  "lastIds": [],
  "events": []
}
```
Copy the Gist ID from the URL.

3. Create a GitHub personal access token with `gist` scope (only `gist`).

4. In Netlify site settings -> Environment variables, add:
```
TELEGRAM_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
GIST_TOKEN=ghp_xxx
GIST_ID=your_gist_id
SOURCES_OVERRIDE_JSON=  (optional JSON array override)
```

5. Deploy the site via Netlify -> New site from Git -> select repo.
6. In Netlify UI, configure a Scheduled Function to run `fetchNews` every 1 minute.
   - Netlify supports Scheduled Functions via the UI. If unavailable in your plan use an external scheduler (cron job or GitHub Actions).

7. Test the `/api/latest` endpoint:
`https://<your-site>/.netlify/functions/latest`

8. Monitor Telegram messages from your bot.

## Security notes
- Never commit your tokens. Use Netlify environment vars.
- Use a GitHub token with least privileges (`gist` only).
- If concerned about Gist for persistence, switch to Upstash Redis or another DB.

## Files to edit
- `functions/fetchNews.js` -> edit SOURCES to fit exact trusted RSS/AP endpoints
- `functions/SECTORS` within top of file -> add more sectors for better geo-tagging


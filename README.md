# DayPlay — SF Bay Area Local Intelligence

Get verified real-time places, events, and ready-to-walk outing itineraries for the **San Francisco Bay Area** — San Francisco, Oakland, and Berkeley across 35 curated neighborhood hubs.

Unlike generic LLM-generated recommendations, every venue and event comes from DayPlay's **verified, deterministic dataset** with spatial containment checks. When nothing is happening, this Actor tells you so honestly — it never invents venues, events, dates, or hours.

## What it does

Four modes (pick one in the input form):

| Mode | What you get |
|---|---|
| **plan** *(flagship)* | A complete multi-stop outing: stops in deterministic order, walking distances and times between each, total visit time estimate. Filter by vibe, interests, and budget. |
| **events** | Verified real-time event occurrences for a neighborhood + date |
| **places** | Curated places, with ratings and addresses |
| **neighborhoods** | The complete list of 35 in-market neighborhood centroids |

## Quick start

1. Add this Actor to your Apify account
2. Set the `DAYPLAY_API_KEY` environment variable (secret) — request access at [dayplay.io](https://www.dayplay.io)
3. Choose a mode, pick a neighborhood (e.g. `Mission`), set a date
4. Run — results land in the Actor's dataset

## Input

- **mode**: `plan` / `events` / `places` / `neighborhoods`
- **neighborhood** *(required)*: exact name from the `neighborhoods` mode (e.g. `Mission`, `North Beach`, `Oakland`, `Berkeley`)
- **date**: `YYYY-MM-DD` (required for `plan` and `events`)
- **interests**: optional, comma-separated (e.g. `music, food, art`)
- **budget**: `free` / `budget` / `moderate` / `splurge` (plan mode)
- **maxStops**: 2–6 for plan mode (default 4)
- **limit**: 1–100 for events/places mode (default 20)

## Geographic scope (strict)

DayPlay serves **only** San Francisco, Oakland, and Berkeley. If you request anything else — New York, Los Angeles, Tokyo, anywhere — the Actor returns an explicit `out_of_market` result with the full list of available neighborhoods. It does not fabricate data for unsupported locations. That's the [DayPlay Anti-Drift Guarantee](https://www.dayplay.io).

## Output

Results are written to the default dataset, one item per record:

- `plan` mode → one item: `{status: "ok", type: "itinerary", plan: {stops[], walk_legs[], total_walk_minutes, ...}}`
- `events`/`places` → one item per record (`{status: "ok", type: "event"|"place", name, category, rating, address, ...}`)
- Refusals/empty results → `{status: "out_of_market"|"zero_results", message, ...}`

Every record includes a `dayplay_deep_link` to the neighborhood page on [dayplay.io](https://www.dayplay.io) — where humans can save plans, get alerts, and explore interactively.

## Cost

Runs on Apify's free tier comfortably (typically under a minute per run). Set your own monetization when publishing.

---

*Powered by [DayPlay](https://www.dayplay.io) — the local intelligence layer for humans and their agents.*

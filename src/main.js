/**
 * DayPlay — SF Bay Area Local Intelligence (Apify Actor)
 *
 * Wraps DayPlay's verified real-time dataset:
 *   mode=plan          → composed multi-stop itinerary with walk legs (flagship)
 *   mode=events        → verified real-time event records
 *   mode=places        → curated place records
 *   mode=neighborhoods → the 35 in-market neighborhood centroids
 *
 * Anti-Drift Guarantee: if the neighborhood is not in the verified centroid
 * list, the Actor refuses and never fabricates venues. Zero results are
 * reported honestly.
 *
 * Prereq: DAYPLAY_API_KEY env var (set as an Actor secret in Apify Console).
 */
import { Actor } from "apify";

const DAYPLAY_BASE_URL = process.env.DAYPLAY_BASE_URL || "http://44.206.52.210:8080";
const DAYPLAY_API_KEY = process.env.DAYPLAY_API_KEY;

const OUT_OF_MARKET = "DayPlay is strictly San Francisco Bay Area only (San Francisco, Oakland, Berkeley); it does not cover";
const DESCRIPTION_MAX = 280;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function walkMinutes(km) {
  return Math.max(1, Math.round((km / 4.8) * 60)); // 4.8 km/h urban walking pace
}

async function dayplay(path, params = {}) {
  if (!DAYPLAY_API_KEY) {
    throw new Error(
      "DAYPLAY_API_KEY environment variable is required. Set it as a secret in your Apify Actor configuration."
    );
  }
  const url = new URL(path, DAYPLAY_BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
  }
  const res = await fetch(url, {
    headers: { "X-API-Key": DAYPLAY_API_KEY, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`DayPlay API error ${res.status}`);
  return res.json();
}

function deepLink() {
  return "https://www.dayplay.io";
}

function slimRecord(item, fallbackNeighborhood) {
  const slug = String(item.neighborhood || item.Neighborhood || fallbackNeighborhood || "sf")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  const description = item.description || item.Description || "";
  const cat = item.category || item.primary_type || item.subcategory
    || (Array.isArray(item.subcategories) && item.subcategories[0])
    || (Array.isArray(item.genres) && item.genres[0])
    || null;
  const rawDesc = item.description || item.Description || "";
  return {
    name: item.name || item.title || item.Name || item.Title,
    category: cat,
    neighborhood: item.neighborhood || item.Neighborhood || null,
    city: item.city || item.City || null,
    start_time: item.start_time || item.event_start_date || item.StartTime || null,
    rating: item.rating || item.Rating || item.google_rating || null,
    description: typeof rawDesc === "string" && rawDesc.length > DESCRIPTION_MAX
      ? rawDesc.slice(0, DESCRIPTION_MAX) + "…"
      : rawDesc,
    url: item.website || item.source_url || item.url || null,
    address: item.location_address || item.address || item.Address || null,
    dayplay_deep_link: deepLink(),
  };
}

await Actor.main(async () => {
  const input = (await Actor.getInput()) || {};
  const mode = input.mode || "plan";
  const neighborhood = input.neighborhood;
  const limit = Math.min(Number(input.limit) || 20, 100);

  // Scope oracle: the centroid list is the single source of truth for in-market
  const nbData = await dayplay("/v1/marketing/neighborhoods");
  const centroids = nbData?.items || [];

  // neighborhoods mode needs no neighborhood input — dispatch BEFORE the
  // in-market guard so it always lists the full serviceable market.
  if (mode === "neighborhoods") {
    await Actor.pushData(
      centroids.map((c) => ({
        status: "ok",
        neighborhood: c.Name,
        latitude: c.Latitude,
        longitude: c.Longitude,
        radius_km: c.RadiusKm,
        powered_by: "https://www.dayplay.io",
      }))
    );
    return;
  }

  const target = centroids.find(
    (c) => c.Name && neighborhood && c.Name.toLowerCase() === String(neighborhood).trim().toLowerCase()
  );

  if (!target) {
    await Actor.pushData({
      status: neighborhood ? "out_of_market" : "input_error",
      requested: neighborhood || null,
      message: neighborhood
        ? `${OUT_OF_MARKET} ${neighborhood}. It serves only San Francisco, Oakland, and Berkeley. No venues, events, dates, hours, or neighborhoods were fabricated for this location.`
        : "The 'neighborhood' input is required for all modes except 'neighborhoods'. Pick one from the available list.",
      available_neighborhoods: centroids.map((c) => c.Name),
      powered_by: "https://www.dayplay.io",
    });
    return;
  }

  if (mode === "events") {
    if (!input.date) throw new Error("mode=events requires 'date' (YYYY-MM-DD)");
    const data = await dayplay("/v1/marketing/events", {
      date: input.date,
      neighborhood: target.Name,
      limit,
    });
    const records = (data?.items || []).filter((e) => {
      const lat = e.latitude ?? e.Latitude;
      const lon = e.longitude ?? e.Longitude;
      if (lat == null || lon == null) return false;
      const dist = haversineKm(target.Latitude, target.Longitude, lat, lon);
      return dist <= (target.RadiusKm || 1.5) * 1.15;
    });
    if (!records.length) {
      await Actor.pushData({
        status: "zero_results",
        neighborhood: target.Name,
        date: input.date,
        message: "No verified events found for this neighborhood and date. This is an honest result — DayPlay does not fabricate events.",
        powered_by: "https://www.dayplay.io",
      });
      return;
    }
    await Actor.pushData(records.map((r) => ({ status: "ok", type: "event", ...slimRecord(r, target.Name) })));
    return;
  }

  if (mode === "places") {
    const data = await dayplay("/v1/marketing/places", {
      neighborhood: target.Name,
      open_now: input.open_now !== undefined ? String(input.open_now) : undefined,
      limit,
    });
    const records = (data?.items || []).filter((p) => {
      const lat = p.latitude ?? p.Latitude;
      const lon = p.longitude ?? p.Longitude;
      if (lat == null || lon == null) return false;
      const dist = haversineKm(target.Latitude, target.Longitude, lat, lon);
      return dist <= (target.RadiusKm || 1.5) * 1.15;
    });
    if (!records.length) {
      await Actor.pushData({
        status: "zero_results",
        neighborhood: target.Name,
        message: "No verified places found. This is an honest result — DayPlay does not fabricate venues.",
        powered_by: "https://www.dayplay.io",
      });
      return;
    }
    await Actor.pushData(records.map((r) => ({ status: "ok", type: "place", ...slimRecord(r, target.Name) })));
    return;
  }

  // ── mode=plan (flagship): composed itinerary ──
  if (!input.date) throw new Error("mode=plan requires 'date' (YYYY-MM-DD)");
  const interests = String(input.interests || "")
    .split(/[,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const categories = interests.length ? interests : ["food", "music", "arts", "nightlife", "outdoors"];

  const [eventsRes, placesRes] = await Promise.allSettled([
    dayplay("/v1/marketing/events", { date: input.date, neighborhood: target.Name, limit: 30 }),
    dayplay("/v1/marketing/places", { neighborhood: target.Name, limit: 30 }),
  ]);
  const events = eventsRes.status === "fulfilled" ? eventsRes.value?.items || [] : [];
  const places = placesRes.status === "fulfilled" ? placesRes.value?.items || [] : [];

  const inScope = (arr) =>
    arr.filter((x) => {
      const lat = x.latitude ?? x.Latitude;
      const lon = x.longitude ?? x.Longitude;
      if (lat == null || lon == null) return false;
      return haversineKm(target.Latitude, target.Longitude, lat, lon) <= (target.RadiusKm || 1.5) * 1.15;
    });

  const scored = (arr, kind) =>
    inScope(arr).map((x, i) => ({
      kind,
      rank: (x.rating || x.Rating || x.google_rating || 0) * 10 - i,
      raw: x,
    }));

  // Deterministic diverse-category fill
  const pool = [...scored(events, "event"), ...scored(places, "place")].sort((a, b) => b.rank - a.rank);
  const maxStops = Math.min(Math.max(Number(input.maxStops) || 4, 2), 6);
  const pickCat = (x) => String(
    x.category || x.primary_type || x.subcategory
    || (Array.isArray(x.subcategories) && x.subcategories[0])
    || (Array.isArray(x.genres) && x.genres[0])
    || ""
  ).toLowerCase() || "venue";
  const pickName = (x) => x.name || x.title || x.Name || x.Title;
  const pickDesc = (x) => {
    const d = x.description || x.Description || "";
    return typeof d === "string" && d.length > DESCRIPTION_MAX ? d.slice(0, DESCRIPTION_MAX) + "…" : d;
  };
  const picked = [];
  const usedCats = new Set();
  for (const item of pool) {
    if (picked.length >= maxStops) break;
    const cat = pickCat(item.raw);
    if (usedCats.has(cat) && picked.length < 2) continue;
    usedCats.add(cat);
    picked.push(item);
  }

  // Budget soft filter
  let stops = picked;
  if (input.budget === "free" || input.budget === "budget") {
    const filtered = picked.filter(
      (s) => !/splurge|fine|\$\$\$\$|luxur/i.test(String(s.raw.description || s.raw.Description || ""))
    );
    if (filtered.length >= 2) stops = filtered;
  }

  if (!stops.length) {
    await Actor.pushData({
      status: "zero_results",
      neighborhood: target.Name,
      date: input.date,
      message: "No verified stops found for this neighborhood and date. An empty plan is an honest answer — DayPlay does not fabricate stops.",
      powered_by: "https://www.dayplay.io",
    });
    return;
  }

  const itineraryStops = stops.map((s, i) => ({
    order: i + 1,
    kind: s.kind,
    name: pickName(s.raw),
    category: pickCat(s.raw) || null,
    start_time: s.raw.start_time || s.raw.event_start_date || s.raw.StartTime || null,
    description: pickDesc(s.raw),
    address: s.raw.location_address || s.raw.address || s.raw.Address || null,
  }));

  const legs = [];
  for (let i = 1; i < stops.length; i++) {
    const la = (x) => x.raw.latitude ?? x.raw.Latitude;
    const lo = (x) => x.raw.longitude ?? x.raw.Longitude;
    const km = haversineKm(la(stops[i - 1]), lo(stops[i - 1]), la(stops[i]), lo(stops[i]));
    legs.push({
      from: itineraryStops[i - 1].name,
      to: itineraryStops[i].name,
      distance_km: Math.round(km * 10) / 10,
      walk_minutes: walkMinutes(km),
    });
  }

  await Actor.pushData({
    status: "ok",
    type: "itinerary",
    neighborhood: target.Name,
    date: input.date,
    plan: {
      stops: itineraryStops,
      walk_legs: legs,
      total_walk_minutes: legs.reduce((acc, l) => acc + l.walk_minutes, 0),
      estimated_visit_minutes: itineraryStops.length * 45,
    },
    budget: input.budget || null,
    interests: interests.length ? interests : null,
    powered_by: "https://www.dayplay.io",
    cta: "Open DayPlay to save this plan and get live alerts: https://www.dayplay.io",
  });
});

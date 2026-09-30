/**
 * DayPlay Apify Actor.
 *
 * Calls the live MCP catalog at https://api.dayplay.io/mcp (40 tools).
 * mode selects a common tool. Set `tool` to call any other catalog tool.
 * Gated tools need `accessToken` from Dayplay Google connect.
 */
import { Actor } from "apify";

const MCP_URL = process.env.DAYPLAY_MCP_URL || "https://api.dayplay.io/mcp";

const MODE_TOOLS = {
  neighborhoods: "get_neighborhoods",
  events: "get_events",
  places: "get_places",
  plan: "plan",
};

const INTEREST_WORDS = {
  food: ["restaurant", "cafe", "café", "bakery", "taqueria", "taco", "pizza", "deli", "brunch", "coffee", "diner", "bistro", "eatery"],
  music: ["music", "concert", "jazz", "symphony", "orchestra", "recital", "dj", "band", "reggae", "hip-hop", "rap", "folk", "blues", "soul", "punk"],
  art: ["gallery", "museum", "exhibit", "exhibition"],
  comedy: ["comedy", "standup", "stand-up", "comic"],
  drinks: ["bar", "brewery", "wine", "cocktail", "nightlife", "pub", "tavern"],
};

const ART_TITLE_WORDS = ["art"];

const INTEREST_BLOCK = {
  food: ["record", "bookstore", "library", "park", "museum", "gallery"],
  drinks: ["library", "park", "museum", "bookstore", "gallery"],
  art: ["comedy", "movie"],
};

const FAR_PLACES = [
  "larkspur",
  "marin",
  "sausalito",
  "mill valley",
  "san rafael",
  "tiburon",
  "daly city",
  "san jose",
  "los angeles",
  "santa cruz",
  "sacramento",
];

function todayPT() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseRpc(raw) {
  const trimmed = String(raw || "").trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const line = trimmed.split(/\r?\n/).find((row) => row.startsWith("data:"));
  if (!line) throw new Error("empty MCP response");
  return JSON.parse(line.slice(5).trim());
}

async function mcpCall(name, args, accessToken) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (process.env.DAYPLAY_API_KEY) headers["X-API-Key"] = process.env.DAYPLAY_API_KEY;
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args || {} },
    }),
  });
  const data = parseRpc(await res.text());
  if (res.status === 401) return { authRequired: true };
  if (data.error) return { error: data.error.message || "MCP error" };
  const result = data.result || {};
  const text = result.content?.[0]?.text || "";
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { isError: Boolean(result.isError), data: parsed };
}

function itemsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.items)) return payload.items;
  return [];
}

function neighborhoodName(item) {
  return item?.Name || item?.name || "";
}

function normName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

function findNeighborhood(centroids, name) {
  const key = normName(name);
  const plain = String(name || "").trim().toLowerCase();
  return centroids.find((item) => {
    const label = neighborhoodName(item);
    return normName(label) === key || label.trim().toLowerCase() === plain;
  });
}

function decodeText(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function cleanItem(item, neighborhood) {
  const next = { ...item };
  for (const key of ["title", "name", "description", "Title", "Name"]) {
    if (typeof next[key] === "string") next[key] = decodeText(next[key]);
  }
  const label = neighborhoodName(neighborhood);
  if (/^(oakland|berkeley)$/i.test(label) && next.city === "San Francisco") {
    const lat = next.latitude ?? next.Latitude;
    const lng = next.longitude ?? next.Longitude;
    const nlat = neighborhood.Latitude ?? neighborhood.latitude;
    const nlng = neighborhood.Longitude ?? neighborhood.longitude;
    const radius = Number(neighborhood.RadiusKm ?? neighborhood.radius_km) || 3;
    if (lat != null && lng != null && haversineKm(nlat, nlng, lat, lng) <= radius + 0.2) {
      next.city = label;
    }
  }
  return next;
}

function interestList(raw) {
  return String(raw || "")
    .split(/[,;]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function itemBlob(item) {
  return [
    item.category,
    item.primary_type,
    item.subcategory,
    item.genre,
    item.title,
    item.name,
    ...(Array.isArray(item.subcategories) ? item.subcategories : []),
    ...(Array.isArray(item.subcategory) ? item.subcategory : []),
    ...(Array.isArray(item.genres) ? item.genres : []),
    ...(Array.isArray(item.tags) ? item.tags : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function blobHasWord(blob, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=[^a-z0-9]|$)`, "i").test(blob);
}

function matchesInterest(item, interests) {
  if (!interests.length) return true;
  const blob = itemBlob(item);
  const title = String(item.title || item.name || "");
  const place = String(item.location_name || "");
  const headline = `${title} ${place}`.toLowerCase();
  return interests.some((interest) => {
    const blocks = INTEREST_BLOCK[interest] || [];
    const identity = [title, item.primary_type, item.category, item.genre].filter(Boolean).join(" ").toLowerCase();
    if (blocks.some((word) => blobHasWord(identity, word))) return false;
    const words = INTEREST_WORDS[interest] || [interest];
    if (words.some((word) => blobHasWord(blob, word))) return true;
    if (interest === "art" && ART_TITLE_WORDS.some((word) => blobHasWord(title.toLowerCase(), word))) return true;
    const tour = blobHasWord(headline, "tour");
    const theatre = blobHasWord(headline, "theatre") || blobHasWord(headline, "theater");
    if (interest === "music" && tour && theatre) return true;
    return false;
  });
}

function neighborhoodAliases(label) {
  const name = String(label || "").toLowerCase();
  const aliases = [name];
  if (name === "potrero hill") aliases.push("potrero");
  if (name === "soma") aliases.push("soma");
  return aliases;
}

function homeCity(label) {
  const name = String(label || "").toLowerCase();
  if (name === "oakland") return "oakland";
  if (name === "berkeley") return "berkeley";
  return "san francisco";
}

function namesSomewhereElse(item, requested, centroids) {
  const place = String(item.location_name || item.venue || "").toLowerCase();
  const address = String(item.location_address || item.address || "").toLowerCase();
  const title = String(item.title || item.name || "").toLowerCase();
  const where = `${title} ${place} ${address}`;
  if (!where.trim()) return false;
  if (blobHasWord(where, "virtual")) return true;
  if (FAR_PLACES.some((token) => blobHasWord(where, token))) return true;
  const city = homeCity(neighborhoodName(requested));
  const otherCities = ["san francisco", "oakland", "berkeley"].filter((name) => name !== city);
  if (otherCities.some((name) => blobHasWord(where, name))) return true;
  const requestedKey = normName(neighborhoodName(requested));
  for (const other of centroids) {
    const label = neighborhoodName(other);
    if (normName(label) === requestedKey) continue;
    if (neighborhoodAliases(label).some((alias) => alias.length >= 4 && blobHasWord(`${title} ${place}`, alias))) return true;
  }
  return false;
}

function dedupeEvents(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const day = String(item.event_start_date || "").slice(0, 10);
    const key = [
      String(item.title || item.name || "").trim().toLowerCase(),
      String(item.location_name || "").trim().toLowerCase(),
      day,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function priceTier(item) {
  const raw = item.price_tier ?? item.priceTier;
  const tier = Number(raw);
  return Number.isFinite(tier) ? tier : null;
}

function matchesBudget(item, budget) {
  if (!budget) return true;
  const tier = priceTier(item);
  const title = String(item.title || item.name || "").toLowerCase();
  if (budget === "free") return tier === 0 || title.includes("free");
  if (tier == null) return false;
  if (budget === "budget") return tier <= 1;
  if (budget === "moderate") return tier === 2;
  if (budget === "splurge") return tier >= 3;
  return true;
}

function applyInterests(items, interests) {
  if (!interests.length) return { items, applied: false };
  return { items: items.filter((item) => matchesInterest(item, interests)), applied: true };
}

function composePlan(events, places, input, neighborhood) {
  const interests = interestList(input.interests);
  const interested = applyInterests([...events, ...places], interests);
  let pool = interested.items;
  let budgetApplied = false;
  if (input.budget) {
    budgetApplied = true;
    pool = pool.filter((item) => matchesBudget(item, input.budget));
  }
  const ranked = pool.slice(0, 12);
  const maxStops = Math.min(Math.max(Number(input.maxStops) || 4, 2), 6);
  const stops = ranked.slice(0, maxStops).map((item, index) => ({
    order: index + 1,
    name: item.name || item.title || item.Name || item.Title,
    category: item.category || (Array.isArray(item.subcategories) ? item.subcategories[0] : null) || null,
    price_tier: priceTier(item),
    address: item.location_address || item.address || null,
    latitude: item.latitude ?? item.Latitude ?? null,
    longitude: item.longitude ?? item.Longitude ?? null,
  }));
  const legs = [];
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1];
    const next = stops[i];
    if (prev.latitude == null || next.latitude == null) continue;
    const km = haversineKm(prev.latitude, prev.longitude, next.latitude, next.longitude);
    legs.push({
      from: prev.name,
      to: next.name,
      distance_km: Math.round(km * 10) / 10,
      walk_minutes: Math.max(1, Math.round((km / 4.8) * 60)),
    });
  }
  return {
    status: stops.length ? "ok" : "zero_results",
    type: "itinerary",
    tool: "get_events+get_places",
    neighborhood,
    date: input.date,
    interests: interests.length ? interests : null,
    interests_applied: interested.applied,
    budget: input.budget || null,
    budget_applied: budgetApplied && stops.length > 0,
    plan: {
      stops,
      walk_legs: legs,
      total_walk_minutes: legs.reduce((sum, leg) => sum + leg.walk_minutes, 0),
    },
    powered_by: "https://www.dayplay.io",
  };
}

await Actor.main(async () => {
  const input = (await Actor.getInput()) || {};
  const accessToken = input.accessToken || process.env.DAYPLAY_ACCESS_TOKEN || "";
  const date = input.date || todayPT();
  const neighborhood = input.neighborhood;

  if (input.tool) {
    const called = await mcpCall(input.tool, input.arguments || {}, accessToken);
    if (called.authRequired) {
      await Actor.pushData({
        status: "auth_required",
        tool: input.tool,
        message: "This tool needs a Dayplay user access token. Pass accessToken from Google connect.",
      });
      return;
    }
    if (called.error) {
      await Actor.pushData({
        status: "input_error",
        tool: input.tool,
        message: called.error,
      });
      return;
    }
    await Actor.pushData({
      status: called.isError ? "error" : "ok",
      tool: input.tool,
      result: called.data,
    });
    return;
  }

  const mode = input.mode || "plan";
  const listed = await mcpCall("get_neighborhoods", {}, accessToken);
  if (listed.error) throw new Error(listed.error);
  const centroids = itemsOf(listed.data);

  if (mode === "neighborhoods") {
    await Actor.pushData(
      centroids.map((item) => ({
        status: "ok",
        tool: "get_neighborhoods",
        neighborhood: neighborhoodName(item),
        latitude: item.Latitude ?? item.latitude,
        longitude: item.Longitude ?? item.longitude,
        radius_km: item.RadiusKm ?? item.radius_km,
      }))
    );
    return;
  }

  if (!neighborhood) {
    await Actor.pushData({
      status: "input_error",
      message: "neighborhood is required unless mode is neighborhoods or tool is set.",
    });
    return;
  }

  const resolved = findNeighborhood(centroids, neighborhood);
  if (!resolved) {
    await Actor.pushData({
      status: "out_of_market",
      neighborhood,
      message: "Dayplay covers San Francisco, Oakland, and Berkeley. That neighborhood is outside the market.",
      neighborhoods: centroids.map(neighborhoodName).filter(Boolean),
    });
    return;
  }
  const neighborhoodLabel = neighborhoodName(resolved);

  if (mode === "events" || mode === "places") {
    const tool = MODE_TOOLS[mode];
    const limit = Math.min(Number(input.limit) || 20, 100);
    const args = { neighborhood: neighborhoodLabel, limit: 100 };
    if (mode === "events") args.date = date;
    const called = await mcpCall(tool, args, accessToken);
    if (called.error) {
      await Actor.pushData({ status: "error", tool, message: called.error });
      return;
    }
    const cleaned = itemsOf(called.data)
      .map((item) => cleanItem(item, resolved))
      .filter((item) => !namesSomewhereElse(item, resolved, centroids));
    const prepared = mode === "events" ? dedupeEvents(cleaned) : cleaned;
    const picked = applyInterests(prepared, interestList(input.interests));
    const records = picked.items.slice(0, limit);
    if (!records.length) {
      await Actor.pushData({
        status: "zero_results",
        tool,
        neighborhood: neighborhoodLabel,
        date,
        interests_applied: picked.applied,
        message: picked.applied ? "No rows matched that interest inside this neighborhood." : undefined,
        result: called.data,
      });
      return;
    }
    await Actor.pushData(
      records.map((record) => ({
        status: "ok",
        tool,
        type: mode === "events" ? "event" : "place",
        interests_applied: picked.applied,
        ...record,
      }))
    );
    return;
  }

  const [eventsRes, placesRes] = await Promise.all([
    mcpCall("get_events", { date, neighborhood: neighborhoodLabel, limit: 40 }, accessToken),
    mcpCall("get_places", { neighborhood: neighborhoodLabel, limit: 40 }, accessToken),
  ]);
  if (eventsRes.error || placesRes.error) {
    await Actor.pushData({
      status: "error",
      message: eventsRes.error || placesRes.error,
    });
    return;
  }
  const events = dedupeEvents(
    itemsOf(eventsRes.data)
      .map((item) => cleanItem(item, resolved))
      .filter((item) => !namesSomewhereElse(item, resolved, centroids)),
  );
  const places = itemsOf(placesRes.data)
    .map((item) => cleanItem(item, resolved))
    .filter((item) => !namesSomewhereElse(item, resolved, centroids));
  await Actor.pushData(composePlan(events, places, { ...input, date }, neighborhoodLabel));
});

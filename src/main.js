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
  if (data.error) throw new Error(data.error.message || "MCP error");
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

function interestList(raw) {
  return String(raw || "")
    .split(/[,;]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function matchesInterest(item, interests) {
  if (!interests.length) return true;
  const blob = [
    item.category,
    item.primary_type,
    item.subcategory,
    item.title,
    item.name,
    ...(item.subcategories || []),
    ...(item.genres || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return interests.some((interest) => blob.includes(interest));
}

function composePlan(events, places, input, neighborhood) {
  const interests = interestList(input.interests);
  const inScope = [...events, ...places].filter((item) => matchesInterest(item, interests));
  const pool = (inScope.length ? inScope : [...events, ...places]).slice(0, 12);
  const maxStops = Math.min(Math.max(Number(input.maxStops) || 4, 2), 6);
  const stops = pool.slice(0, maxStops).map((item, index) => ({
    order: index + 1,
    name: item.name || item.title || item.Name || item.Title,
    category: item.category || (Array.isArray(item.subcategories) ? item.subcategories[0] : null) || null,
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
    interests_applied: Boolean(interests.length && inScope.length),
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
    await Actor.pushData({
      status: called.isError ? "error" : "ok",
      tool: input.tool,
      result: called.data,
    });
    return;
  }

  const mode = input.mode || "plan";
  if (mode === "neighborhoods") {
    const called = await mcpCall("get_neighborhoods", {}, accessToken);
    const centroids = itemsOf(called.data);
    await Actor.pushData(
      centroids.map((item) => ({
        status: "ok",
        tool: "get_neighborhoods",
        neighborhood: item.Name || item.name,
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

  if (mode === "events" || mode === "places") {
    const tool = MODE_TOOLS[mode];
    const args = { neighborhood, limit: Math.min(Number(input.limit) || 20, 100) };
    if (mode === "events") {
      args.date = date;
      if (input.interests) args.category = input.interests;
    }
    const called = await mcpCall(tool, args, accessToken);
    const records = itemsOf(called.data);
    if (!records.length) {
      await Actor.pushData({ status: "zero_results", tool, neighborhood, date, result: called.data });
      return;
    }
    await Actor.pushData(records.map((record) => ({ status: "ok", tool, type: mode === "events" ? "event" : "place", ...record })));
    return;
  }

  const eventArgs = { date, neighborhood, limit: 30 };
  if (input.interests) eventArgs.category = input.interests;
  const [eventsRes, placesRes] = await Promise.all([
    mcpCall("get_events", eventArgs, accessToken),
    mcpCall("get_places", { neighborhood, limit: 30, ...(input.interests ? { category: input.interests } : {}) }, accessToken),
  ]);
  await Actor.pushData(
    composePlan(itemsOf(eventsRes.data), itemsOf(placesRes.data), { ...input, date }, neighborhood)
  );
});

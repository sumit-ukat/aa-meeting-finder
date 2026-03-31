/**
 * NA (Narcotics Anonymous) Meeting Scraper
 * Fetches meeting data from meetings.ukna.org using Drupal JSON:API.
 * Just needs a browser User-Agent header — no FlareSolverr required.
 */

const fetch = require("node-fetch");
const { execSync } = require("child_process");

const JSON_API_URL = "https://meetings.ukna.org/jsonapi/node/meeting";
const CURL_BIN = process.env.CURL_CHROME || "curl_chrome116";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const VALID_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const VALID_TIMES = ["morning", "afternoon", "evening", "overnight"];

// Map our day codes to the day names used in NA's field_meeting_day
const DAY_CODE_TO_NAME = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
};

/**
 * Fetch meetings from Drupal JSON:API using curl (bypasses Cloudflare TLS fingerprinting).
 */
function fetchMeetings(limit = 50, offset = 0, retries = 2) {
  const url = `${JSON_API_URL}?page%5Blimit%5D=${limit}&page%5Boffset%5D=${offset}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      console.log(`[NA-Scraper] curl JSON:API attempt ${attempt + 1}/${retries + 1}: limit=${limit}, offset=${offset}`);
      const raw = execSync(
        `${CURL_BIN} -s --max-time 20 -H "Accept: application/vnd.api+json,application/json" "${url}"`,
        { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 25000 }
      );

      if (raw.includes("Just a moment")) {
        console.log("[NA-Scraper] Got Cloudflare challenge");
        if (attempt < retries) continue;
        return null;
      }

      const data = JSON.parse(raw);
      console.log(`[NA-Scraper] Got ${data.data ? data.data.length : 0} meetings from JSON:API`);
      return data;
    } catch (e) {
      console.error(`[NA-Scraper] Fetch error attempt ${attempt + 1}: ${e.message}`);
    }
  }
  return null;
}

/**
 * Fetch ALL meetings from JSON:API (paginated).
 * We cache this since the dataset is not huge.
 */
let cachedMeetings = null;
let cacheTimestamp = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

async function fetchAllMeetings() {
  if (cachedMeetings && (Date.now() - cacheTimestamp < CACHE_TTL)) {
    console.log(`[NA-Scraper] Using cached meetings (${cachedMeetings.length} meetings)`);
    return cachedMeetings;
  }

  const allMeetings = [];
  let offset = 0;
  const limit = 200; // Fetch in larger batches to reduce number of requests

  while (true) {
    const data = await fetchMeetings(limit, offset);
    if (!data || !data.data || data.data.length === 0) break;

    for (const item of data.data) {
      allMeetings.push(convertApiMeeting(item));
    }

    // Check if there are more pages
    if (data.data.length < limit || !data.links || !data.links.next) break;
    offset += limit;

    // Safety limit
    if (offset > 2000) break;
  }

  console.log(`[NA-Scraper] Fetched ${allMeetings.length} total meetings from JSON:API`);
  cachedMeetings = allMeetings;
  cacheTimestamp = Date.now();
  return allMeetings;
}

/**
 * Convert a JSON:API meeting node to our standard meeting format.
 */
function convertApiMeeting(item) {
  const attrs = item.attributes || {};

  // Day
  const day = attrs.field_meeting_day || null;

  // Time — field_meeting_times contains from/to in seconds from midnight
  let time = null;
  const times = attrs.field_meeting_times;
  if (times) {
    const fromSec = parseInt(times.from, 10) || parseInt(times.value, 10);
    const toSec = parseInt(times.to, 10) || parseInt(times.end_value, 10);
    if (!isNaN(fromSec)) {
      const fromH = Math.floor(fromSec / 3600);
      const fromM = Math.floor((fromSec % 3600) / 60);
      const fromStr = `${String(fromH).padStart(2, "0")}:${String(fromM).padStart(2, "0")}`;
      if (!isNaN(toSec)) {
        const toH = Math.floor(toSec / 3600);
        const toM = Math.floor((toSec % 3600) / 60);
        time = `${fromStr}-${String(toH).padStart(2, "0")}:${String(toM).padStart(2, "0")}`;
      } else {
        time = fromStr;
      }
    }
  }

  // Type
  const meetingType = (attrs.field_meeting_type || "").toLowerCase();
  const onlineLink = attrs.field_meeting_online_link;
  const isOnline = meetingType.includes("online") || meetingType.includes("virtual") ||
                   (onlineLink && onlineLink.uri);

  // Address
  const addr = attrs.field_meeting_address || {};
  const addressParts = [
    addr.address_line1,
    addr.address_line2,
    attrs.field_meeting_town,
    addr.administrative_area,
  ].filter(Boolean);
  const location = addressParts.join(", ") || null;
  const postcode = attrs.field_meeting_postcode || addr.postal_code || null;

  // Coordinates
  const coords = attrs.field_meeting_coordinates || {};
  const lat = parseFloat(coords.lat) || null;
  const lng = parseFloat(coords.lon || coords.lng) || null;

  // Venue
  const venue = attrs.field_meeting_venue_name || null;
  const fullLocation = venue ? `${venue}, ${location || ""}`.replace(/, $/, "") : location;

  return {
    name: attrs.title || "NA Meeting",
    day: day,
    time: time,
    duration: null,
    location: isOnline ? null : fullLocation,
    postcode: postcode ? postcode.toUpperCase() : null,
    type: isOnline ? "online" : "in_person",
    detail_url: `https://meetings.ukna.org/node/${item.id ? item.id.replace(/.*\//, "") : ""}`,
    latitude: lat,
    longitude: lng,
    distance: null,
    directions_url: (lat && lng) ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` : null,
    accessibility: attrs.field_meeting_wheelchair ? ["Wheelchair Access"] : null,
    region: attrs.field_meeting_town || null,
  };
}

/**
 * Calculate distance between two lat/lng points in miles (Haversine).
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Geocode a location string using Nominatim.
 */
async function geocodeLocation(locationText) {
  try {
    const query = encodeURIComponent(`${locationText}, United Kingdom`);
    const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "recovery-meeting-finder/1.0" },
    });
    const data = await resp.json();
    if (data && data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch (e) {
    console.error(`[NA-Scraper] Geocoding error: ${e.message}`);
  }
  return null;
}

/**
 * Main search function.
 */
async function searchMeetings(options = {}) {
  const {
    formType = "in_person",
    location,
    days,
    times,
    page = 1,
  } = options;

  console.log(`[NA-Scraper] Search: formType=${formType}, location=${location}, days=${days}, times=${times}`);

  // Fetch all meetings from JSON:API
  const allMeetings = await fetchAllMeetings();

  if (!allMeetings || allMeetings.length === 0) {
    return {
      error: "Failed to fetch results from NA website. The site may be temporarily unavailable.",
      meetings: [],
      total_results: 0,
      max_page: 1,
      page,
    };
  }

  let meetings = [...allMeetings];

  // For in-person location searches, geocode and sort by distance
  if (formType === "in_person" && location) {
    const userCoords = await geocodeLocation(location);
    if (userCoords) {
      console.log(`[NA-Scraper] User location: ${userCoords.lat}, ${userCoords.lng}`);
      for (const m of meetings) {
        if (m.latitude && m.longitude) {
          const dist = haversineDistance(userCoords.lat, userCoords.lng, m.latitude, m.longitude);
          m.distance = `${dist.toFixed(1)} miles`;
          m._dist = dist;
        } else {
          m._dist = 9999;
        }
      }
      meetings = meetings.filter(m => m._dist <= 50);
      meetings.sort((a, b) => a._dist - b._dist);
      meetings.forEach(m => delete m._dist);
    }
  }

  // Note: type, day, and time filtering is handled by server.js post-filter

  // Pagination
  const pageSize = 20;
  const totalResults = meetings.length;
  const maxPage = Math.max(1, Math.ceil(totalResults / pageSize));
  const start = (page - 1) * pageSize;
  const paginated = meetings.slice(start, start + pageSize);

  return {
    total_results: totalResults,
    meetings: paginated,
    max_page: maxPage,
    page,
  };
}

async function closeBrowser() {}

module.exports = {
  searchMeetings,
  closeBrowser,
  VALID_DAYS,
  VALID_TIMES,
};

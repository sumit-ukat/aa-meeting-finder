/**
 * CA (Cocaine Anonymous) Meeting Scraper
 * Fetches meeting data from meetings.cocaineanonymous.org.uk
 * The TSML plugin embeds all meeting data as a JSON `locations` variable in the HTML.
 * No Cloudflare protection — direct HTTP fetch works.
 */

const cheerio = require("cheerio");
const fetch = require("node-fetch");
const { execSync } = require("child_process");

const BASE_URL = "https://meetings.cocaineanonymous.org.uk/meetings/";

const VALID_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const VALID_TIMES = ["morning", "afternoon", "evening", "overnight"];

const CURL_BIN = process.env.CURL_CHROME || "curl_chrome116";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// TSML uses 0=Sunday, 1=Monday ... 6=Saturday
const DAY_CODE_TO_TSML = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const TSML_DAY_TO_NAME = {
  0: "Sunday", 1: "Monday", 2: "Tuesday", 3: "Wednesday",
  4: "Thursday", 5: "Friday", 6: "Saturday",
};

/**
 * Fetch the meetings page HTML using curl (consistent with AA/NA approach).
 * Uses curl to bypass potential Cloudflare/IP blocking on datacenter IPs.
 */
function fetchPage(retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      console.log(`[CA-Scraper] curl fetch attempt ${attempt + 1}/${retries + 1}`);
      const html = execSync(
        `${CURL_BIN} -s --max-time 20 -H "Accept: text/html" -H "Accept-Language: en-GB,en;q=0.9" "${BASE_URL}"`,
        { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 25000 }
      );

      console.log(`[CA-Scraper] Got HTML (${html.length} chars)`);

      if (html.includes("Just a moment")) {
        console.log("[CA-Scraper] Got Cloudflare challenge");
        if (attempt < retries) continue;
        return null;
      }

      return html;
    } catch (e) {
      console.error(`[CA-Scraper] Fetch error attempt ${attempt + 1}: ${e.message}`);
    }
  }
  return null;
}

/**
 * Extract the embedded `locations` JSON from the TSML page HTML.
 * TSML embeds data as: var locations = {"id": {name, latitude, longitude, url, formatted_address, meetings: [...]}, ...};
 * It's an OBJECT keyed by location ID, not an array.
 */
function extractLocationsData(html) {
  // Find the var locations = {...}; assignment
  // Use a robust approach: find the start, then find the matching closing brace
  const marker = "var locations = ";
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) {
    console.log("[CA-Scraper] Could not find 'var locations' in HTML");
    return null;
  }

  const jsonStart = startIdx + marker.length;
  // Find the end by tracking brace depth
  let depth = 0;
  let endIdx = jsonStart;
  for (let i = jsonStart; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i + 1;
        break;
      }
    }
  }

  const jsonStr = html.substring(jsonStart, endIdx);
  try {
    const parsed = JSON.parse(jsonStr);
    // Convert object to array of location values
    const locations = Object.values(parsed);
    console.log(`[CA-Scraper] Found embedded locations object with ${locations.length} locations`);
    return locations;
  } catch (e) {
    console.error(`[CA-Scraper] Failed to parse locations JSON: ${e.message}`);
    // Try a smaller chunk in case of trailing content
    console.log(`[CA-Scraper] JSON snippet: ${jsonStr.substring(0, 200)}`);
    return null;
  }
}

/**
 * Convert embedded TSML location/meeting data to our standard meeting format.
 * TSML locations contain nested meetings arrays.
 */
function convertLocationsToMeetings(locations) {
  const meetings = [];

  for (const loc of locations) {
    // Each location has a name, lat, lng, formatted_address, and nested meetings
    const locName = loc.name || loc.location || "";
    const locAddress = loc.formatted_address || loc.address || "";
    const locLat = parseFloat(loc.latitude) || null;
    const locLng = parseFloat(loc.longitude) || null;
    const locUrl = loc.url || null;

    // Meetings are nested in the location
    const meetingList = loc.meetings || loc.children || [];
    if (!Array.isArray(meetingList) || meetingList.length === 0) {
      // Location itself might be a flat meeting
      if (loc.time && loc.name) {
        meetings.push(convertSingleMeeting(loc, locName, locAddress, locLat, locLng));
      }
      continue;
    }

    for (const m of meetingList) {
      meetings.push(convertSingleMeeting(m, locName, locAddress, locLat, locLng));
    }
  }

  return meetings;
}

/**
 * Decode HTML entities in a string.
 */
function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#\d+;/g, match => {
      const code = parseInt(match.slice(2, -1), 10);
      return String.fromCharCode(code);
    })
    .replace(/&[a-z]+;/gi, match => {
      // For named entities we can't easily decode, return as-is
      const entities = { '&oacute;': 'ó', '&eacute;': 'é', '&aacute;': 'á', '&uacute;': 'ú', '&iacute;': 'í', '&ntilde;': 'ñ' };
      return entities[match.toLowerCase()] || match;
    });
}

function convertSingleMeeting(m, locName, locAddress, locLat, locLng) {
  const dayNum = parseInt(m.day, 10);
  const dayName = TSML_DAY_TO_NAME[dayNum] || null;

  const types = m.types || [];
  const isOnline = types.includes("ONL") || types.includes("online") ||
                   /online|zoom|virtual/i.test(m.name || "");

  return {
    name: decodeHtmlEntities(m.name || locName || "Meeting"),
    day: dayName,
    time: m.time || null,
    duration: null,
    location: isOnline ? null : (locName ? `${locName}, ${locAddress}` : locAddress),
    postcode: extractPostcode(locAddress) || null,
    type: isOnline ? "online" : "in_person",
    detail_url: m.url || null,
    latitude: locLat,
    longitude: locLng,
    distance: null,
    directions_url: (locLat && locLng) ? `https://www.google.com/maps/dir/?api=1&destination=${locLat},${locLng}` : null,
    accessibility: null,
    meeting_tags: types.join(", ") || null,
  };
}

function extractPostcode(text) {
  if (!text) return null;
  const match = text.match(/([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Calculate distance between two lat/lng points in miles (Haversine).
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Geocode a location string to lat/lng using Nominatim.
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
    console.error(`[CA-Scraper] Geocoding error: ${e.message}`);
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

  console.log(`[CA-Scraper] Search: formType=${formType}, location=${location}, days=${days}, times=${times}`);

  // Fetch the HTML page
  const html = await fetchPage();

  if (!html) {
    return {
      error: "Failed to fetch results from CA website. The site may be temporarily unavailable.",
      meetings: [],
      total_results: 0,
      max_page: 1,
      page,
    };
  }

  // Extract embedded meeting data
  const locationsData = extractLocationsData(html);

  if (!locationsData || locationsData.length === 0) {
    // Fallback: try parsing HTML table (old approach)
    console.log("[CA-Scraper] No embedded data found, trying HTML table parse");
    return {
      error: "Could not extract meeting data from CA website. The site format may have changed.",
      meetings: [],
      total_results: 0,
      max_page: 1,
      page,
    };
  }

  // Convert to our meeting format
  let meetings = convertLocationsToMeetings(locationsData);
  console.log(`[CA-Scraper] Extracted ${meetings.length} total meetings from embedded data`);

  // For in-person location searches, geocode and sort by distance
  let userCoords = null;
  if (formType === "in_person" && location) {
    userCoords = await geocodeLocation(location);
    if (userCoords) {
      console.log(`[CA-Scraper] User location: ${userCoords.lat}, ${userCoords.lng}`);
      // Calculate distance for each meeting and sort
      for (const m of meetings) {
        if (m.latitude && m.longitude) {
          const dist = haversineDistance(userCoords.lat, userCoords.lng, m.latitude, m.longitude);
          m.distance = `${dist.toFixed(1)} miles`;
          m._dist = dist;
        } else {
          m._dist = 9999;
        }
      }
      // Filter to within 50 miles for in-person
      meetings = meetings.filter(m => m._dist <= 50);
      meetings.sort((a, b) => a._dist - b._dist);
      // Clean up internal field
      meetings.forEach(m => delete m._dist);
    }
  }

  // Note: type, day, and time filtering is handled by server.js post-filter

  // Pagination (client-side since we have all data)
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

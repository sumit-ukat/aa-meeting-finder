/**
 * CA (Cocaine Anonymous) Meeting Scraper
 * Fetches meeting data from meetings.cocaineanonymous.org.uk
 * The TSML plugin embeds all meeting data as a JSON `locations` variable in the HTML.
 * No Cloudflare protection — direct HTTP fetch works.
 */

const cheerio = require("cheerio");
const fetch = require("node-fetch");

const BASE_URL = "https://meetings.cocaineanonymous.org.uk/meetings/";

const VALID_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const VALID_TIMES = ["morning", "afternoon", "evening", "overnight"];

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
 * Fetch the meetings page HTML directly (no FlareSolverr needed).
 */
async function fetchPage(retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      console.log(`[CA-Scraper] Fetching HTML attempt ${attempt + 1}/${retries + 1}`);
      const resp = await fetch(BASE_URL, {
        headers: {
          "User-Agent": BROWSER_UA,
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-GB,en;q=0.9",
        },
        timeout: 20000,
      });

      if (!resp.ok) {
        console.log(`[CA-Scraper] HTTP ${resp.status}`);
        continue;
      }

      const html = await resp.text();
      console.log(`[CA-Scraper] Got HTML (${html.length} chars)`);
      return html;
    } catch (e) {
      console.error(`[CA-Scraper] Fetch error attempt ${attempt + 1}: ${e.message}`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
  }
  return null;
}

/**
 * Extract the embedded `locations` JSON from the TSML page HTML.
 * TSML embeds all meeting data in a script tag as: var defined_something = [...];
 */
function extractLocationsData(html) {
  // TSML embeds data like: var defined_something = [{...}, ...]; or locations = [...]
  // Look for JSON arrays in script tags
  const $ = cheerio.load(html);
  let locationsData = null;

  $("script").each(function () {
    const content = $(this).html() || "";
    // Match patterns like: var locations = [...] or tsml.locations = [...]
    const patterns = [
      /(?:var\s+)?locations\s*=\s*(\[[\s\S]*?\]);/,
      /(?:var\s+)?tsml_meetings\s*=\s*(\[[\s\S]*?\]);/,
      /(?:var\s+)?meetings\s*=\s*(\[[\s\S]*?\]);/,
      /(?:var\s+)?tsml\s*=\s*(\{[\s\S]*?\});/,
    ];

    for (const pat of patterns) {
      const match = content.match(pat);
      if (match) {
        try {
          const parsed = JSON.parse(match[1]);
          if (Array.isArray(parsed) && parsed.length > 0) {
            locationsData = parsed;
            console.log(`[CA-Scraper] Found embedded locations array with ${parsed.length} entries`);
            return false; // break each loop
          }
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            // Could be tsml config object with meetings array inside
            if (parsed.meetings && Array.isArray(parsed.meetings)) {
              locationsData = parsed.meetings;
              console.log(`[CA-Scraper] Found embedded meetings in tsml object: ${locationsData.length} entries`);
              return false;
            }
          }
        } catch (e) {
          // JSON parse failed, try next pattern
        }
      }
    }
  });

  return locationsData;
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

function convertSingleMeeting(m, locName, locAddress, locLat, locLng) {
  const dayNum = parseInt(m.day, 10);
  const dayName = TSML_DAY_TO_NAME[dayNum] || null;

  const types = m.types || [];
  const isOnline = types.includes("ONL") || types.includes("online") ||
                   /online|zoom|virtual/i.test(m.name || "");

  return {
    name: m.name || locName || "Meeting",
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

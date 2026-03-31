/**
 * AA Meeting Scraper
 * Scrapes meeting data from alcoholics-anonymous.org.uk
 * Uses direct HTTP fetch with browser User-Agent (bypasses Cloudflare managed challenge).
 */

const cheerio = require("cheerio");
const fetch = require("node-fetch");
const { execSync } = require("child_process");

const BASE_URL = "https://www.alcoholics-anonymous.org.uk/find-a-meeting/";
// curl-impersonate binary name (set in Dockerfile, falls back to regular curl)
const CURL_BIN = process.env.CURL_CHROME || "curl_chrome116";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const VALID_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const VALID_TIMES = ["morning", "afternoon", "evening", "overnight"];
const DAY_NAMES = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

/**
 * Geocode a location string to lat/lng using Nominatim.
 */
async function geocodeLocation(locationText, country = "United Kingdom") {
  try {
    const query = encodeURIComponent(`${locationText}, ${country}`);
    const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`;
    console.log(`[Scraper] Geocoding: ${locationText}`);
    const resp = await fetch(url, {
      headers: { "User-Agent": "recovery-meeting-finder/1.0" },
    });
    const data = await resp.json();
    if (data && data.length > 0) {
      console.log(`[Scraper] Geocoded to lat=${data[0].lat}, lng=${data[0].lon}`);
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
    console.log("[Scraper] Geocoding returned no results");
  } catch (e) {
    console.error(`[Scraper] Geocoding error: ${e.message}`);
  }
  return { lat: null, lng: null };
}

/**
 * Build the search URL with query parameters.
 */
function buildSearchUrl(formType, options = {}) {
  const {
    location,
    country = "United Kingdom",
    days,
    times,
    sort,
    page = 1,
    lat,
    lng,
  } = options;

  const params = new URLSearchParams();

  if (formType === "in_person") {
    params.set("lat", lat || "");
    params.set("lng", lng || "");
    params.set("form", "in_person");
    params.set("view", "list");
    params.set("sort", sort || "distance");
    params.set("location", location || "");
    params.set("country", country);
  } else {
    params.set("form", "online");
    params.set("view", "list");
    params.set("sort", sort || "date");
  }

  if (days && days.length > 0) {
    days.forEach((d) => params.append("day[]", d.toLowerCase()));
  }

  if (times && times.length > 0) {
    times.forEach((t) => params.append("time[]", t.toLowerCase()));
  }

  if (page > 1) {
    params.set("meeting_page", String(page));
  }

  return `${BASE_URL}?${params.toString()}`;
}

/**
 * Fetch a page using curl (bypasses Cloudflare TLS fingerprinting).
 * node-fetch gets 403 from Cloudflare, but curl's TLS stack passes.
 */
function fetchPage(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      console.log(`[Scraper] curl fetch attempt ${attempt + 1}/${retries + 1} for ${url}`);

      const html = execSync(
        `${CURL_BIN} -s --max-time 20 -H "Accept: text/html" -H "Accept-Language: en-GB,en;q=0.9" "${url}"`,
        { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 25000 }
      );

      console.log(`[Scraper] Got HTML (${html.length} chars)`);

      if (html.includes("Just a moment") || html.includes("cf-browser-verification")) {
        console.log("[Scraper] Got Cloudflare challenge page");
        if (attempt < retries) continue;
        return null;
      }

      if (html.includes("meeting-card") || html.includes("results-section") || html.includes("meeting-form") || html.length > 5000) {
        return html;
      }

      console.log("[Scraper] Response too small or missing content");
      if (attempt < retries) continue;
      return html;
    } catch (e) {
      console.error(`[Scraper] curl error on attempt ${attempt + 1}: ${e.message}`);
    }
  }
  console.error("[Scraper] All fetch attempts failed");
  return null;
}

/**
 * Parse an in-person meeting card from the DOM.
 */
function parseInPersonCard($, card) {
  const meeting = {};
  const $card = $(card);
  const text = $card.text().replace(/\s+/g, " ").trim();

  // Day - from .card-heading element
  const dayEl = $card.find(".card-heading").first();
  if (dayEl.length) {
    meeting.day = dayEl.text().trim();
  } else {
    for (const d of DAY_NAMES) {
      if (text.startsWith(d)) {
        meeting.day = d;
        break;
      }
    }
  }

  // Name and detail URL
  const nameLink = $card.find(".meeting-card__heading-link, h3 a, h2 a").first();
  if (nameLink.length) {
    meeting.name = nameLink.text().trim();
    const href = nameLink.attr("href") || "";
    meeting.detail_url = href.startsWith("http")
      ? href
      : `https://www.alcoholics-anonymous.org.uk${href}`;
  } else {
    const nameH = $card.find("h3, h2").first();
    if (nameH.length) meeting.name = nameH.text().trim();
  }

  // Location - address in <p> tag
  const addressEl = $card.find(".meeting-card__text p, .subsection p").first();
  if (addressEl.length) {
    meeting.location = addressEl.text().trim();
  }

  // Details from <dl> definition list
  $card.find(".meeting-details-list dt").each(function () {
    const label = $(this).text().trim().toLowerCase();
    const value = $(this).next("dd").text().trim();
    if (label === "time") meeting.time = value;
    else if (label === "duration") meeting.duration = value;
    else if (label === "distance") meeting.distance = value;
    else if (label === "postcode") meeting.postcode = value;
  });

  // Fallback: regex-based extraction
  if (!meeting.time) {
    const timeMatch = text.match(/Time\s+(\d{1,2}:\d{2}[–-]\d{1,2}:\d{2})/);
    if (timeMatch) meeting.time = timeMatch[1];
  }
  if (!meeting.duration) {
    const durMatch = text.match(/Duration\s+(\d+\s+hours?\s*(?:\d+\s+minutes?)?|\d+\s+minutes?)/);
    if (durMatch) meeting.duration = durMatch[1];
  }
  if (!meeting.distance) {
    const distMatch = text.match(/Distance\s+([\d.]+[\s\u00a0]+miles?)/);
    if (distMatch) meeting.distance = distMatch[1].replace(/\u00a0/g, " ");
  }
  if (!meeting.postcode) {
    const pcMatch = text.match(/Postcode\s+([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})/);
    if (pcMatch) meeting.postcode = pcMatch[1];
  }

  // Accessibility
  const features = [];
  $card.find(".meeting-access__item").each(function () {
    const feat = $(this).text().trim();
    if (feat) features.push(feat);
  });
  if (features.length === 0) {
    if (text.includes("Wheelchair Access")) features.push("Wheelchair Access");
    if (/Sign [Ll]anguage/.test(text)) features.push("Sign Language");
    if (/Hearing [Aa]id [Ll]oop/.test(text)) features.push("Hearing Aid Loop");
    if (/Chit [Ss]ystem/.test(text)) features.push("Chit System");
  }
  if (features.length) meeting.accessibility = features;

  // Directions link
  const dirLink = $card.find('a[href*="google.com/maps/dir"], a.icon-link').first();
  if (dirLink.length) {
    const href = dirLink.attr("href") || "";
    if (href.includes("google.com/maps")) {
      meeting.directions_url = href;
      const coords = href.match(/destination=([-\d.]+),([-\d.]+)/);
      if (coords) {
        meeting.latitude = parseFloat(coords[1]);
        meeting.longitude = parseFloat(coords[2]);
      }
    }
  }

  // Check if this card actually looks like an online meeting despite being on the in-person page
  if (/online|zoom|virtual|teams/i.test(text) && !meeting.location) {
    meeting.type = "online";
  } else {
    meeting.type = "in_person";
  }
  return meeting;
}

/**
 * Parse an online meeting card from the DOM.
 */
function parseOnlineCard($, card) {
  const meeting = {};
  const $card = $(card);
  const text = $card.text().replace(/\s+/g, " ").trim();

  const dayEl = $card.find(".card-heading").first();
  if (dayEl.length) {
    meeting.day = dayEl.text().trim();
  } else {
    for (const d of DAY_NAMES) {
      if (text.startsWith(d)) {
        meeting.day = d;
        break;
      }
    }
  }

  const nameLink = $card.find(".meeting-card__heading-link, h3 a, h2 a").first();
  if (nameLink.length) {
    meeting.name = nameLink.text().trim();
    const href = nameLink.attr("href") || "";
    meeting.detail_url = href.startsWith("http")
      ? href
      : `https://www.alcoholics-anonymous.org.uk${href}`;
  } else {
    const nameH = $card.find("h3, h2").first();
    if (nameH.length) meeting.name = nameH.text().trim();
  }

  $card.find(".meeting-details-list dt").each(function () {
    const label = $(this).text().trim().toLowerCase();
    const value = $(this).next("dd").text().trim();
    if (label === "time") meeting.time = value;
    else if (label === "duration") meeting.duration = value;
  });

  if (!meeting.time) {
    const timeMatch = text.match(/Time\s+(\d{1,2}:\d{2}[–-]\d{1,2}:\d{2})/);
    if (timeMatch) meeting.time = timeMatch[1];
  }
  if (!meeting.duration) {
    const durMatch = text.match(/Duration\s+(\d+\s+hours?\s*(?:\d+\s+minutes?)?|\d+\s+minutes?)/);
    if (durMatch) meeting.duration = durMatch[1];
  }

  meeting.type = "online";
  return meeting;
}

/**
 * Parse the full results page HTML.
 */
function parseResultsPage(html, formType) {
  const $ = cheerio.load(html);

  let totalResults = 0;
  const bodyText = $("body").text();
  const totalMatch = bodyText.match(/Found (\d+) results/);
  if (totalMatch) totalResults = parseInt(totalMatch[1], 10);

  let resolvedLocation = null;
  const locMatch = bodyText.match(
    /Found \d+ results for\s+(.+?)(?:\s*List|\s*Map|\s*PDF)/
  );
  if (locMatch) resolvedLocation = locMatch[1].trim();

  const cards = $(".meeting-card");
  const meetings = [];
  cards.each(function () {
    if (formType === "in_person") {
      meetings.push(parseInPersonCard($, this));
    } else {
      meetings.push(parseOnlineCard($, this));
    }
  });

  let maxPage = 1;
  $('a[href*="meeting_page="]').each(function () {
    const href = $(this).attr("href") || "";
    const pm = href.match(/meeting_page=(\d+)/);
    if (pm) maxPage = Math.max(maxPage, parseInt(pm[1], 10));
  });

  return {
    total_results: totalResults,
    resolved_location: resolvedLocation,
    meetings,
    max_page: maxPage,
  };
}

/**
 * Main search function.
 */
async function searchMeetings(options = {}) {
  const {
    formType = "in_person",
    location,
    country = "United Kingdom",
    days,
    times,
    sort,
    page = 1,
  } = options;

  let lat = null;
  let lng = null;

  if (formType === "in_person" && location) {
    const geo = await geocodeLocation(location, country);
    lat = geo.lat;
    lng = geo.lng;
  }

  const url = buildSearchUrl(formType, {
    location,
    country,
    days,
    times,
    sort,
    page,
    lat,
    lng,
  });

  console.log(`[Scraper] Fetching: ${url}`);
  const html = await fetchPage(url);

  if (!html) {
    return {
      error: "Failed to fetch results from AA website. The site may be temporarily unavailable.",
      meetings: [],
      total_results: 0,
      max_page: 1,
      page,
    };
  }

  const result = parseResultsPage(html, formType);
  result.page = page;
  result.search_url = url;

  console.log(`[Scraper] Found ${result.meetings.length} meetings (total: ${result.total_results})`);
  return result;
}

/**
 * Fetch details for a specific meeting.
 */
async function getMeetingDetail(meetingId) {
  const url = `https://www.alcoholics-anonymous.org.uk/meeting/${meetingId}/`;
  const html = await fetchPage(url);
  if (!html) return null;

  const $ = cheerio.load(html);
  const detail = {};
  const text = $("body").text();

  const noteMatch = text.match(/Please note\s+(.+?)(?:Address|$)/s);
  if (noteMatch) detail.notes = noteMatch[1].replace(/\s+/g, " ").trim();

  const zoomLink = $('a[href*="zoom.us"]').first();
  if (zoomLink.length) detail.zoom_url = zoomLink.attr("href");

  const zoomIdMatch = text.match(/Zoom ID:\s*([\d\s]+)/);
  if (zoomIdMatch) detail.zoom_id = zoomIdMatch[1].trim();

  return detail;
}

async function closeBrowser() {}

module.exports = {
  searchMeetings,
  getMeetingDetail,
  closeBrowser,
  VALID_DAYS,
  VALID_TIMES,
};

/**
 * AA Meeting Scraper
 * Scrapes meeting data from alcoholics-anonymous.org.uk
 * Uses Puppeteer to bypass Cloudflare protection.
 * Supports both in-person and online meetings with filtering by day, time, and location.
 */

const cheerio = require("cheerio");
const fetch = require("node-fetch");
const puppeteer = require("puppeteer");

const BASE_URL = "https://www.alcoholics-anonymous.org.uk/find-a-meeting/";

const VALID_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const VALID_TIMES = ["morning", "afternoon", "evening", "overnight"];
const DAY_NAMES = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

// Shared browser instance for efficiency
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.connected) {
    browserInstance = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });
  }
  return browserInstance;
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Geocode a location string to lat/lng using Nominatim.
 */
async function geocodeLocation(locationText, country = "United Kingdom") {
  try {
    const query = encodeURIComponent(`${locationText}, ${country}`);
    const url = `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "aa-meeting-finder-connector/1.0" },
    });
    const data = await resp.json();
    if (data && data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch (e) {
    // Geocoding failed silently
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
 * Fetch a page using Puppeteer to handle Cloudflare challenges.
 */
async function fetchPage(url, retries = 2) {
  const browser = await getBrowser();

  for (let attempt = 0; attempt <= retries; attempt++) {
    let page = null;
    try {
      page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
      );
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-GB,en;q=0.9",
      });

      await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

      // Wait for Cloudflare challenge to resolve if present
      const isChallenge = await page.evaluate(() =>
        document.title.includes("Just a moment")
      );
      if (isChallenge) {
        // Wait for challenge to pass (up to 15 seconds)
        await page.waitForFunction(
          () => !document.title.includes("Just a moment"),
          { timeout: 15000 }
        );
        // Wait a bit more for page to fully load
        await page.waitForSelector(".meeting-card, .results-section, .meeting-form", {
          timeout: 10000,
        }).catch(() => {});
      }

      const html = await page.content();
      await page.close();

      // Check if we actually got content
      if (html.includes("meeting-card") || html.includes("results-section") || html.includes("meeting-form")) {
        return html;
      }

      // If no meeting content, might still be on challenge page
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (e) {
      if (page) await page.close().catch(() => {});
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
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
  const nameLink = $card.find("h3 a, .meeting-card__heading a, h2 a").first();
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

  // Location - address is in a <p> tag inside the card
  const addressEl = $card.find(".meeting-card__text p").first();
  if (addressEl.length) {
    meeting.location = addressEl.text().trim();
  }

  // Time
  const timeMatch = text.match(/Time\s+(\d{1,2}:\d{2}[–-]\d{1,2}:\d{2})/);
  if (timeMatch) meeting.time = timeMatch[1];

  // Duration
  const durMatch = text.match(
    /Duration\s+(\d+\s+hours?\s*(?:\d+\s+minutes?)?|\d+\s+minutes?)/
  );
  if (durMatch) meeting.duration = durMatch[1];

  // Distance (may have &nbsp; rendered as \u00a0)
  const distMatch = text.match(/Distance\s+([\d.]+[\s\u00a0]+miles?)/);
  if (distMatch) meeting.distance = distMatch[1].replace(/\u00a0/g, " ");

  // Postcode
  const pcMatch = text.match(/Postcode\s+([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})/);
  if (pcMatch) meeting.postcode = pcMatch[1];

  // Accessibility
  const features = [];
  if (text.includes("Wheelchair Access")) features.push("Wheelchair Access");
  if (/Sign [Ll]anguage/.test(text)) features.push("Sign Language");
  if (/Hearing [Aa]id [Ll]oop/.test(text)) features.push("Hearing Aid Loop");
  if (/Chit [Ss]ystem/.test(text)) features.push("Chit System");
  if (features.length) meeting.accessibility = features;

  // Directions link (contains lat/lng)
  const dirLink = $card.find('a[href*="google.com/maps/dir"]').first();
  if (dirLink.length) {
    meeting.directions_url = dirLink.attr("href");
    const coords = dirLink
      .attr("href")
      .match(/destination=([-\d.]+),([-\d.]+)/);
    if (coords) {
      meeting.latitude = parseFloat(coords[1]);
      meeting.longitude = parseFloat(coords[2]);
    }
  }

  meeting.type = "in_person";
  return meeting;
}

/**
 * Parse an online meeting card from the DOM.
 */
function parseOnlineCard($, card) {
  const meeting = {};
  const $card = $(card);
  const text = $card.text().replace(/\s+/g, " ").trim();

  // Day
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
  const nameLink = $card.find("h3 a, .meeting-card__heading a, h2 a").first();
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

  // Time
  const timeMatch = text.match(/Time\s+(\d{1,2}:\d{2}[–-]\d{1,2}:\d{2})/);
  if (timeMatch) meeting.time = timeMatch[1];

  // Duration
  const durMatch = text.match(
    /Duration\s+(\d+\s+hours?\s*(?:\d+\s+minutes?)?|\d+\s+minutes?)/
  );
  if (durMatch) meeting.duration = durMatch[1];

  meeting.type = "online";
  return meeting;
}

/**
 * Parse the full results page HTML.
 */
function parseResultsPage(html, formType) {
  const $ = cheerio.load(html);

  // Total results
  let totalResults = 0;
  const bodyText = $("body").text();
  const totalMatch = bodyText.match(/Found (\d+) results/);
  if (totalMatch) totalResults = parseInt(totalMatch[1], 10);

  // Resolved location
  let resolvedLocation = null;
  const locMatch = bodyText.match(
    /Found \d+ results for\s+(.+?)(?:\s*List|\s*Map|\s*PDF)/
  );
  if (locMatch) resolvedLocation = locMatch[1].trim();

  // Meeting cards
  const cards = $(".meeting-card");
  const meetings = [];
  cards.each(function () {
    if (formType === "in_person") {
      meetings.push(parseInPersonCard($, this));
    } else {
      meetings.push(parseOnlineCard($, this));
    }
  });

  // Pagination
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

  // Notes
  const noteMatch = text.match(/Please note\s+(.+?)(?:Address|$)/s);
  if (noteMatch) detail.notes = noteMatch[1].replace(/\s+/g, " ").trim();

  // Zoom link
  const zoomLink = $('a[href*="zoom.us"]').first();
  if (zoomLink.length) detail.zoom_url = zoomLink.attr("href");

  // Zoom ID
  const zoomIdMatch = text.match(/Zoom ID:\s*([\d\s]+)/);
  if (zoomIdMatch) detail.zoom_id = zoomIdMatch[1].trim();

  return detail;
}

module.exports = {
  searchMeetings,
  getMeetingDetail,
  closeBrowser,
  VALID_DAYS,
  VALID_TIMES,
};

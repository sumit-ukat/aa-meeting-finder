/**
 * AA Meeting Scraper
 * Scrapes meeting data from alcoholics-anonymous.org.uk
 * Uses dual approach: lightweight fetch first, Puppeteer fallback.
 * Supports both in-person and online meetings with filtering by day, time, and location.
 */

const cheerio = require("cheerio");
const fetch = require("node-fetch");

const BASE_URL = "https://www.alcoholics-anonymous.org.uk/find-a-meeting/";

const VALID_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const VALID_TIMES = ["morning", "afternoon", "evening", "overnight"];
const DAY_NAMES = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

// Shared browser instance for Puppeteer fallback
let browserInstance = null;

/**
 * Try fetching a page with plain HTTP first (fastest, works if no CF challenge).
 */
async function fetchWithHttp(url) {
  try {
    console.log(`[Scraper] Trying HTTP fetch for: ${url}`);
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Sec-Ch-Ua": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
      timeout: 20000,
      redirect: "follow",
    });

    console.log(`[Scraper] HTTP response status: ${resp.status}`);

    if (resp.status === 403 || resp.status === 503) {
      console.log("[Scraper] HTTP fetch blocked (likely Cloudflare), will try Puppeteer");
      return null;
    }

    const html = await resp.text();
    console.log(`[Scraper] HTTP fetch got ${html.length} chars`);

    // Check if it's a Cloudflare challenge page
    if (html.includes("Just a moment") || html.includes("cf-browser-verification") || html.includes("challenge-platform")) {
      console.log("[Scraper] Got Cloudflare challenge page via HTTP, will try Puppeteer");
      return null;
    }

    // Check if we got actual meeting content
    if (html.includes("meeting-card") || html.includes("results-section") || html.includes("meeting-form")) {
      console.log("[Scraper] HTTP fetch succeeded with meeting content");
      return html;
    }

    console.log("[Scraper] HTTP response has no meeting content");
    const snippet = html.substring(0, 300).replace(/\s+/g, " ");
    console.log(`[Scraper] Snippet: ${snippet}`);
    return null;
  } catch (e) {
    console.log(`[Scraper] HTTP fetch error: ${e.message}`);
    return null;
  }
}

/**
 * Launch Puppeteer with stealth settings.
 */
async function getBrowser() {
  if (!browserInstance || !browserInstance.connected) {
    let puppeteer;
    try {
      puppeteer = require("puppeteer-extra");
      const StealthPlugin = require("puppeteer-extra-plugin-stealth");
      puppeteer.use(StealthPlugin());
      console.log("[Scraper] Using puppeteer-extra with stealth plugin");
    } catch (e) {
      puppeteer = require("puppeteer");
      console.log("[Scraper] Using plain puppeteer (stealth plugin not available)");
    }

    const launchOptions = {
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=1920,1080",
        "--lang=en-GB,en",
      ],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      console.log(`[Scraper] Using Chrome at: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    }
    console.log("[Scraper] Launching browser...");
    browserInstance = await puppeteer.launch(launchOptions);
    console.log("[Scraper] Browser launched successfully");
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
    console.log(`[Scraper] Geocoding: ${locationText}`);
    const resp = await fetch(url, {
      headers: { "User-Agent": "aa-meeting-finder-connector/1.0" },
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
 * Fetch a page using Puppeteer (fallback for when HTTP fetch is blocked by Cloudflare).
 */
async function fetchWithPuppeteer(url, retries = 2) {
  const browser = await getBrowser();

  for (let attempt = 0; attempt <= retries; attempt++) {
    let page = null;
    try {
      console.log(`[Scraper] Puppeteer attempt ${attempt + 1}/${retries + 1}`);
      page = await browser.newPage();
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
      );
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-GB,en;q=0.9",
      });
      await page.setViewport({ width: 1920, height: 1080 });

      // Override navigator.webdriver
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        // Override plugins
        Object.defineProperty(navigator, "plugins", {
          get: () => [1, 2, 3, 4, 5],
        });
        // Override languages
        Object.defineProperty(navigator, "languages", {
          get: () => ["en-GB", "en-US", "en"],
        });
        // Override permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) =>
          parameters.name === "notifications"
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);
      });

      const response = await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
      console.log(`[Scraper] Puppeteer loaded with status: ${response ? response.status() : "unknown"}`);

      const title = await page.title();
      console.log(`[Scraper] Page title: "${title}"`);

      if (title.includes("Just a moment")) {
        console.log("[Scraper] Cloudflare challenge detected, waiting up to 25s...");
        await page.waitForFunction(
          () => !document.title.includes("Just a moment"),
          { timeout: 25000 }
        );
        console.log("[Scraper] Cloudflare challenge passed");
        await page.waitForSelector(".meeting-card, .results-section, .meeting-form", {
          timeout: 15000,
        }).catch(() => {
          console.log("[Scraper] No meeting selectors found after challenge");
        });
      } else {
        await page.waitForSelector(".meeting-card, .results-section, .meeting-form", {
          timeout: 10000,
        }).catch(() => {
          console.log("[Scraper] No meeting selectors found on page");
        });
      }

      const html = await page.content();
      await page.close();
      page = null;

      console.log(`[Scraper] Puppeteer got HTML (${html.length} chars)`);

      if (html.includes("meeting-card") || html.includes("results-section") || html.includes("meeting-form")) {
        console.log("[Scraper] Puppeteer found meeting content");
        return html;
      }

      console.log("[Scraper] Puppeteer: no meeting content found");
      if (attempt < retries) {
        const delay = 3000 * (attempt + 1);
        console.log(`[Scraper] Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    } catch (e) {
      console.error(`[Scraper] Puppeteer error: ${e.message}`);
      if (page) await page.close().catch(() => {});
      if (attempt < retries) {
        const delay = 3000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  return null;
}

/**
 * Fetch a page - tries HTTP first, falls back to Puppeteer.
 */
async function fetchPage(url) {
  // Try lightweight HTTP fetch first
  let html = await fetchWithHttp(url);
  if (html) return html;

  // Fall back to Puppeteer
  console.log("[Scraper] Falling back to Puppeteer...");
  html = await fetchWithPuppeteer(url);
  return html;
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

  // Location - address is in a <p> tag inside .subsection
  const addressEl = $card.find(".meeting-card__text p, .subsection p").first();
  if (addressEl.length) {
    meeting.location = addressEl.text().trim();
  }

  // Details from <dl> definition list
  $card.find(".meeting-details-list dt").each(function (i) {
    const label = $(this).text().trim().toLowerCase();
    const value = $(this).next("dd").text().trim();
    if (label === "time") meeting.time = value;
    else if (label === "duration") meeting.duration = value;
    else if (label === "distance") meeting.distance = value;
    else if (label === "postcode") meeting.postcode = value;
  });

  // Fallback: regex-based extraction from text
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
  // Fallback
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

  // Details from <dl>
  $card.find(".meeting-details-list dt").each(function () {
    const label = $(this).text().trim().toLowerCase();
    const value = $(this).next("dd").text().trim();
    if (label === "time") meeting.time = value;
    else if (label === "duration") meeting.duration = value;
  });

  // Fallback
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
      error: "Failed to fetch results from AA website. The site may be temporarily unavailable or blocking automated requests.",
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

module.exports = {
  searchMeetings,
  getMeetingDetail,
  closeBrowser,
  VALID_DAYS,
  VALID_TIMES,
};

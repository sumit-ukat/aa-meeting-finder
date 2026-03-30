/**
 * CA (Cocaine Anonymous) Meeting Scraper
 * Scrapes meeting data from meetings.cocaineanonymous.org.uk
 * Uses FlareSolverr to bypass any protection.
 * WordPress site using TSML (Twelve Step Meeting List) plugin.
 */

const cheerio = require("cheerio");
const fetch = require("node-fetch");

const BASE_URL = "https://meetings.cocaineanonymous.org.uk/meetings/";
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";

const VALID_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const VALID_TIMES = ["morning", "afternoon", "evening", "overnight"];

// TSML uses 0=Sunday, 1=Monday ... 6=Saturday
const DAY_MAP = {
  sun: "0",
  mon: "1",
  tue: "2",
  wed: "3",
  thu: "4",
  fri: "5",
  sat: "6",
};

const DAY_NUMBER_TO_NAME = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};

/**
 * Classify a time string into a time-of-day bucket.
 * morning: 00:00-11:59, afternoon: 12:00-16:59, evening: 17:00-20:59, overnight: 21:00-23:59
 */
function classifyTime(timeStr) {
  if (!timeStr) return null;
  const match = timeStr.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = parseInt(match[1], 10);
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";
  return "overnight";
}

/**
 * Build the search URL with query parameters.
 */
function buildSearchUrl(formType, options = {}) {
  const { location, days, times, page = 1 } = options;

  const params = new URLSearchParams();

  // Location search
  if (formType === "in_person" && location) {
    params.set("tsml-near", location);
  }

  // Type filter
  if (formType === "online") {
    params.set("tsml-type", "online");
  } else {
    params.set("tsml-type", "in_person");
  }

  // Day filter - TSML only supports a single day parameter at a time.
  // If multiple days requested, use the first one; if none, omit.
  if (days && days.length > 0) {
    const dayVal = DAY_MAP[days[0].toLowerCase()];
    if (dayVal !== undefined) {
      params.set("tsml-day", dayVal);
    }
  }

  // TSML does not have server-side time filtering; we filter client-side.

  return `${BASE_URL}?${params.toString()}`;
}

/**
 * Fetch a page using FlareSolverr.
 */
async function fetchPage(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      console.log(`[CA-Scraper] FlareSolverr request attempt ${attempt + 1}/${retries + 1} for ${url}`);

      const resp = await fetch(FLARESOLVERR_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cmd: "request.get",
          url: url,
          maxTimeout: 45000,
        }),
      });

      const data = await resp.json();

      if (data.status === "ok" && data.solution) {
        const html = data.solution.response;
        console.log(`[CA-Scraper] FlareSolverr got HTML (${html.length} chars), status: ${data.solution.status}`);

        // Check for TSML table content or meeting markers
        if (html.includes("tsml") || html.includes("<table") || html.includes("meetings-list") || html.includes("meeting")) {
          console.log("[CA-Scraper] Found meeting content in response");
          return html;
        }

        console.log("[CA-Scraper] No meeting content in FlareSolverr response");
        const snippet = html.substring(0, 300).replace(/\s+/g, " ");
        console.log(`[CA-Scraper] Snippet: ${snippet}`);
      } else {
        console.log(`[CA-Scraper] FlareSolverr returned status: ${data.status}, message: ${data.message || "none"}`);
      }

      if (attempt < retries) {
        const delay = 3000 * (attempt + 1);
        console.log(`[CA-Scraper] Retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    } catch (e) {
      console.error(`[CA-Scraper] FlareSolverr error on attempt ${attempt + 1}: ${e.message}`);
      if (attempt < retries) {
        const delay = 3000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  console.error("[CA-Scraper] All fetch attempts failed");
  return null;
}

/**
 * Parse a single meeting row from the TSML table.
 */
function parseMeetingRow($, row) {
  const meeting = {};
  const $row = $(row);

  // Extract type from row class (e.g. type-o = open, type-c = closed)
  const rowClass = $row.attr("class") || "";

  // Columns: time, distance, name, location_group, address, region, district, types
  const cells = $row.find("td");

  // Time column
  const timeCell = cells.eq(0);
  if (timeCell.length) {
    meeting.time = timeCell.text().trim();
  }

  // Distance column (only present for location-based searches)
  const distCell = cells.eq(1);
  if (distCell.length) {
    const distText = distCell.text().trim();
    if (distText && distText !== "") {
      meeting.distance = distText;
    }
  }

  // Name column - typically has a link to meeting detail
  const nameCell = cells.eq(2);
  if (nameCell.length) {
    const nameLink = nameCell.find("a").first();
    if (nameLink.length) {
      meeting.name = nameLink.text().trim();
      const href = nameLink.attr("href") || "";
      meeting.detail_url = href.startsWith("http")
        ? href
        : `https://meetings.cocaineanonymous.org.uk${href}`;
    } else {
      meeting.name = nameCell.text().trim();
    }
  }

  // Location/group column
  const locationCell = cells.eq(3);
  if (locationCell.length) {
    meeting.location = locationCell.text().trim();
  }

  // Address column
  const addressCell = cells.eq(4);
  if (addressCell.length) {
    const address = addressCell.text().trim();
    if (address) {
      meeting.location = meeting.location
        ? `${meeting.location}, ${address}`
        : address;

      // Try to extract postcode from address
      const pcMatch = address.match(/([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})/i);
      if (pcMatch) {
        meeting.postcode = pcMatch[1].toUpperCase();
      }
    }
  }

  // Region column
  const regionCell = cells.eq(5);
  if (regionCell.length) {
    const region = regionCell.text().trim();
    if (region) {
      meeting.region = region;
    }
  }

  // District column
  const districtCell = cells.eq(6);
  if (districtCell.length) {
    const district = districtCell.text().trim();
    if (district) {
      meeting.district = district;
    }
  }

  // Types column (tags like Open, Closed, etc.)
  const typesCell = cells.eq(7);
  if (typesCell.length) {
    const types = typesCell.text().trim();
    if (types) {
      meeting.meeting_tags = types;
    }
  }

  // Determine day from the time or from page context
  // TSML tables often group by day, check for day headers
  // We'll set day from the data attribute or class if available
  const dayAttr = $row.attr("data-day") || $row.closest("[data-day]").attr("data-day");
  if (dayAttr !== undefined) {
    meeting.day = DAY_NUMBER_TO_NAME[parseInt(dayAttr, 10)] || dayAttr;
  }

  // Determine meeting type from row class or types column
  if (rowClass.includes("type-online") || (meeting.meeting_tags && /online/i.test(meeting.meeting_tags))) {
    meeting.type = "online";
  } else {
    meeting.type = "in_person";
  }

  // Directions URL - look for Google Maps link
  const dirLink = $row.find('a[href*="google.com/maps"], a[href*="maps.google"]').first();
  if (dirLink.length) {
    meeting.directions_url = dirLink.attr("href");
    const coords = meeting.directions_url.match(/destination=([-\d.]+),([-\d.]+)/);
    if (coords) {
      meeting.latitude = parseFloat(coords[1]);
      meeting.longitude = parseFloat(coords[2]);
    }
  }

  // Defaults for missing fields
  if (!meeting.duration) meeting.duration = null;
  if (!meeting.accessibility) meeting.accessibility = null;
  if (!meeting.latitude) meeting.latitude = null;
  if (!meeting.longitude) meeting.longitude = null;
  if (!meeting.directions_url) meeting.directions_url = null;
  if (!meeting.postcode) meeting.postcode = null;
  if (!meeting.distance) meeting.distance = null;

  return meeting;
}

/**
 * Parse the full results page HTML.
 */
function parseResultsPage(html, formType, timesFilter) {
  const $ = cheerio.load(html);

  const meetings = [];

  // TSML renders meetings in a table; look for table rows
  // Try multiple selectors for the TSML table
  let rows = $("table tbody tr");
  if (rows.length === 0) {
    rows = $("table tr").not("thead tr");
  }

  // Track current day from day header rows
  let currentDay = null;

  rows.each(function () {
    const $row = $(this);

    // Check if this is a day header row (TSML sometimes uses header rows)
    const headerText = $row.find("th").text().trim();
    if (headerText) {
      // Could be a day header like "Monday", "Tuesday" etc.
      const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      for (const dn of dayNames) {
        if (headerText.includes(dn)) {
          currentDay = dn;
          break;
        }
      }
      return; // Skip header rows
    }

    const cells = $row.find("td");
    if (cells.length < 2) return; // Skip rows without enough data

    const meeting = parseMeetingRow($, this);

    // Set day from context if not already set
    if (!meeting.day && currentDay) {
      meeting.day = currentDay;
    }

    // Client-side time filtering
    if (timesFilter && timesFilter.length > 0) {
      const bucket = classifyTime(meeting.time);
      if (bucket && !timesFilter.includes(bucket)) {
        return; // Skip this meeting - doesn't match time filter
      }
    }

    if (meeting.name) {
      meetings.push(meeting);
    }
  });

  // Try to find total results count
  let totalResults = meetings.length;
  const countEl = $(".tsml-meeting-count, .meeting-count, .results-count");
  if (countEl.length) {
    const countMatch = countEl.text().match(/(\d+)/);
    if (countMatch) totalResults = parseInt(countMatch[1], 10);
  }

  // Pagination - TSML uses /page/N/ or ?paged=N
  let maxPage = 1;
  $('a[href*="/page/"], a[href*="paged="]').each(function () {
    const href = $(this).attr("href") || "";
    const pageMatch = href.match(/\/page\/(\d+)|paged=(\d+)/);
    if (pageMatch) {
      const pNum = parseInt(pageMatch[1] || pageMatch[2], 10);
      maxPage = Math.max(maxPage, pNum);
    }
  });

  // Also check TSML pagination buttons
  $(".tsml-pagination a, .page-numbers a").each(function () {
    const text = $(this).text().trim();
    const num = parseInt(text, 10);
    if (!isNaN(num)) {
      maxPage = Math.max(maxPage, num);
    }
  });

  return {
    total_results: totalResults,
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
    days,
    times,
    page = 1,
  } = options;

  const url = buildSearchUrl(formType, { location, days, times, page });

  console.log(`[CA-Scraper] Fetching: ${url}`);
  const html = await fetchPage(url);

  if (!html) {
    return {
      error: "Failed to fetch results from CA website. The site may be temporarily unavailable.",
      meetings: [],
      total_results: 0,
      max_page: 1,
      page,
      search_url: url,
    };
  }

  const result = parseResultsPage(html, formType, times);
  result.page = page;
  result.search_url = url;

  console.log(`[CA-Scraper] Found ${result.meetings.length} meetings (total: ${result.total_results})`);
  return result;
}

// No browser to close with FlareSolverr approach
async function closeBrowser() {}

module.exports = {
  searchMeetings,
  closeBrowser,
  VALID_DAYS,
  VALID_TIMES,
};

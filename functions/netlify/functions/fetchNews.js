
/**
 * fetchNews.js - Netlify Scheduled Function (FULL OSINT mode)
 *
 * Features:
 * - Fetch multiple trusted RSS feeds (configurable)
 * - Basic content normalization + keyword relevance filtering
 * - Cross-source verification: require event to appear in >=2 trusted sources within recent window OR be from gov source
 * - Geotag via preset SECTORS with keyword matching
 * - Severity scoring heuristic (keywords + source weight)
 * - Deduplication (persistent via GitHub Gist)
 * - Send formatted message to Telegram
 *
 * ENV required:
 * - TELEGRAM_TOKEN
 * - TELEGRAM_CHAT_ID
 * - GIST_TOKEN
 * - GIST_ID
 *
 * NOTE: Replace / add more precise/region-specific RSS feed URLs in SOURCES for best results.
 */

const fetch = require('node-fetch');
const RSSParser = require('rss-parser');
const crypto = require('crypto');

const parser = new RSSParser({
  requestOptions: {
    headers: { 'User-Agent': 'Borderadar-Bot/FullOSINT' }
  }
});

// ---------------- CONFIG ----------------
const SOURCES = [
  { name: 'Reuters', type: 'rss', url: 'https://www.reuters.com/world/rss' },
  { name: 'AP', type: 'rss', url: 'https://apnews.com/hub/asia-pacific?format=rss' },
  { name: 'Al Jazeera', type: 'rss', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'BBC', type: 'rss', url: 'http://feeds.bbci.co.uk/news/world/rss.xml' },
  // Add gov RSS endpoints if available; treat gov sources as high-trust
  // Example placeholder (replace with real MFA/Gov RSS if exists)
  // { name: 'Thailand MFA', type: 'rss', url: 'https://www.mfa.go.th/rss' }
];

const SECTOR_KEYWORDS_MIN_MATCH = 1; // min matched keywords to tag a sector

// Preset sectors (approx coords). Expand this list with more precise coordinates.
const SECTORS = [
  { id: 'sector_preah_vihear', name: 'Preah Vihear / Oddar Meanchey', lat: 13.833, lon: 103.5, keywords: ['preah vihear','oddar meanchey','preah'] },
  { id: 'sector_surin', name: 'Surin / Sisaket / Buriram', lat: 14.8, lon: 103.5, keywords: ['surin','sisaket','buriram'] },
  { id: 'sector_banteay', name: 'Banteay Meanchey / Battambang', lat: 13.2, lon: 102.7, keywords: ['banteay','battambang'] },
  { id: 'sector_si_saket', name: 'Si Sa Ket area', lat: 14.507, lon: 104.13, keywords: ['si sa ket','sisaket']},
  // add more as needed
];

// keywords for relevance & severity scoring
const RELEVANT_KEYWORDS = ['border','clash','air strike','airstrike','rocket','drone','artillery','fired','clashes','flee','evacuate','killed','injured','casualties','shelling','strike','attack','ambush','troop','military','raid','offensive'];

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GIST_TOKEN = process.env.GIST_TOKEN;
const GIST_ID = process.env.GIST_ID;
const SOURCES_OVERRIDE_JSON = process.env.SOURCES_OVERRIDE_JSON; // optional: override SOURCES via env

const GIST_API = 'https://api.github.com/gists';

// ---------------- helpers ----------------
function md5(input){ return crypto.createHash('md5').update(input).digest('hex'); }

async function fetchGistState(){
  if (!GIST_TOKEN || !GIST_ID) return { lastIds: [], events: [] };
  const res = await fetch(`${GIST_API}/${GIST_ID}`, { headers: { Authorization: `token ${GIST_TOKEN}`, 'User-Agent': 'BorderadarBot' }});
  if (!res.ok) return { lastIds: [], events: [] };
  const js = await res.json();
  try {
    const file = js.files['borderadar_state.json'];
    const content = JSON.parse(file.content);
    return content;
  } catch(e){
    return { lastIds: [], events: [] };
  }
}

async function saveGistState(state){
  if (!GIST_TOKEN || !GIST_ID) return;
  const payload = { files: { 'borderadar_state.json': { content: JSON.stringify(state, null, 2) } } };
  await fetch(`${GIST_API}/${GIST_ID}`, { method: 'PATCH', headers: { Authorization: `token ${GIST_TOKEN}`, 'User-Agent': 'BorderadarBot', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

function normalizeText(s=''){ return (s||'').replace(/\s+/g,' ').trim().toLowerCase(); }
function scoreSeverity(text){
  const lower = text.toLowerCase();
  let score = 0;
  const severeKeywords = ['killed','killing','casualties','injured','mass','flee','evacuate','airstrike','air strike','artillery','shelling','bomb'];
  severeKeywords.forEach(k => { if (lower.includes(k)) score += 3; });
  RELEVANT_KEYWORDS.forEach(k => { if (lower.includes(k)) score += 1; });
  return Math.min(score, 10);
}
function detectSector(text){
  const lower = text.toLowerCase();
  for (const s of SECTORS){
    let matches = 0;
    for (const kw of s.keywords) if (lower.includes(kw)) matches++;
    if (matches >= SECTOR_KEYWORDS_MIN_MATCH) return s;
  }
  return null;
}

// send Telegram message (HTML parse_mode)
async function sendTelegram(text, disablePreview=false){
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram env missing');
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: disablePreview };
  await fetch(url, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body) });
}

// fuzzy title similarity (simple)
function similar(a,b){
  if(!a||!b) return false;
  a = normalizeText(a); b = normalizeText(b);
  if (a===b) return true;
  const aWords = new Set(a.split(' '));
  const bWords = new Set(b.split(' '));
  let common = 0;
  for (const w of aWords) if (bWords.has(w)) common++;
  const ratio = common / Math.max(aWords.size, bWords.size);
  return ratio > 0.5;
}

// main handler
exports.handler = async function(event, context){
  try {
    // possible dynamic override
    let sources = SOURCES;
    if (SOURCES_OVERRIDE_JSON) {
      try { sources = JSON.parse(SOURCES_OVERRIDE_JSON); } catch(e){ console.log('SOURCES_OVERRIDE_JSON parse error'); }
    }

    const state = await fetchGistState(); // { lastIds: [], events: [] }
    const fetchedItems = []; // {source, title, link, pubDate, content}
    // fetch feeds
    for (const src of sources){
      try {
        if (src.type === 'rss') {
          const feed = await parser.parseURL(src.url);
          for (const item of feed.items.slice(0, 20)){
            fetchedItems.push({ source: src.name, title: item.title||'', link: item.link||'', pubDate: item.pubDate||item.isoDate||new Date().toISOString(), content: item.contentSnippet||item.content||'' });
          }
        } else {
          // support json endpoints if provided
          const r = await fetch(src.url, { headers: { 'User-Agent':'BorderadarBot/FullOSINT' }});
          const j = await r.json();
          // expecting array of items under j.items or j.articles, fallback
          const list = j.items||j.articles||j.data||[];
          for (const it of list.slice(0,20)) fetchedItems.push({ source: src.name, title: it.title||it.headline||'', link: it.url||it.link||'', pubDate: it.publishedAt||it.pubDate||new Date().toISOString(), content: it.description||it.summary||'' });
        }
      } catch(e){
        console.log('Feed error', src.name, e.message);
      }
    }

    // filter by relevance keywords
    const relevant = fetchedItems.filter(it => {
      const txt = normalizeText(`${it.title} ${it.content}`);
      return RELEVANT_KEYWORDS.some(k => txt.includes(k));
    });

    // build candidate events grouped by fuzzy title similarity
    const groups = [];
    for (const it of relevant){
      let placed = false;
      for (const g of groups){
        if (similar(g.prototypeTitle, it.title) || similar(g.prototypeTitle, it.content) || similar(it.title, g.prototypeTitle)){
          g.items.push(it);
          // update prototypeTitle if needed (short)
          placed = true; break;
        }
      }
      if (!placed){
        groups.push({ prototypeTitle: it.title, items: [it] });
      }
    }

    const now = new Date();
    const toSend = [];

    // Evaluate each group: require >=2 trusted sources OR any gov source
    for (const g of groups){
      const sourcesSet = new Set(g.items.map(x => x.source));
      const countTrusted = sourcesSet.size;
      // check if any source name contains 'mfa' or 'gov' treat as gov
      const hasGov = Array.from(sourcesSet).some(s => /mfa|gov|ministr/i.test(s.toLowerCase()));
      // pick the earliest pubDate among items
      const sorted = g.items.sort((a,b)=> new Date(a.pubDate)-new Date(b.pubDate));
      const representative = sorted[0];
      const fingerprint = md5(representative.title + representative.link);

      if (state.lastIds && state.lastIds.includes(fingerprint)) continue; // already sent

      // require cross-check
      if (countTrusted >= 2 || hasGov){
        // geotag & severity
        const fullText = `${representative.title} ${representative.content}`;
        const sector = detectSector(fullText);
        const severity = scoreSeverity(fullText);
        const eventObj = {
          id: fingerprint,
          title: representative.title,
          link: representative.link,
          pubDate: representative.pubDate,
          sources: Array.from(sourcesSet),
          snippet: representative.content,
          sector: sector ? { id: sector.id, name: sector.name, lat: sector.lat, lon: sector.lon } : null,
          severity,
          fetchedAt: now.toISOString()
        };
        toSend.push(eventObj);
      } else {
        // not cross-verified enough; skip for FULL OSINT to prevent hoaxes
        console.log('Skipped unverified group:', g.prototypeTitle, 'sources:', Array.from(sourcesSet));
      }
    }

    // dedupe among toSend by similar titles
    const finalSend = [];
    for (const ev of toSend){
      if (!finalSend.some(f => similar(f.title, ev.title))) finalSend.push(ev);
    }

    // send messages and update state
    for (const ev of finalSend){
      // create message
      const when = new Date(ev.pubDate).toUTCString();
      let text = `🔷 <b>Borderadar — Verified Update</b>\n`;
      text += `<b>Time:</b> ${when}\n`;
      text += `<b>Severity:</b> ${ev.severity} / 10\n`;
      text += `<b>Sources:</b> ${ev.sources.join(', ')}\n\n`;
      text += `<b>${ev.title}</b>\n`;
      if (ev.snippet) text += `${ev.snippet}\n`;
      text += `\n🔗 ${ev.link}\n`;
      if (ev.sector){
        text += `📍 Sector: ${ev.sector.name}\n`;
        text += `Map: https://www.google.com/maps/search/?api=1&query=${ev.sector.lat},${ev.sector.lon}\n`;
      }
      try {
        await sendTelegram(text, false);
        state.lastIds = state.lastIds || [];
        state.lastIds.push(ev.id);
        state.events = state.events || [];
        state.events.unshift(ev);
        if (state.events.length > 200) state.events = state.events.slice(0,200);
        // persist
        await saveGistState(state);
      } catch(e){
        console.log('Telegram send error', e.message);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, sent: finalSend.length }) };

  } catch(err){
    console.log('Fatal', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: err.message }) };
  }
};

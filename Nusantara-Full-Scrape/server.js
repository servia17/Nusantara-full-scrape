const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, timingSafeEqual } = require('node:crypto');

// --- Auth config -----------------------------------------------------------
// Set these in your environment (Emergent dashboard / .env, NEVER hardcoded
// in the source): ADMIN_EMAIL, ADMIN_PASSWORD, PARTNER_EMAIL, PARTNER_PASSWORD.
// If they are not set, admin/partner login is disabled entirely rather than
// falling back to an insecure default.
const ACCOUNTS = [
  process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD
    ? { email: process.env.ADMIN_EMAIL.toLowerCase(), password: process.env.ADMIN_PASSWORD, role: 'admin', id: 'admin', name: 'Admin' }
    : null,
  process.env.PARTNER_EMAIL && process.env.PARTNER_PASSWORD
    ? { email: process.env.PARTNER_EMAIL.toLowerCase(), password: process.env.PARTNER_PASSWORD, role: 'partner', id: 'partner', name: 'Partner' }
    : null,
].filter(Boolean);

// In-memory session store: token -> { user, expiresAt }. Tokens are random
// per login and expire after a few hours, instead of one fixed shared string.
const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
function createSession(user) {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}
function sessionUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const session = token && sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) { sessions.delete(token); return null; }
  return session.user;
}

const root = __dirname;
const capture = path.join(root, 'full_output');
const stateDir = path.join(root, 'data');
const listingsFile = path.join(stateDir, 'listings.json');
const inquiriesFile = path.join(stateDir, 'inquiries.json');
const defaultListingsFile = path.join(capture, 'api/nusantara-hub-8.preview.emergentagent.com/listings.json');
const htmlPages = {
  '/': 'index.html', '/about': 'about.html', '/concierge': 'concierge.html',
  '/craft': 'craft.html', '/experiences': 'experiences.html', '/explore': 'explore.html',
  '/innovation': 'innovation.html', '/partner': 'partner.html', '/request-quote': 'request-quote.html',
  '/listing/bamboo-architecture-structures': 'listing_bamboo-architecture-structures.html',
  '/listing/bamboo-furniture-collection': 'listing_bamboo-furniture-collection.html',
  '/listing/indonesian-bamboo-handicrafts': 'listing_indonesian-bamboo-handicrafts.html',
  '/listing/jetcar': 'listing_jetcar.html', '/listing/madutiga-beach-resort': 'listing_madutiga-beach-resort.html'
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
function listings() { return readJson(listingsFile, readJson(defaultListingsFile, [])); }
function saveListings(value) { writeJson(listingsFile, value); }
function inquiries() { return readJson(inquiriesFile, []); }
function saveInquiries(value) { writeJson(inquiriesFile, value); }
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function text(res, status, value, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType }); res.end(value);
}
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON body')); } });
  });
}
function filteredListings(params) {
  return listings().filter(item => {
    const query = (params.get('q') || '').toLowerCase();
    return (!params.get('category') || item.category === params.get('category')) &&
      (!params.get('location') || item.location === params.get('location')) &&
      (!params.get('listing_type') || item.listing_type === params.get('listing_type')) &&
      (!params.get('opportunity') || item.opportunity_types.includes(params.get('opportunity'))) &&
      (!query || `${item.name} ${item.short_description} ${item.category}`.toLowerCase().includes(query));
  });
}
function serveBundle(res) {
  const source = fs.readFileSync(path.join(capture, 'scripts/nusantara-hub-8.preview.emergentagent.com/bundle.js'), 'utf8');
  const localBundle = source.replace('const API = `${"https://nusantara-hub-8.preview.emergentagent.com"}/api`;', 'const API = "/api";');
  text(res, 200, localBundle, 'application/javascript; charset=utf-8');
}
function servePage(res, page) {
  let source = fs.readFileSync(path.join(capture, 'pages', page), 'utf8');
  source = source.replace(/<script[^>]+(?:ap\.emergent\.sh|assets\.emergent\.sh|static\.cloudflareinsights\.com)[^>]*><\/script>/g, '');
  source = source.replace(/<script\b[^>]*>(?:(?!<\/script>)[\s\S])*(?:posthog\.init|__CF\$cv)(?:(?!<\/script>)[\s\S])*<\/script>/g, '');
  source = source.replace('src="/static/js/bundle.js"', 'src="/static/js/bundle.js"');
  text(res, 200, source, 'text/html; charset=utf-8');
}
function staticFile(res, relative) {
  const file = path.resolve(capture, relative);
  if (!file.startsWith(capture) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  const types = { '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
  text(res, 200, fs.readFileSync(file), types[ext] || 'application/octet-stream');
  return true;
}

async function api(req, res, url) {
  const route = url.pathname.slice(4);
  if (req.method === 'GET' && route === '/listings') return json(res, 200, filteredListings(url.searchParams));
  if (req.method === 'GET' && route === '/listings/meta') {
    const all = listings();
    return json(res, 200, { categories: [...new Set(all.map(x => x.category))], locations: [...new Set(all.map(x => x.location))], listing_types: [...new Set(all.map(x => x.listing_type))], opportunities: [...new Set(all.flatMap(x => x.opportunity_types))] });
  }
  if (req.method === 'GET' && route.startsWith('/listings/')) {
    const item = listings().find(x => x.slug === decodeURIComponent(route.slice(10)));
    return item ? json(res, 200, item) : json(res, 404, { detail: 'Listing not found' });
  }
  if (req.method === 'POST' && route === '/auth/login') {
    const input = await body(req);
    if (!input.email || !input.password) return json(res, 400, { detail: 'Email and password are required.' });
    const account = ACCOUNTS.find(acc => acc.email === String(input.email).toLowerCase());
    if (!account || !safeEqual(input.password, account.password)) {
      return json(res, 401, { detail: 'Invalid email or password.' });
    }
    const token = createSession({ id: account.id, name: account.name, email: account.email, role: account.role });
    return json(res, 200, { token, user: { id: account.id, name: account.name, email: account.email, role: account.role } });
  }
  if (req.method === 'POST' && route === '/inquiries') {
    const input = await body(req);
    if (!input.name || !input.email || !input.message) return json(res, 400, { detail: 'Name, email, and message are required.' });
    const record = { id: randomUUID(), ...input, status: 'new', created_at: new Date().toISOString() };
    const all = inquiries(); all.unshift(record); saveInquiries(all);
    return json(res, 201, record);
  }
  if (req.method === 'POST' && route === '/chat') {
    const input = await body(req);
    return json(res, 200, { reply: `Thank you for your message${input.message ? `: “${input.message}”` : ''}. Our local concierge demo can help you explore Indonesian products, experiences, and partnerships.` });
  }
  const currentUser = sessionUser(req);
  if (!currentUser) return json(res, 401, { detail: 'Sign in to use this dashboard.' });
  if (route.startsWith('/admin/') && currentUser.role !== 'admin') return json(res, 403, { detail: 'Admin access required.' });
  if (req.method === 'GET' && route === '/admin/stats') return json(res, 200, { listings: listings().length, inquiries: inquiries().length, partners: 1, published: listings().filter(x => x.is_published).length });
  if (req.method === 'GET' && route === '/admin/listings') return json(res, 200, listings());
  if (req.method === 'GET' && route === '/admin/inquiries') return json(res, 200, inquiries());
  if (req.method === 'GET' && route === '/partner/listings') return json(res, 200, listings());
  if (req.method === 'POST' && (route === '/admin/listings' || route === '/partner/listings')) {
    const input = await body(req); const item = { id: randomUUID(), featured: false, is_published: true, verification_status: 'pending', created_at: new Date().toISOString(), ...input };
    const all = listings(); all.unshift(item); saveListings(all); return json(res, 201, item);
  }
  const listingMatch = route.match(/^\/admin\/listings\/([^/]+)$/);
  if (listingMatch && ['PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const all = listings(); const index = all.findIndex(x => x.id === listingMatch[1]); if (index < 0) return json(res, 404, { detail: 'Listing not found' });
    if (req.method === 'DELETE') { all.splice(index, 1); saveListings(all); return json(res, 204, {}); }
    const input = await body(req); all[index] = { ...all[index], ...input }; saveListings(all); return json(res, 200, all[index]);
  }
  const inquiryMatch = route.match(/^\/admin\/inquiries\/([^/]+)$/);
  if (inquiryMatch && req.method === 'PATCH') {
    const all = inquiries(); const index = all.findIndex(x => x.id === inquiryMatch[1]); if (index < 0) return json(res, 404, { detail: 'Inquiry not found' });
    all[index] = { ...all[index], ...await body(req) }; saveInquiries(all); return json(res, 200, all[index]);
  }
  return json(res, 404, { detail: 'Local API endpoint not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/static/js/bundle.js') return serveBundle(res);
    if (url.pathname.startsWith('/assets/')) return staticFile(res, url.pathname.slice(1));
    if (url.pathname.startsWith('/images/')) return staticFile(res, `images/nusantara-hub-8.preview.emergentagent.com/${path.basename(url.pathname)}`) || text(res, 404, 'Image not found');
    if (htmlPages[url.pathname]) return servePage(res, htmlPages[url.pathname]);
    return servePage(res, 'index.html');
  } catch (error) {
    console.error(error); return json(res, 500, { detail: 'Local server error' });
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`House of Nusantara is running at http://localhost:${port}`));

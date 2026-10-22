// Couch Clash: zero-dependency authoritative game server (Node >= 18).
// Realtime = Server-Sent Events (server->client) + HTTPS POST (client->server). In-memory rooms.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const C = require('./content');
const MAX_PLAYERS = 12, ROOM_TTL = 3 * 3600e3;
const rooms = new Map();
const rnd = n => crypto.randomInt(n);
const tok = () => crypto.randomBytes(16).toString('hex');
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const AL = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const newCode = () => { for (;;) { let c = ''; for (let i = 0; i < 4; i++) c += AL[rnd(AL.length)]; if (!rooms.has(c)) return c; } };
const clean = (s, n) => String(s ?? '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, n);

const textGame = (secs, make, pub, valid, opts, score) => ({ secs, vote: true, make, pub, valid, opts, score });
const GAMES = {
  trivia: { name: 'Quiz Blitz', min: 1, secs: 15, vote: false,
    rules: ['Read the question on the TV', 'Tap your answer on your phone', 'Faster correct answers earn more points'],
    make: () => shuffle(C.trivia).slice(0, 8).map(x => ({ q: x.q, opts: x.o, ans: x.a })),
    pub: c => ({ q: c.q, opts: c.opts }),
    valid: (c, v) => Number.isInteger(v) && v >= 0 && v < c.opts.length,
    score(r) { const d = {}, counts = r.cur.opts.map(() => 0);
      for (const [id, s] of Object.entries(r.subs)) { counts[s.v]++;
        if (s.v === r.cur.ans) d[id] = Math.round(500 + 500 * (1 - Math.min(1, (s.t - r.start) / (r.secs * 1000)))); }
      return { deltas: d, info: { ans: r.cur.ans, counts } }; } },
  estimate: { name: 'Closest Wins', min: 1, secs: 25, vote: false,
    rules: ['A question has a number for an answer', 'Type your best estimate on your phone', 'Closest 1000, next 600, third 300'],
    make: () => shuffle(C.estimate).slice(0, 5).map(x => ({ q: x.q, unit: x.u, ans: x.a })),
    pub: c => ({ q: c.q, unit: c.unit }),
    valid: (c, v) => typeof v === 'number' && isFinite(v) && Math.abs(v) < 1e12,
    score(r) { const arr = Object.entries(r.subs).map(([id, s]) => ({ id, v: s.v, e: Math.abs(s.v - r.cur.ans), t: s.t })).sort((a, b) => a.e - b.e || a.t - b.t);
      const d = {}; arr.forEach((x, i) => { if (i < 3) d[x.id] = [1000, 600, 300][i]; });
      return { deltas: d, info: { ans: r.cur.ans, unit: r.cur.unit, guesses: arr.map(x => ({ id: x.id, v: x.v })) } }; } },
  bluff: { name: 'Fib Fest', min: 2, secs: 45, vote: true,
    rules: ['A weird question appears. Write a believable FAKE answer', 'Then vote for the answer you think is TRUE', 'Find the truth: 1000. Fool someone: 500 per vote'],
    make: () => shuffle(C.bluff).slice(0, 4).map(x => ({ q: x.q, truth: x.a })),
    pub: c => ({ q: c.q }),
    valid: (c, v) => typeof v === 'string' && v.length >= 1 && v.length <= 60 && v.toLowerCase() !== c.truth.toLowerCase(),
    opts: r => shuffle([{ owner: null, text: r.cur.truth }, ...Object.entries(r.subs).map(([id, s]) => ({ owner: id, text: s.v }))]),
    score(r) { const d = {}, add = (id, n) => d[id] = (d[id] || 0) + n;
      for (const [v, o] of Object.entries(r.votes)) { const op = r.opts[o]; if (op.owner === null) add(v, 1000); else add(op.owner, 500); }
      return { deltas: d, info: {} }; } },
  caption: { name: 'Caption Riot', min: 3, secs: 40, vote: true,
    rules: ['A silly scene appears on the TV', 'Write the funniest caption on your phone', 'Vote for your favorite (not your own). 500 per vote'],
    make: () => shuffle(C.caption).slice(0, 4).map(q => ({ q })),
    pub: c => ({ q: c.q }),
    valid: (c, v) => typeof v === 'string' && v.length >= 1 && v.length <= 80,
    opts: r => shuffle(Object.entries(r.subs).map(([id, s]) => ({ owner: id, text: s.v }))),
    score(r) { const d = {}; for (const o of Object.values(r.votes)) { const w = r.opts[o].owner; d[w] = (d[w] || 0) + 500; } return { deltas: d, info: {} }; } }
};

// ---- state machine: rules -> (submit -> [vote] -> reveal) x rounds -> final ----
function setPhase(r, phase, secs) {
  clearTimeout(r.timer); r.phase = phase; r.secs = secs || 0; r.start = Date.now(); r.deadline = secs ? r.start + secs * 1000 : 0;
  if (secs) r.timer = setTimeout(() => advance(r, phase), secs * 1000 + 50);
  push(r);
}
function startRound(r) { r.cur = r.rounds[r.round]; r.subs = {}; r.votes = {}; r.opts = null; r.deltas = {}; setPhase(r, 'submit', GAMES[r.game].secs); }
function advance(r, from) {
  if (r.phase !== from) return; // stale timer or double click: ignored, so points can never double-award
  const g = GAMES[r.game];
  if (from === 'rules') return startRound(r);
  if (from === 'submit') { if (g.vote) { r.opts = g.opts(r); if (r.opts.length >= 2) return setPhase(r, 'vote', 20); r.opts = null; } return reveal(r); }
  if (from === 'vote') return reveal(r);
  if (from === 'reveal') { r.round++; return r.round < r.rounds.length ? startRound(r) : setPhase(r, 'final', 0); }
}
function reveal(r) {
  const { deltas, info } = GAMES[r.game].score(r); r.deltas = deltas; r.info = info;
  for (const id in deltas) { const p = r.players.get(id); if (p) p.score += deltas[id]; }
  setPhase(r, 'reveal', GAMES[r.game].vote ? 10 : 7);
}
const live = r => [...r.players.values()].filter(p => p.on);
function maybeEarly(r) {
  const L = live(r); if (!L.length) return;
  if (r.phase === 'submit' && L.every(p => r.subs[p.id])) advance(r, 'submit');
  else if (r.phase === 'vote' && L.every(p => r.votes[p.id] !== undefined || r.opts.every(o => o.owner === p.id))) advance(r, 'vote');
}

// ---- views: the server decides what each device may see ----
function view(r, id) {
  const g = GAMES[r.game], inRound = ['submit', 'vote', 'reveal'].includes(r.phase);
  const v = { code: r.code, phase: r.phase, game: r.game, gname: g && g.name, rules: g && g.rules, round: r.round + 1, total: r.rounds.length,
    deadline: r.deadline, secs: r.secs, now: Date.now(), locked: r.locked, me: id, host: id === 'host',
    games: id === 'host' && r.phase === 'lobby' ? Object.entries(GAMES).map(([k, x]) => ({ id: k, name: x.name, min: x.min, d: x.rules[0] })) : undefined,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score, on: p.on,
      done: r.phase === 'submit' ? !!r.subs[p.id] : r.phase === 'vote' ? r.votes[p.id] !== undefined : false,
      delta: r.phase === 'reveal' ? (r.deltas[p.id] || 0) : 0 })) };
  if (inRound) {
    v.cur = g.pub(r.cur);
    if (r.phase === 'vote') { v.opts = r.opts.map((o, i) => ({ i, text: o.text, mine: o.owner === id })); v.myVote = r.votes[id]; }
    if (r.phase === 'reveal') { v.info = r.info; if (r.opts) v.opts = r.opts.map((o, i) => ({ i, text: o.text, owner: o.owner, truth: o.owner === null, votes: Object.keys(r.votes).filter(k => r.votes[k] === i) })); }
    if (r.phase === 'submit' && id !== 'host' && r.subs[id]) v.mine = r.subs[id].v;
  }
  return v;
}
function push(r) { for (const c of r.clients) { try { c.res.write('data: ' + JSON.stringify(view(r, c.id)) + '\n\n'); } catch {} } }

// ---- actions ----
function auth(r, id, t) { if (id === 'host') return t === r.hostKey; const p = r.players.get(id); return !!p && p.tok === t; }
function act(r, id, b) {
  const host = id === 'host';
  switch (b.type) {
    case 'start': case 'again': {
      if (!host || !(r.phase === 'lobby' || r.phase === 'final')) return 'Not allowed now';
      const key = b.type === 'again' ? r.game : b.game, g = GAMES[key]; if (!g) return 'Unknown game';
      if (live(r).length < g.min) return `${g.name} needs at least ${g.min} player${g.min > 1 ? 's' : ''}`;
      r.game = key; r.rounds = g.make(); r.round = 0; r.players.forEach(p => p.score = 0); r.subs = {}; r.votes = {}; r.deltas = {};
      return setPhase(r, 'rules', 12), null; }
    case 'next': if (!host || !['rules', 'submit', 'vote', 'reveal'].includes(r.phase)) return 'Not allowed'; advance(r, r.phase); return null;
    case 'lobby': if (!host) return 'Not allowed'; r.game = null; r.rounds = []; r.round = 0; setPhase(r, 'lobby', 0); return null;
    case 'lock': if (!host) return 'Not allowed'; r.locked = !r.locked; push(r); return null;
    case 'kick': { if (!host) return 'Not allowed'; const p = r.players.get(b.id); if (!p) return null; r.players.delete(b.id);
      for (const c of [...r.clients]) if (c.id === b.id) { c.res.write('event: gone\ndata: {}\n\n'); c.res.end(); r.clients.delete(c); } push(r); maybeEarly(r); return null; }
    case 'leave': if (host) return 'Not allowed'; r.players.delete(id); push(r); maybeEarly(r); return null;
    case 'submit': {
      if (host || r.phase !== 'submit' || Date.now() > r.deadline + 300) return 'Too late';
      if (r.subs[id]) return 'Already submitted';
      const g = GAMES[r.game]; let v = b.v; if (typeof v === 'string') v = clean(v, 100);
      if (!g.valid(r.cur, v)) return 'That answer is not allowed';
      r.subs[id] = { v, t: Date.now() }; push(r); maybeEarly(r); return null; }
    case 'vote': {
      if (host || r.phase !== 'vote' || Date.now() > r.deadline + 300) return 'Too late';
      if (r.votes[id] !== undefined) return 'Already voted';
      const o = r.opts[b.v]; if (!o) return 'Bad vote'; if (o.owner === id) return "You can't vote for your own";
      r.votes[id] = b.v; push(r); maybeEarly(r); return null; }
  }
  return 'Unknown action';
}

// ---- http ----
const hits = new Map();
const limited = ip => { const n = Date.now(), a = (hits.get(ip) || []).filter(t => n - t < 10000); a.push(n); hits.set(ip, a); return a.length > 120; };
const body = req => new Promise(res => { let s = ''; req.on('data', d => { s += d; if (s.length > 5000) req.destroy(); }); req.on('end', () => { try { res(JSON.parse(s || '{}')); } catch { res({}); } }); });
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
const AVATARS = ['🦊', '🐼', '🐸', '🦄', '🐙', '🐵', '🦖', '🐧', '🐝', '🦉', '🐳', '🐯'];

function handler(req, res) {
  const url = new URL(req.url, 'http://x'), ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (url.pathname === '/health') return json(res, 200, { ok: true, rooms: rooms.size });
  if (url.pathname === '/events' || url.pathname === '/state') {
    const r = rooms.get(url.searchParams.get('room')), id = url.searchParams.get('id'), t = url.searchParams.get('tok');
    const ok = r && auth(r, id, t);
    if (url.pathname === '/state') return ok ? json(res, 200, view(r, id)) : json(res, 404, { err: 'gone' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    if (!ok) { res.write('event: gone\ndata: {}\n\n'); return res.end(); }
    const c = { id, res }; r.clients.add(c); r.seen = Date.now();
    const p = r.players.get(id); if (p) p.on = true;
    res.write('retry: 1500\n\n'); res.write('data: ' + JSON.stringify(view(r, id)) + '\n\n'); if (p) push(r);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 20000);
    req.on('close', () => { clearInterval(hb); r.clients.delete(c); const q = r.players.get(id);
      if (q && ![...r.clients].some(x => x.id === id)) { q.on = false; push(r); maybeEarly(r); } });
    return;
  }
  if (req.method === 'POST') {
    if (limited(ip)) return json(res, 429, { err: 'Slow down' });
    return body(req).then(b => {
      if (url.pathname === '/create') {
        if (rooms.size > 500) return json(res, 503, { err: 'Server busy' });
        const r = { code: newCode(), hostKey: tok(), players: new Map(), clients: new Set(), phase: 'lobby', game: null, rounds: [], round: 0, cur: null, subs: {}, votes: {}, deltas: {}, opts: null, locked: false, seen: Date.now() };
        rooms.set(r.code, r); return json(res, 200, { room: r.code, id: 'host', tok: r.hostKey });
      }
      const r = rooms.get(clean(b.room, 8).toUpperCase());
      if (!r) return json(res, 404, { err: 'Room not found or expired' });
      r.seen = Date.now();
      if (url.pathname === '/join') {
        if (b.id && b.tok && auth(r, b.id, b.tok)) return json(res, 200, { room: r.code, id: b.id, tok: b.tok }); // rejoin
        if (r.locked) return json(res, 403, { err: 'This room is locked' });
        if (r.players.size >= MAX_PLAYERS) return json(res, 403, { err: 'Room is full' });
        let name = clean(b.name, 14) || 'Player', n = 1; const names = [...r.players.values()].map(p => p.name.toLowerCase());
        let base = name; while (names.includes(name.toLowerCase())) name = base + ' ' + (++n);
        const id = 'p' + tok().slice(0, 6), avatar = AVATARS.includes(b.avatar) ? b.avatar : AVATARS[rnd(AVATARS.length)];
        r.players.set(id, { id, tok: tok(), name, avatar, score: 0, on: false });
        return json(res, 200, { room: r.code, id, tok: r.players.get(id).tok });
      }
      if (url.pathname === '/act') {
        if (!auth(r, b.id, b.tok)) return json(res, 403, { err: 'Not authorized' });
        const err = act(r, b.id, b); return json(res, err ? 400 : 200, err ? { err } : { ok: true });
      }
      json(res, 404, { err: 'nope' });
    });
  }
  const f = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const fp = path.join(__dirname, 'public', path.normalize(f).replace(/^(\.\.[\/\\])+/, ''));
  if (!fp.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': fp.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' }); fs.createReadStream(fp).pipe(res);
}
function start(port) {
  const s = http.createServer(handler);
  setInterval(() => { for (const [c, r] of rooms) if (!r.clients.size && Date.now() - r.seen > 30 * 60e3 || Date.now() - r.seen > ROOM_TTL) { clearTimeout(r.timer); rooms.delete(c); } }, 60000).unref();
  return new Promise(ok => s.listen(port, () => ok(s)));
}
module.exports = { start, rooms };
if (require.main === module) start(process.env.PORT || 3000).then(() => console.log('Couch Clash on :' + (process.env.PORT || 3000)));

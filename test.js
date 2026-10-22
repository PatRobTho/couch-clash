const { test } = require('node:test'); const assert = require('node:assert'); const { start, rooms } = require('./server');
let base; const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { s: r.status, ...(await r.json()) }; };
const state = async x => (await fetch(`${base}/state?room=${x.room}&id=${x.id}&tok=${x.tok}`)).json();
test('full flow', async () => {
  const s = await start(0); base = 'http://localhost:' + s.address().port;
  const h = await post('/create', {}); assert.match(h.room, /^[A-Z]{4}$/);
  assert.equal((await post('/join', { room: 'ZZZZ', name: 'x' })).s, 404);
  const A = await post('/join', { room: h.room, name: 'Ann' }), B = await post('/join', { room: h.room, name: 'Ann' }), Cc = await post('/join', { room: h.room, name: 'Cy' });
  assert.equal((await state(h)).players.map(p => p.name).join(), 'Ann,Ann 2,Cy');
  rooms.get(h.room).players.forEach(p => p.on = true); // simulate open SSE connections
  const act = (who, b) => post('/act', { room: h.room, id: who.id, tok: who.tok, ...b });
  assert.equal((await act(A, { type: 'start', game: 'bluff' })).s, 400);             // players can't start
  assert.equal((await act({ id: 'host', tok: 'bad' }, { type: 'start', game: 'bluff' })).s, 403);
  assert.equal((await act(h, { type: 'start', game: 'bluff' })).s, 200);
  assert.equal((await act(h, { type: 'next' })).s, 200);                              // rules -> submit
  const r = rooms.get(h.room), truth = r.cur.truth;
  assert.equal((await act(A, { type: 'submit', v: truth })).s, 400);                  // can't submit the truth
  assert.equal((await act(A, { type: 'submit', v: 'Fake A' })).s, 200);
  assert.equal((await act(A, { type: 'submit', v: 'Again' })).s, 400);               // duplicate
  await act(B, { type: 'submit', v: 'Fake B' }); await act(Cc, { type: 'submit', v: 'Fake C' });
  const vs = await state(A); assert.equal(vs.phase, 'vote');                          // all submitted -> auto advance
  assert.ok(vs.opts.every(o => o.owner === undefined));                               // owners hidden
  const ti = r.opts.findIndex(o => o.owner === null), ai = r.opts.findIndex(o => o.owner === A.id);
  assert.equal((await act(A, { type: 'vote', v: ai })).s, 400);                       // no self vote
  await act(A, { type: 'vote', v: ti }); await act(B, { type: 'vote', v: ai }); await act(Cc, { type: 'vote', v: ai });
  const rv = await state(h); assert.equal(rv.phase, 'reveal');
  const sc = Object.fromEntries(rv.players.map(p => [p.name, p.score]));
  assert.equal(sc.Ann, 1000 + 1000);                                                  // truth vote + 2 bluff votes*500
  assert.equal(r.phase, 'reveal'); await act(h, { type: 'next' }); // reveal -> round 2
  assert.equal(r.round, 1);
  s.close(); process.exit(0);
});

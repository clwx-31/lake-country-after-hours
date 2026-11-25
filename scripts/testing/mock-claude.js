// Test double for the claude.ai artifact runtime (room, db, user), shared by
// every page of one browser context through BroadcastChannel + localStorage.
// Loaded with page.addInitScript; the page's ?uid= and ?name= pick the viewer.
(() => {
  const qs = new URLSearchParams(location.search);
  const uid = qs.get('uid');
  if (!uid) return;
  const NAMES = { u_alex: 'Alex', u_sam: 'Sam', u_jo: 'Jo' };
  const peerId = `p${Math.random().toString(36).slice(2, 10)}`;
  const bc = new BroadcastChannel('mock-claude');
  const freeze = (o) => Object.freeze(o);

  // ---------------- room
  const peers = new Map(); // peer -> { by, presence, updatedAt }
  let mine = {};
  const listeners = new Set();
  let pending = { joined: [], left: [], updated: [] }, scheduled = false;
  const snapshot = () => {
    const list = [freeze({ peer: peerId, by: uid, isMe: true, sameTab: true, kind: 'viewer', guest: false, presence: freeze({ ...mine }), updatedAt: Date.now() })];
    for (const [peer, p] of peers) list.push(freeze({ peer, by: p.by, isMe: false, sameTab: false, kind: 'viewer', guest: false, presence: p.presence, updatedAt: p.updatedAt }));
    return freeze(list);
  };
  const flush = () => {
    scheduled = false;
    const list = snapshot();
    const find = (ids) => list.filter((p) => ids.includes(p.peer));
    const change = { peers: list, joined: find(pending.joined), left: pending.left.map((peer) => ({ peer, by: null, isMe: false, sameTab: false, kind: 'viewer', guest: false, presence: {}, updatedAt: 0 })), updated: find(pending.updated) };
    pending = { joined: [], left: [], updated: [] };
    for (const h of listeners) h(change);
  };
  const queue = (kind, peer) => { if (!pending[kind].includes(peer)) pending[kind].push(peer); if (!scheduled) { scheduled = true; requestAnimationFrame(flush); } };
  bc.onmessage = (e) => {
    const m = e.data;
    if (m.kind === 'hello' && m.peer !== peerId) bc.postMessage({ kind: 'presence', peer: peerId, by: uid, presence: mine });
    if (m.kind === 'presence' && m.peer !== peerId) {
      const known = peers.has(m.peer);
      peers.set(m.peer, { by: m.by, presence: freeze({ ...m.presence }), updatedAt: Date.now() });
      queue(known ? 'updated' : 'joined', m.peer);
    }
    if (m.kind === 'bye' && peers.delete(m.peer)) queue('left', m.peer);
    if (m.kind === 'db') dbNotify(m.path);
  };
  addEventListener('pagehide', () => bc.postMessage({ kind: 'bye', peer: peerId }));
  const room = freeze({
    presence: async (patch) => {
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete mine[k]; else mine[k] = v; }
      if (JSON.stringify(mine).length > 4096) throw { code: 'invalid_argument', message: 'presence over 4 KiB' };
      bc.postMessage({ kind: 'presence', peer: peerId, by: uid, presence: mine });
    },
    peers: () => snapshot(),
    onPeers: (h) => { listeners.add(h); queue('joined', peerId); bc.postMessage({ kind: 'hello', peer: peerId }); return () => listeners.delete(h); },
    connected: () => true,
    onConnection: (h) => { setTimeout(() => h(true)); return () => {}; },
    emit: async () => {},
    on: () => () => {},
    join: async () => { throw { code: 'not_permitted' }; },
  });

  // ---------------- db (localStorage-backed, boards/<uid>[/ghosts/<ev>] only writable by that uid)
  const KEY = 'mock-claude-db';
  const load = () => JSON.parse(localStorage.getItem(KEY) || '{}');
  const save = (all) => localStorage.setItem(KEY, JSON.stringify(all));
  const subs = new Set();
  const docSnap = (path, data) => freeze({ id: path.split('/').pop(), exists: data !== undefined, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } });
  function dbNotify() { for (const s of subs) s(); }
  // Cross-tab localStorage syncs asynchronously: also refresh when it lands.
  addEventListener('storage', (e) => { if (e.key === KEY) dbNotify(); });
  const doc = (path) => ({
    id: path.split('/').pop(), path,
    get: async () => docSnap(path, load()[path]),
    set: async (data) => {
      const seg = path.split('/');
      if (seg[0] !== 'boards' || seg[1] !== uid) throw { code: 'invalid_argument', message: 'write denied' };
      const all = load(); all[path] = JSON.parse(JSON.stringify(data)); save(all);
      bc.postMessage({ kind: 'db', path }); dbNotify();
    },
    onSnapshot: (next) => { const run = () => next(docSnap(path, load()[path])); subs.add(run); setTimeout(run); return () => subs.delete(run); },
  });
  const collection = (cpath) => ({
    doc: (id) => doc(`${cpath}/${id}`),
    onSnapshot: (next) => {
      const run = () => {
        const all = load();
        const depth = cpath.split('/').length + 1;
        const docs = Object.keys(all).filter((p) => p.startsWith(cpath + '/') && p.split('/').length === depth).sort().map((p) => docSnap(p, all[p]));
        next(freeze({ docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false }, docChanges: () => [] }));
      };
      subs.add(run); setTimeout(run); return () => subs.delete(run);
    },
  });
  const db = freeze({ doc, collection });

  // ---------------- user
  const user = freeze({
    id: async () => uid,
    me: async () => ({ id: uid, name: NAMES[uid] ?? '', avatarUrl: '', color: '#ff7a3c', email: null, isOwner: uid === 'u_alex', canEdit: uid === 'u_alex' }),
    can: async () => true,
    isOwner: async () => uid === 'u_alex',
    canEdit: async () => uid === 'u_alex',
    profiles: async (ids) => Object.fromEntries([].concat(ids).map((id) => [id, { id, name: NAMES[id] ?? '', avatarUrl: '', color: id === 'u_alex' ? '#ff7a3c' : '#5aa8ff', email: null, isMe: id === uid, guest: false }])),
  });

  const caps = { room, db, user };
  window.claude = freeze({ use: async (name) => caps[name] ?? null });
})();

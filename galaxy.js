// ─── Generic helpers ───────────────────────────────────────────────────────
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function slug(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function lerp(a, b, t)    { return a + (b - a) * t; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerpRGB(c1, c2, t) {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ];
}
function hashJitter(seed, salt) {
  const x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}
// Stable numeric seed for any string id (FNV-1a) — used so a given host/sensor
// always lands at the same jitter offset regardless of poll-to-poll array order.
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ─── World model ─────────────────────────────────────────────────────────────
// Mirrors Icinga's shape: a group (hostgroup) contains hosts, a host runs
// several service checks. Every check is driven purely by Icinga's native
// state code (0=OK, 1=WARNING, 2=CRITICAL, 3=UNKNOWN) — we never look at the
// underlying perfdata value, so the same logic covers numeric, boolean, or
// text-based checks with no per-check configuration. 'offline' is a separate
// flag carried directly on each sensor by the data source (e.g. host is DOWN
// or the check hasn't reported), distinct from an active bad state.
const STATE_KEYS     = ['ok', 'warning', 'critical', 'unknown'];
const STATE_LABELS   = ['OK', 'WARNING', 'CRITICAL', 'UNKNOWN'];
const STATE_SEVERITY = [0, 0.55, 1, 0.8];

const FLARE_COLORS = {
  critical: [255, 70, 70],
  warning:  [255, 170, 60],
  unknown:  [170, 110, 255],
  offline:  [130, 140, 200],
};

function getSeverity(s) {
  return s.offline ? 1 : STATE_SEVERITY[s.state];
}
function sensorTier(s) {
  return s.offline ? 'offline' : STATE_KEYS[s.state];
}
// The synthetic per-host reachability sensor (added alongside whatever real
// services a host has) is binary — up or down — never warning/unknown, so it
// stays out of the random-roll paths that only make sense for service checks.
function isHostSensor(s) {
  return s.service === 'Host';
}
function setHostSensorState(s, down) {
  s.state  = down ? 2 : 0;
  s.output = down ? 'Host is DOWN' : 'Host is UP';
}
function normalizeStateCode(raw) {
  return Number.isFinite(raw) ? clamp(Math.round(raw), 0, 3) : 3; // malformed → UNKNOWN
}

const groups = [];
const hosts = [];
const hostsById = new Map();
const sensors = [];
const sensorsById = new Map();

// ─── Mock data generator ────────────────────────────────────────────────────
// Fills the world with synthetic hosts/checks so the visualization is usable
// standalone before (or whenever disconnected from) a live sensors.json feed.
const OUTPUT_PHRASES = [
  ['Check completed normally.', 'All parameters within range.', 'No issues detected.'],
  ['Approaching threshold.', 'Elevated but not critical.', 'Degraded performance detected.'],
  ['Threshold breached.', 'Check failed.', 'Immediate attention required.'],
  ['No data returned.', 'Check timed out.', 'Plugin returned unexpected output.'],
];

const GROUP_NAMES = [
  'Web Frontend', 'API Services', 'Database Cluster', 'Cache Layer',
  'Message Queue', 'Load Balancers', 'Storage Array', 'Network Core',
  'Auth Services', 'Batch Workers', 'CI/CD Pipeline', 'Edge / CDN',
];

const SERVICE_NAMES = [
  'CPU Load', 'Memory Usage', 'Disk Usage', 'Swap Usage', 'Latency',
  'Process Count', 'Queue Depth', 'HTTP Check', 'SSL Certificate', 'Ping',
];

function weightedStateRoll() {
  const r = Math.random();
  if (r < 0.90) return 0; // ok
  if (r < 0.96) return 1; // warning
  if (r < 0.99) return 2; // critical
  return 3;               // unknown
}

function setState(s, code) {
  s.state  = code;
  s.output = pick(OUTPUT_PHRASES[code]);
}

function applySensorRoll(s) { setState(s, weightedStateRoll()); }

function liveNudge(s) {
  if (Math.random() < 0.3) applySensorRoll(s);
}

function buildMockWorld() {
  groups.length = 0; hosts.length = 0; hostsById.clear();
  sensors.length = 0; sensorsById.clear();

  GROUP_NAMES.forEach((name, gi) => {
    const group = { id: gi, name, hostIds: [], sensorIds: [] };
    groups.push(group);
    const hostCount = randInt(4, 10);
    for (let h = 0; h < hostCount; h++) {
      const hostId = `${slug(name)}-${String(h + 1).padStart(2, '0')}`;
      const host = {
        id: hostId, groupId: gi, down: Math.random() < 0.015, sensorIds: [],
        seed: hashString(hostId), slot: h, slotCount: hostCount,
      };
      hosts.push(host);
      hostsById.set(hostId, host);
      group.hostIds.push(hostId);

      // Every host gets its own "Host" sensor representing overall
      // reachability, independent of whatever services it does or doesn't have.
      const hostSensorId = `${hostId}!host`;
      const hostSensor = {
        id: hostSensorId, groupId: gi, hostId,
        host: hostId, service: 'Host', state: 0, output: '',
        offline: host.down, seed: hashString(hostSensorId),
      };
      setHostSensorState(hostSensor, host.down);
      sensors.push(hostSensor);
      sensorsById.set(hostSensor.id, hostSensor);
      group.sensorIds.push(hostSensor.id);
      host.sensorIds.push(hostSensor.id);

      const svcCount = randInt(4, Math.min(8, SERVICE_NAMES.length));
      shuffle(SERVICE_NAMES).slice(0, svcCount).forEach(service => {
        const id = `${hostId}!${slug(service)}`;
        const sensor = {
          id, groupId: gi, hostId,
          host: hostId, service, state: 0, output: '',
          offline: host.down, seed: hashString(id),
        };
        applySensorRoll(sensor);
        sensors.push(sensor);
        sensorsById.set(sensor.id, sensor);
        group.sensorIds.push(sensor.id);
        host.sensorIds.push(sensor.id);
      });
    }
  });
}

// ─── Live data ingestion ─────────────────────────────────────────────────────
// Expected shape of the polled JSON (written by a separate Python poller that
// talks to the Icinga API — this page never talks to Icinga directly):
//   {
//     "hosts":   [ { "id": "web-01", "group": "Web Frontend", "down": false } ],
//     "sensors": [ { "id": "web-01!http", "host": "web-01", "service": "HTTP Check",
//                    "state": 0, "output": "HTTP OK", "offline": false } ],
//     "last_update": "2026-07-06T14:23:01-04:00"
//   }
// state is Icinga's native 0=OK/1=WARNING/2=CRITICAL/3=UNKNOWN code. 'offline'
// is the source's final word on whether the check is reporting at all (host
// down, stale, unreachable, etc.) — this page trusts it as-is and never tries
// to infer it. sensors[].id should be stable across polls (e.g. "host!service").
// last_update is the poller's local system time when it wrote the file (ISO 8601);
// optional so demo/older snapshots without it still work.
const DATA_URL = 'sensors.json';
const POLL_INTERVAL_MS = 30000;
let liveMode = false; // becomes true (and stays true) once a live poll succeeds
let lastFingerprint = null;
let lastUpdateTime = null; // last_update from the most recent successful live poll

function computeFingerprint(snapshot) {
  const ids = [];
  for (const h of snapshot.hosts) ids.push('h:' + h.id);
  for (const s of snapshot.sensors) ids.push('s:' + s.id);
  return ids.sort().join('|');
}

function rebuildWorldFromSnapshot(snapshot) {
  const hostsRaw = snapshot.hosts.map(h => ({ ...h, group: h.group || 'Ungrouped' }));
  const groupNames = [...new Set(hostsRaw.map(h => h.group))].sort();

  groups.length = 0;
  groupNames.forEach((name, gi) => groups.push({ id: gi, name, hostIds: [], sensorIds: [] }));
  const groupIndexByName = new Map(groupNames.map((name, i) => [name, i]));

  const hostsByGroup = new Map(groupNames.map(name => [name, []]));
  hostsRaw.forEach(h => hostsByGroup.get(h.group).push(h));

  hosts.length = 0;
  hostsById.clear();
  groupNames.forEach(name => {
    const gi = groupIndexByName.get(name);
    const bucket = hostsByGroup.get(name).slice().sort((a, b) => a.id.localeCompare(b.id));
    bucket.forEach((raw, slot) => {
      const host = {
        id: raw.id, groupId: gi, down: !!raw.down, sensorIds: [],
        seed: hashString(raw.id), slot, slotCount: bucket.length,
      };
      hosts.push(host);
      hostsById.set(host.id, host);
      groups[gi].hostIds.push(host.id);
    });
  });

  sensors.length = 0;
  sensorsById.clear();
  snapshot.sensors.forEach(raw => {
    const host = hostsById.get(raw.host);
    if (!host) return; // sensor references a host not present in this snapshot
    const sensor = {
      id: raw.id, groupId: host.groupId, hostId: host.id,
      host: host.id, service: raw.service || 'Check',
      state: normalizeStateCode(raw.state),
      output: raw.output || '',
      offline: !!raw.offline,
      seed: hashString(raw.id),
    };
    sensors.push(sensor);
    sensorsById.set(sensor.id, sensor);
    groups[host.groupId].sensorIds.push(sensor.id);
    host.sensorIds.push(sensor.id);
  });

  computeLayout();
  spawnParticles();

  // latestStats/latestFlares are otherwise only refreshed every 6 frames by
  // the draw loop's throttle — without this, the very next frame after a
  // rebuild would still hold flare references into the *old* sensor set,
  // whose hostId values may no longer exist in the just-replaced hostsById.
  latestStats  = recomputeStats();
  latestFlares = computeFlares();
  statsFrameCounter = 0;
  updateSummaryBar(latestStats.counts);
}

function applyIncrementalUpdate(snapshot) {
  snapshot.hosts.forEach(raw => {
    const host = hostsById.get(raw.id);
    if (host) host.down = !!raw.down;
  });
  snapshot.sensors.forEach(raw => {
    const sensor = sensorsById.get(raw.id);
    if (!sensor) return;
    sensor.state   = normalizeStateCode(raw.state);
    sensor.output  = raw.output || '';
    sensor.offline = !!raw.offline;
  });
}

function formatLastUpdate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function setDataStatus(mode) {
  if (mode === 'live') liveMode = true;
  const el = document.getElementById('data-status');
  el.className = mode;
  const stamp = lastUpdateTime ? formatLastUpdate(lastUpdateTime) : '';
  el.textContent = mode === 'live' ? 'Live · Icinga' + (stamp ? ` · updated ${stamp}` : '')
    : mode === 'disconnected' ? 'Disconnected — showing last known state' + (stamp ? ` (as of ${stamp})` : '')
    : 'Demo data';
  document.querySelectorAll('#scenario-bar button').forEach(b => { b.disabled = liveMode; });
  document.getElementById('console').classList.toggle('minimal', liveMode);
}

async function pollSnapshot() {
  try {
    const res = await fetch(DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const snapshot = await res.json();
    if (!snapshot || !Array.isArray(snapshot.hosts) || !Array.isArray(snapshot.sensors)) {
      throw new Error('malformed snapshot');
    }

    const wasLive = liveMode;
    const fp = computeFingerprint(snapshot);
    if (fp !== lastFingerprint) {
      rebuildWorldFromSnapshot(snapshot);
      lastFingerprint = fp;
    } else {
      applyIncrementalUpdate(snapshot);
    }
    if (snapshot.last_update) lastUpdateTime = snapshot.last_update;
    setDataStatus('live');
    if (!wasLive) {
      state.expandedId = null;
      toast(`Connected to live Icinga data (${sensors.length} checks)`);
    }
    renderList();
  } catch (err) {
    setDataStatus(liveMode ? 'disconnected' : 'demo');
  }
}

// Shared by recomputeStats (ambient push) and computeFlares (marker cap) so the
// two stay tied to the same per-group budget instead of drifting apart.
function flareCapFor(group) {
  return Math.min((group.sensorIds.length || 1) * 0.5, 10);
}

function recomputeStats() {
  const groupSum     = new Float64Array(groups.length);
  const groupCrit     = new Float64Array(groups.length);
  const groupBad      = new Float64Array(groups.length);
  const groupOffline = new Float64Array(groups.length);
  const groupN        = new Float64Array(groups.length);
  const counts = { ok: 0, warning: 0, critical: 0, unknown: 0, offline: 0 };
  let globalBadSum = 0;

  for (const s of sensors) {
    const sev  = getSeverity(s);
    const tier = sensorTier(s);
    counts[tier]++;
    groupN[s.groupId]++;
    groupSum[s.groupId] += sev;
    if (s.offline) groupOffline[s.groupId]++;
    else if (sev >= 0.85) groupCrit[s.groupId]++;
    // Same eligibility test computeFlares uses (sev >= 0.45, offline excluded —
    // offline already drives its own contraction signal below).
    if (!s.offline && sev >= 0.45) groupBad[s.groupId]++;
    globalBadSum += s.offline ? 0.6 : sev;
  }

  // capPressure is "how close is this group to the point where its individual
  // flare markers get dropped for being too crowded" (0 = none, 1 = at/over the
  // cap). Blending it into dev means low-severity incidents (mostly WARNING,
  // which barely move the severity-average terms below) still visibly push the
  // arm outward right around the same threshold where their markers disappear,
  // instead of the flares vanishing with no ambient effect to replace them.
  const groupDev = groups.map((g, i) => {
    const n = groupN[i] || 1;
    const capPressure = clamp(groupBad[i] / flareCapFor(g), 0, 1) * .6;
    return clamp((groupSum[i] / n) * 0.55 + (groupCrit[i] / n) * 0.9 + capPressure * 0.35, 0, 1);
  });
  const groupOfflineFrac = groups.map((g, i) => groupN[i] ? groupOffline[i] / groupN[i] : 0);

  return {
    groupDev, groupOfflineFrac, counts,
    avgBad: sensors.length ? globalBadSum / sensors.length : 0,
  };
}

// Per-group cap, not global: each group's flares are judged only against its
// own size (50% of the group's sensors, capped at 8). Past that, an
// arbitrary slice of individual flares reads as noisy/random rather than
// informative — drop that group's flares entirely and let its own glow/
// contraction effects (driven independently of this list) carry the
// "widespread incident" visual instead. A handful of scattered issues across
// many groups still shows real flares in each of them; a group melting down
// on its own falls back to the ambient effect once it crosses its own cap.
function computeFlares() {
  const byGroup = new Map();
  for (const s of sensors) {
    const sev = getSeverity(s);
    if (!s.offline && sev < 0.45) continue;
    if (!byGroup.has(s.groupId)) byGroup.set(s.groupId, []);
    byGroup.get(s.groupId).push({ s, sev });
  }

  const result = [];
  for (const [groupId, scored] of byGroup) {
    const cap = flareCapFor(groups[groupId]);
    if (scored.length > cap) continue;
    result.push(...scored);
  }
  result.sort((a, b) => b.sev - a.sev);
  return result;
}

// ─── Console: filter / search / row rendering ──────────────────────────────
const state = { query: '', tierFilter: 'all', expandedId: null, focusedId: null };
const listEl = document.getElementById('sensor-list');

function getFilteredSorted() {
  const q = state.query.trim().toLowerCase();
  let list = sensors;
  if (state.tierFilter !== 'all') list = list.filter(s => sensorTier(s) === state.tierFilter);
  if (q) {
    list = list.filter(s =>
      s.host.toLowerCase().includes(q) ||
      s.service.toLowerCase().includes(q) ||
      groups[s.groupId].name.toLowerCase().includes(q)
    );
  }
  return list.slice().sort((a, b) => {
    if (state.focusedId === a.id) return -1;
    if (state.focusedId === b.id) return 1;
    return getSeverity(b) - getSeverity(a);
  });
}

function valueText(s) {
  return s.offline ? 'OFFLINE' : STATE_LABELS[s.state];
}

function rowControlsHtml(s) {
  let html = `<div class="row-controls"><div class="row-output">${escapeHtml(s.output)}</div>`;
  if (liveMode) {
    html += `<div class="row-readonly-note">Live data — read only</div>`;
  } else {
    if (!s.offline) {
      html += `<div class="row-state-buttons" data-id="${escapeHtml(s.id)}">` +
        STATE_KEYS.map((key, code) =>
          `<button class="state-btn${s.state === code ? ' active' : ''}" data-state="${code}">${key}</button>`
        ).join('') + `</div>`;
    }
    html += `<button class="offline-btn${s.offline ? ' active' : ''}" data-id="${escapeHtml(s.id)}">
      ${s.offline ? 'Bring Online' : 'Take Offline'}</button>`;
  }
  html += `</div>`;
  return html;
}

function rowHtml(s) {
  const tier     = sensorTier(s);
  const expanded = state.expandedId === s.id;
  let html = `<div class="sensor-row tier-${tier}${expanded ? ' expanded' : ''}" data-id="${escapeHtml(s.id)}">
    <div class="row-main">
      <span class="row-dot"></span>
      <span class="row-host">${escapeHtml(s.host)}</span>
      <span class="row-service">${escapeHtml(s.service)}</span>
      <span class="row-val">${valueText(s)}</span>
    </div>`;
  if (expanded) html += rowControlsHtml(s);
  html += `</div>`;
  return html;
}

function renderList() {
  const list = getFilteredSorted();
  document.getElementById('list-count').textContent = list.length;
  listEl.innerHTML = list.map(rowHtml).join('');
  if (state.focusedId != null) {
    const el = listEl.querySelector(`.sensor-row[data-id="${state.focusedId}"]`);
    if (el) {
      el.classList.add('focused');
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

function renderRowOnly(id) {
  const el = listEl.querySelector(`.sensor-row[data-id="${id}"]`);
  if (!el) return;
  const s = sensorsById.get(id);
  const wrapper = document.createElement('div');
  wrapper.innerHTML = rowHtml(s).trim();
  el.replaceWith(wrapper.firstChild);
}

function updateRowInPlace(id) {
  const el = listEl.querySelector(`.sensor-row[data-id="${id}"]`);
  if (!el) return;
  const s = sensorsById.get(id);
  const tier = sensorTier(s);
  el.className = 'sensor-row tier-' + tier +
    (state.expandedId === id ? ' expanded' : '') +
    (state.focusedId  === id ? ' focused'  : '');
  el.querySelector('.row-val').textContent = valueText(s);
}

listEl.addEventListener('click', e => {
  const stateBtn = e.target.closest('.state-btn');
  if (stateBtn) {
    const id = stateBtn.closest('.row-state-buttons').dataset.id;
    setState(sensorsById.get(id), Number(stateBtn.dataset.state));
    renderRowOnly(id);
    return;
  }

  const offlineBtn = e.target.closest('.offline-btn');
  if (offlineBtn) {
    const id = offlineBtn.dataset.id;
    const s = sensorsById.get(id);
    s.offline = !s.offline;
    renderRowOnly(id);
    return;
  }

  const row = e.target.closest('.sensor-row');
  if (row) {
    const id = row.dataset.id;
    state.expandedId = state.expandedId === id ? null : id;
    renderList();
  }
});

document.getElementById('search-input').addEventListener('input', e => {
  state.query = e.target.value;
  renderList();
});

document.querySelectorAll('#tier-chips .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    state.tierFilter = chip.dataset.tier;
    document.querySelectorAll('#tier-chips .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    renderList();
  });
});

function focusSensor(id) {
  state.query = '';
  document.getElementById('search-input').value = '';
  state.tierFilter = 'all';
  document.querySelectorAll('#tier-chips .chip').forEach(c => c.classList.toggle('active', c.dataset.tier === 'all'));
  state.expandedId = id;
  state.focusedId  = id;
  renderList();
}

// ─── Scenario buttons (demo data only — disabled once live data connects) ──
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

document.getElementById('btn-randomize').addEventListener('click', () => {
  hosts.forEach(host => {
    host.down = Math.random() < 0.015;
    host.sensorIds.forEach(id => {
      const s = sensorsById.get(id);
      s.offline = host.down;
      if (isHostSensor(s)) setHostSensorState(s, host.down);
      else if (!host.down) applySensorRoll(s);
    });
  });
  state.expandedId = null;
  renderList();
  toast('Randomized all sensor states');
});

document.getElementById('btn-incident').addEventListener('click', () => {
  const group = pick(groups);
  const candidates = group.sensorIds.filter(id => !isHostSensor(sensorsById.get(id)));
  const affected = shuffle(candidates).slice(0, Math.ceil(candidates.length * (0.4 + Math.random() * 0.3)));
  affected.forEach(id => {
    const s = sensorsById.get(id);
    if (s.offline) return;
    setState(s, Math.random() < 0.7 ? 2 : 1);
  });
  renderList();
  toast(`Simulated incident: ${group.name}`);
});

document.getElementById('btn-hostdown').addEventListener('click', () => {
  const candidates = hosts.filter(h => !h.down);
  if (!candidates.length) return;
  const host = pick(candidates);
  host.down = true;
  host.sensorIds.forEach(id => { sensorsById.get(id).offline = true; });
  renderList();
  toast(`Host down: ${host.id}`);
});

document.getElementById('btn-reset').addEventListener('click', () => {
  hosts.forEach(h => { h.down = false; });
  sensors.forEach(s => {
    s.offline = false;
    if (isHostSensor(s)) setHostSensorState(s, false);
    else setState(s, 0);
  });
  state.expandedId = null;
  renderList();
  toast('All sensors reset to nominal');
});

// Subtle background telemetry drift so demo data feels alive at rest. Never
// runs once live data has connected — we don't fabricate motion on top of reality.
setInterval(() => {
  if (liveMode) return;
  const n = randInt(1, 3);
  for (let i = 0; i < n; i++) {
    const s = pick(sensors);
    if (s.offline || isHostSensor(s)) continue;
    liveNudge(s);
    updateRowInPlace(s.id);
  }
}, 2500);

// ─── Canvas setup ─────────────────────────────────────────────────────────────
const canvas = document.getElementById('galaxy');
const ctx    = canvas.getContext('2d');
let W, H, CX, CY, SCALE;

function resize() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width  || 800;
  const h = rect.height || 450;
  canvas.width  = w * devicePixelRatio;
  canvas.height = h * devicePixelRatio;
  W = canvas.width; H = canvas.height;
  CX = W / 2; CY = H / 2;
  // Scaled off height, not width: the tilt flattens the disc vertically, so
  // height is the tighter dimension the galaxy needs to fill in a landscape frame.
  SCALE = H / 230;
}
resize();
window.addEventListener('resize', () => { resize(); spawnParticles(); });

// ─── 3D projection ─────────────────────────────────────────────────────────
const TILT  = 1.08;   // radians: 0 = top-down, PI/2 = edge-on
const FOCAL = 900;    // perspective focal length in base pixels
const cosTilt = Math.cos(TILT);
const sinTilt = Math.sin(TILT);

function project3D(gx, gy, gz) {
  const fy = gy * cosTilt - gz * sinTilt;
  const fz = gy * sinTilt + gz * cosTilt;
  const focal = FOCAL * SCALE;
  const ps    = focal / (focal + fz);
  return { sx: CX + gx * ps, sy: CY + fy * ps, ps, fz };
}

// ─── Particles ────────────────────────────────────────────────────────────────
// Each wedge of the spiral represents a GROUP, not an individual sensor —
// with 500+ sensors, one wedge per sensor would be unreadable. Wedge angular
// width is weighted by sqrt(group size) so larger groups read as wider arcs.
const PARTICLE_COUNT = 2000;
const THETA_MIN = 0.5, THETA_MAX = 5.0;
const particles = [];

let wedgeWeights = [];
let wedgeBounds  = [];
let groupArm     = [];
let smoothDev     = [];
let smoothOffline = [];

// Lays out wedge angular bounds per group, then anchors each host to a fixed
// slot within its group's arc (evenly spaced by index, not random) so a
// host's services always render in the same small patch of sky — a host in
// trouble reads as one cluster of flares, not scattered dots. Each group is
// assigned to a single arm (greedily, by descending weight, to whichever arm
// currently has less total weight) so a group's activity clumps into one
// spot on one arm instead of being split/mirrored across both. Re-run
// whenever the group/host/sensor topology changes (initial load, or a live
// rebuild).
function computeLayout() {
  const w = groups.map(g => Math.sqrt(g.sensorIds.length || 1));
  const total = w.reduce((a, b) => a + b, 0) || 1;
  wedgeWeights = w.map(x => x / total);

  const order = groups.map((g, i) => i).sort((a, b) => w[b] - w[a]);
  const armWeight = [0, 0];
  groupArm = groups.map(() => 0);
  order.forEach(i => {
    const arm = armWeight[0] <= armWeight[1] ? 0 : 1;
    groupArm[i] = arm;
    armWeight[arm] += w[i];
  });
  const armTotal = [0, 1].map(arm =>
    groups.reduce((sum, g, i) => sum + (groupArm[i] === arm ? w[i] : 0), 0) || 1
  );

  wedgeBounds = [];
  const armAcc = [THETA_MIN, THETA_MIN];
  groups.forEach((g, i) => {
    const arm = groupArm[i];
    const span = (THETA_MAX - THETA_MIN) * (w[i] / armTotal[arm]);
    wedgeBounds.push([armAcc[arm], armAcc[arm] + span]);
    armAcc[arm] += span;
  });

  hosts.forEach(host => {
    const [lo, hi] = wedgeBounds[host.groupId];
    const span = hi - lo;
    const frac = (host.slot + 0.5) / host.slotCount;
    host.theta     = lo + frac * span;
    host.slotWidth = span / host.slotCount;
    host.armPick   = groupArm[host.groupId];
  });

  smoothDev     = groups.map(() => 0);
  smoothOffline = groups.map(() => 0);
}

function pickWedge() {
  const r = Math.random();
  let acc = 0;
  for (let i = 0; i < wedgeWeights.length; i++) {
    acc += wedgeWeights[i];
    if (r <= acc) return i;
  }
  return wedgeWeights.length - 1;
}

function makeParticle() {
  const wedge = pickWedge();
  const arm = groupArm[wedge];
  const [lo, hi] = wedgeBounds[wedge];
  const theta = lo + Math.random() * (hi - lo);
  return {
    arm, theta, wedge,
    z            : (Math.random() - 0.5) * 20,
    radialJitter : (Math.random() - 0.5) * 22,
    angularJitter: (Math.random() - 0.5) * 0.12,
    size         : 0.4 + Math.random() * 1.4,
    brightness   : 0.3 + Math.random() * 0.7,
    noisePhase   : Math.random() * Math.PI * 2,
    noiseSpeed   : 0.008 + Math.random() * 0.012,
  };
}

function spawnParticles() {
  particles.length = 0;
  for (let i = 0; i < PARTICLE_COUNT; i++) particles.push(makeParticle());
}

const DUST_COUNT = 320;
const dust = Array.from({ length: DUST_COUNT }, () => ({
  angle     : Math.random() * Math.PI * 2,
  r         : Math.pow(Math.random(), 2) * 115,
  z         : (Math.random() - 0.5) * 14,
  orbitSpeed: (0.0002 + Math.random() * 0.0003) * (Math.random() < 0.5 ? 1 : -1),
  size      : 0.3 + Math.random() * 0.9,
  brightness: 0.05 + Math.random() * 0.15,
}));

const BLUE_WHITE = [200, 215, 255];
const ORANGE     = [255, 120,  40];
const RED_HOT    = [230,  40,  30];
const DEAD       = [ 28,  22,  52];

// ─── Tooltip / hit-testing for flare markers ───────────────────────────────
const tooltipEl = document.getElementById('canvas-tooltip');
let flareScreenPositions = [];

function hitTestFlare(e) {
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const my = (e.clientY - rect.top) * (canvas.height / rect.height);
  let best = null, bestD = Infinity;
  for (const f of flareScreenPositions) {
    const d = Math.hypot(f.sx - mx, f.sy - my);
    if (d < Math.max(f.r, 10 * SCALE) && d < bestD) { best = f; bestD = d; }
  }
  return best;
}

function showTooltip(hit, clientX, clientY) {
  const s = sensorsById.get(hit.id);
  const tier = sensorTier(s);
  const detail = s.offline ? 'Host unreachable.' : s.output;
  tooltipEl.innerHTML = `<b>${escapeHtml(s.host)}</b><br>${escapeHtml(s.service)} — <span class="tt-${tier}">${valueText(s)}</span><br>${escapeHtml(detail)}`;
  const wrapRect = document.getElementById('canvas-wrap').getBoundingClientRect();
  tooltipEl.style.left = `${clientX - wrapRect.left + 14}px`;
  tooltipEl.style.top  = `${clientY - wrapRect.top + 14}px`;
  tooltipEl.style.display = 'block';
}
function hideTooltip() { tooltipEl.style.display = 'none'; }

canvas.addEventListener('mousemove', e => {
  const hit = hitTestFlare(e);
  if (hit) { showTooltip(hit, e.clientX, e.clientY); canvas.style.cursor = 'pointer'; }
  else     { hideTooltip(); canvas.style.cursor = 'default'; }
});
canvas.addEventListener('mouseleave', hideTooltip);
canvas.addEventListener('click', e => {
  const hit = hitTestFlare(e);
  if (hit) focusSensor(hit.id);
});

// ─── Draw loop ────────────────────────────────────────────────────────────────
let time = 0;
let latestStats  = null;
let latestFlares = [];
let statsFrameCounter = 0;

function updateSummaryBar(counts) {
  document.getElementById('sum-ok').textContent       = counts.ok;
  document.getElementById('sum-warning').textContent  = counts.warning;
  document.getElementById('sum-critical').textContent = counts.critical;
  document.getElementById('sum-unknown').textContent  = counts.unknown;
  document.getElementById('sum-offline').textContent  = counts.offline;
}

function draw() {
  time += 1;
  statsFrameCounter++;
  if (statsFrameCounter >= 6) {
    statsFrameCounter = 0;
    latestStats  = recomputeStats();
    latestFlares = computeFlares();
    updateSummaryBar(latestStats.counts);
  }

  groups.forEach((g, i) => {
    smoothDev[i]     = lerp(smoothDev[i],     latestStats.groupDev[i],         0.04);
    smoothOffline[i] = lerp(smoothOffline[i], latestStats.groupOfflineFrac[i], 0.04);
  });

  const coreHealth = clamp(1 - latestStats.avgBad * 2, 0, 1);

  // Background
  ctx.fillStyle = '#06070f';
  ctx.fillRect(0, 0, W, H);

  if (!draw._bgStars) {
    draw._bgStars = Array.from({ length: 180 }, () => ({
      x: Math.random(), y: Math.random(),
      size: 0.2 + Math.random() * 0.6,
      a: 0.1 + Math.random() * 0.35,
    }));
  }
  for (const s of draw._bgStars) {
    ctx.beginPath();
    ctx.arc(s.x * W, s.y * H, s.size * SCALE, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(160,170,220,${s.a})`;
    ctx.fill();
  }

  // Core haze
  const hr = Math.round(lerp(10, 50, 1 - coreHealth));
  const hg = Math.round(lerp(12, 10, 1 - coreHealth));
  const hb = Math.round(lerp(35, 10, 1 - coreHealth));
  const hazeR = 155 * SCALE;
  const hazeGrd = ctx.createRadialGradient(0, 0, 0, 0, 0, hazeR);
  hazeGrd.addColorStop(0, `rgba(${hr},${hg},${hb},0.22)`);
  hazeGrd.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.translate(CX, CY);
  ctx.scale(1, Math.abs(cosTilt));
  ctx.fillStyle = hazeGrd;
  ctx.beginPath();
  ctx.arc(0, 0, hazeR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Core dust
  for (const d of dust) {
    d.angle += d.orbitSpeed;
    const gx = Math.cos(d.angle) * d.r * SCALE;
    const gy = Math.sin(d.angle) * d.r * SCALE;
    const gz = d.z * SCALE;
    const { sx, sy, ps, fz } = project3D(gx, gy, gz);

    const depthFade = clamp(1 - fz / (380 * SCALE), 0.3, 1);
    const dr = Math.round(lerp(55, 28, 1 - coreHealth));
    const dg = Math.round(lerp(65, 18, 1 - coreHealth));
    const db = Math.round(lerp(108, 22, 1 - coreHealth));
    ctx.beginPath();
    ctx.arc(sx, sy, d.size * SCALE * ps, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${dr},${dg},${db},${(d.brightness * depthFade).toFixed(3)})`;
    ctx.fill();
  }

  // Spiral particles
  const growth  = 30 * SCALE;
  const baseR   = 18 * SCALE;
  const rotTime = -time * 0.0005;

  for (const p of particles) {
    const dev    = smoothDev[p.wedge];
    const offAmt = smoothOffline[p.wedge];
    const noise  = Math.sin(p.noisePhase + time * p.noiseSpeed) * 0.5 + 0.5;

    const angle  = p.theta + p.angularJitter + p.arm * Math.PI + rotTime;
    const idealR = baseR + growth * p.theta;

    const contractFactor = lerp(1.0, 0.25 + noise * 0.1, offAmt);
    const push = dev * 90 * SCALE * (0.65 + noise * 0.35);

    const r = (idealR + p.radialJitter * SCALE) * contractFactor + push;

    const gx = Math.cos(angle) * r;
    const gy = Math.sin(angle) * r;
    const gz = p.z * SCALE;

    const { sx, sy, ps, fz } = project3D(gx, gy, gz);
    const depthFade = clamp(1 - fz / (420 * SCALE), 0.35, 1.0);

    let rgb, alpha;
    if (offAmt > 0.01) {
      rgb   = lerpRGB(BLUE_WHITE, DEAD, offAmt);
      alpha = p.brightness * lerp(1, 0.08 + noise * 0.1, offAmt) * depthFade;
    } else if (dev > 0.01) {
      const t2 = clamp(dev * 1.2, 0, 1);
      rgb   = t2 < 0.5
        ? lerpRGB(BLUE_WHITE, ORANGE,   t2 * 2)
        : lerpRGB(ORANGE,     RED_HOT, (t2 - 0.5) * 2);
      alpha = p.brightness * (0.5 + 0.5 * noise) * depthFade;
    } else {
      rgb   = BLUE_WHITE;
      alpha = p.brightness * (0.5 + noise * 0.35) * depthFade;
    }

    const drawSize = p.size * SCALE * clamp(ps, 0.7, 1.4);

    ctx.beginPath();
    ctx.arc(sx, sy, drawSize, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(3)})`;
    ctx.fill();
  }

  // Flare markers — the worst individual sensors. Each anchors to its host's
  // fixed slot (not the whole group arc), so a host with multiple failing
  // checks clumps into one visible cluster instead of scattering across the arm.
  flareScreenPositions = [];
  for (const { s, sev } of latestFlares) {
    const host = hostsById.get(s.hostId);
    const theta = host.theta + (hashJitter(s.seed, 1) - 0.5) * host.slotWidth * 0.7;
    const idealR = baseR + growth * theta;
    const radialJ = (hashJitter(s.seed, 3) - 0.5) * 22 * SCALE;
    const angle = theta + host.armPick * Math.PI + rotTime;
    const r = idealR + radialJ;

    const gx = Math.cos(angle) * r;
    const gy = Math.sin(angle) * r;
    const gz = (hashJitter(s.seed, 4) - 0.5) * 16 * SCALE;
    const { sx, sy, ps } = project3D(gx, gy, gz);

    const pulse = 0.5 + 0.5 * Math.sin(time * 0.05 + hashJitter(s.seed, 5) * Math.PI * 2);
    const tier  = sensorTier(s);
    const color = FLARE_COLORS[tier] || FLARE_COLORS.critical;
    const baseSize = (tier === 'offline' ? 3.2 : 2.6 + sev * 1.8) * SCALE * clamp(ps, 0.7, 1.5);

    ctx.beginPath();
    ctx.arc(sx, sy, baseSize * (2.2 + pulse * 0.8), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${(0.10 + pulse * 0.10).toFixed(3)})`;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(sx, sy, baseSize, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${color[0]},${color[1]},${color[2]},${(0.75 + pulse * 0.25).toFixed(3)})`;
    ctx.fill();

    flareScreenPositions.push({ id: s.id, sx, sy, r: baseSize * 3 + 6 * SCALE });
  }

  // Nucleus halo
  const nucleusR  = 48 * SCALE;
  const innerRGB  = lerpRGB([255, 255, 255], [255, 120, 100], clamp(latestStats.avgBad * 2,   0, 1));
  const midRGB    = lerpRGB([140, 160, 255], [200,  40,  40], clamp(latestStats.avgBad * 1.5, 0, 1));

  ctx.save();
  ctx.translate(CX, CY);
  ctx.scale(1, Math.abs(cosTilt));
  const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, nucleusR);
  grd.addColorStop(0,    `rgba(${innerRGB[0]},${innerRGB[1]},${innerRGB[2]},0.95)`);
  grd.addColorStop(0.08, `rgba(${innerRGB[0]},${innerRGB[1]},${innerRGB[2]},0.75)`);
  grd.addColorStop(0.25, `rgba(${midRGB[0]},${midRGB[1]},${midRGB[2]},0.35)`);
  grd.addColorStop(0.55, `rgba(${midRGB[0]},${midRGB[1]},${midRGB[2]},0.08)`);
  grd.addColorStop(1,    'rgba(0,0,0,0)');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(0, 0, nucleusR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  requestAnimationFrame(draw);
}
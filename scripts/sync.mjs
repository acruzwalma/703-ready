// Runs inside GitHub Actions (daily, or when you press "Run workflow").
// 1. First time only: exchanges the Whoop code you paste for tokens.
// 2. Refreshes the Whoop token, pulls recovery / sleep / cycles / workouts.
// 3. Optionally pulls Garmin activities from Intervals.icu.
// 4. Writes everything encrypted to data/ so the app can read it.
import fs from "node:fs";
import { seal, open } from "./vault.mjs";
import { extract } from "./cal.mjs";

const E = process.env;
for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, e => { console.error("::error::" + (e?.message || e)); process.exit(1); });
const need = k => { if (!E[k]) { console.error(`Missing secret ${k}. Add it under Settings → Secrets and variables → Actions.`); process.exit(1); } return E[k]; };
const PASS = need("APP_PASSPHRASE"), CID = need("WHOOP_CLIENT_ID"), CSEC = need("WHOOP_CLIENT_SECRET");
const [owner, repo] = (E.GITHUB_REPOSITORY || "/").split("/");
const REDIRECT = E.WHOOP_REDIRECT_URI || `https://${owner.toLowerCase()}.github.io/${repo}/callback.html`;
const API = "https://api.prod.whoop.com/developer", TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const TOK = "data/tokens.enc.json", DATA = "data/whoop.enc.json";
const code = (E.CODE || "").trim();
if (code) console.log("::add-mask::" + code);

async function tokenRequest(params) {
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CID, client_secret: CSEC, ...params }) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Whoop token request failed (${r.status}): ${txt.slice(0, 300)}`);
  const t = JSON.parse(txt);
  if (!t.refresh_token) throw new Error("Whoop returned no refresh token. Make sure the 'offline' scope is enabled for your Whoop app.");
  const saved = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in - 60) * 1000 };
  fs.writeFileSync(TOK, JSON.stringify(await seal(saved, PASS)));   // Whoop rotates refresh tokens: always save the new one
  return saved.access_token;
}
async function getAccess() {
  if (code) { console.log("Connecting Whoop with the code you pasted…"); return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT }); }
  if (!fs.existsSync(TOK)) throw new Error("Whoop isn't connected yet. Follow the 'Connect Whoop' step in the guide.");
  const t = await open(JSON.parse(fs.readFileSync(TOK, "utf8")), PASS);
  return tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, scope: "offline" });
}
async function all(path, start, token) {
  const out = []; let next = null, guard = 0;
  do {
    const u = new URL(API + path); u.searchParams.set("limit", "25"); u.searchParams.set("start", start);
    if (next) u.searchParams.set("nextToken", next);
    const r = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 3000)); continue; }
    if (!r.ok) throw new Error(`Whoop ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json(); out.push(...(j.records || [])); next = j.next_token || null;
  } while (next && ++guard < 80);
  return out;
}
function localDay(iso, offset) {
  const m = /([+-])(\d\d):(\d\d)/.exec(offset || "+00:00");
  const mins = m ? (m[1] === "-" ? -1 : 1) * (parseInt(m[2]) * 60 + parseInt(m[3])) : 0;
  return new Date(Date.parse(iso) + mins * 60000).toISOString().slice(0, 10);
}


const token = await getAccess();
const asked = parseInt(E.DAYS) || 4;
const days = Math.min(code ? Math.max(asked, 120) : asked, 365);   // first connect always backfills 120 days
const start = new Date(Date.now() - days * 864e5).toISOString();
console.log(`Pulling the last ${days} days from Whoop…`);
const [sleeps, recs, workouts, cycles] = await Promise.all([
  all("/v2/activity/sleep", start, token), all("/v2/recovery", start, token),
  all("/v2/activity/workout", start, token), all("/v2/cycle", start, token)]);

let db = { days: {}, workouts: {}, intervals: [] };
if (fs.existsSync(DATA)) { try { db = { ...db, ...(await open(JSON.parse(fs.readFileSync(DATA, "utf8")), PASS)) }; } catch { console.log("Existing data could not be decrypted (passphrase changed?). Starting fresh."); } }
const sleepDay = {};
for (const sl of sleeps) {
  if (sl.nap || sl.score_state !== "SCORED") continue;
  const ss = sl.score?.stage_summary || {};
  const asleep = (ss.total_light_sleep_time_milli || 0) + (ss.total_slow_wave_sleep_time_milli || 0) + (ss.total_rem_sleep_time_milli || 0);
  const d = localDay(sl.end, sl.timezone_offset); sleepDay[sl.id] = d;
  db.days[d] = { ...(db.days[d] || {}), sleep_h: +(asleep / 3.6e6).toFixed(2), sleep_perf: sl.score?.sleep_performance_percentage ?? null };
}
for (const r of recs) {
  if (r.score_state !== "SCORED" || r.score?.user_calibrating) continue;
  const d = sleepDay[r.sleep_id]; if (!d) continue;
  db.days[d] = { ...(db.days[d] || {}), hrv: +r.score.hrv_rmssd_milli.toFixed(1), rhr: r.score.resting_heart_rate, recovery: r.score.recovery_score };
}
for (const c of cycles) if (c.score) { const d = localDay(c.start, c.timezone_offset); db.days[d] = { ...(db.days[d] || {}), strain: c.score.strain }; }
for (const w of workouts) {
  if (w.score_state !== "SCORED") continue;
  db.workouts[w.id] = { id: w.id, date: localDay(w.start, w.timezone_offset), start: w.start, sport: w.sport_name,
    min: +((Date.parse(w.end) - Date.parse(w.start)) / 60000).toFixed(1), avg_hr: w.score?.average_heart_rate ?? null,
    max_hr: w.score?.max_heart_rate ?? null, strain: w.score?.strain ?? null, dist_m: w.score?.distance_meter ?? null };
}
if (E.INTERVALS_ATHLETE_ID && E.INTERVALS_API_KEY) {
  try {
    const oldest = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10), newest = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const r = await fetch(`https://intervals.icu/api/v1/athlete/${encodeURIComponent(E.INTERVALS_ATHLETE_ID)}/activities?oldest=${oldest}&newest=${newest}`,
      { headers: { authorization: "Basic " + Buffer.from("API_KEY:" + E.INTERVALS_API_KEY).toString("base64"), "user-agent": "703ready/2.0", accept: "application/json" } });
    if (!r.ok) throw new Error("status " + r.status);
    db.intervals = (await r.json()).map(a => ({ id: a.id, date: (a.start_date_local || "").slice(0, 10), start: a.start_date || null, elapsed_min: a.elapsed_time ? +(a.elapsed_time / 60).toFixed(1) : null, type: a.type, name: a.name,
      min: a.moving_time ? +(a.moving_time / 60).toFixed(1) : null, avg_w: a.icu_average_watts ?? a.average_watts ?? null,
      np: a.icu_weighted_avg_watts ?? null, avg_hr: a.average_heartrate ?? null, load: a.icu_training_load ?? null,
      dist_m: a.distance ?? null, speed: a.average_speed ?? null, decouple: a.decoupling ?? null }));
    console.log(`Intervals.icu: ${db.intervals.length} activities`);
    // Second-by-second power, HR and speed (averaged to 5 s) so the app can check each session against its goal:
    // interval reps, time in zone, pace. Kept for 28 days.
    db.streams = db.streams || {};
    const keep = new Date(Date.now() - 28 * 864e5).toISOString().slice(0, 10);
    const ids = new Set(db.intervals.filter(a => a.date >= keep).map(a => String(a.id)));
    for (const k of Object.keys(db.streams)) if (!ids.has(k)) delete db.streams[k];
    const todo = db.intervals.filter(a => a.date >= keep && !db.streams[a.id] && (a.min || 0) >= 5).slice(0, 20);
    let got = 0;
    for (const a of todo) {
      try {
        const sr = await fetch(`https://intervals.icu/api/v1/activity/${encodeURIComponent(a.id)}/streams.json?types=watts,heartrate,velocity_smooth`,
          { headers: { authorization: "Basic " + Buffer.from("API_KEY:" + E.INTERVALS_API_KEY).toString("base64"), "user-agent": "703ready/2.0", accept: "application/json" } });
        if (!sr.ok) throw new Error("status " + sr.status);
        const arr = await sr.json(); const by = {};
        if (Array.isArray(arr)) { for (const x of arr) if (x && x.type && Array.isArray(x.data)) by[x.type] = x.data; }
        else if (arr && typeof arr === 'object') for (const [k, v] of Object.entries(arr)) if (Array.isArray(v)) by[k] = v;
        const ds = (d, dec) => { if (!d) return null; const o = []; for (let i = 0; i < d.length; i += 5) { let sum = 0, n = 0; for (let j = i; j < i + 5 && j < d.length; j++) if (d[j] != null) { sum += d[j]; n++; } o.push(n ? +(sum / n).toFixed(dec) : null); } return o; };
        db.streams[a.id] = { dt: 5, w: ds(by.watts, 0), hr: ds(by.heartrate, 0), v: ds(by.velocity_smooth, 2) };
        got++;
      } catch (e) { console.log(`Stream for ${a.id} skipped: ${e.message}`); }
    }
    if (todo.length) console.log(`Intervals.icu: ${got} of ${todo.length} new activity streams saved`);
  } catch (e) { console.log("Intervals.icu skipped: " + e.message); }
}
if (E.GCAL_ICS_URL) {
  try {
    const r = await fetch(E.GCAL_ICS_URL); if (!r.ok) throw new Error("calendar link returned " + r.status);
    const cal = extract(await r.text(), { callPattern: E.CALL_MATCH, udaPattern: E.UDA_MATCH });
    db.calls = cal.calls; db.cal = { uda: cal.uda, trips: cal.trips, evening: cal.evening }; db.calls_synced = new Date().toISOString();
    console.log(`Google Calendar: ${cal.calls.length} call days, ${Object.keys(cal.uda).length} UDA shifts, ${cal.trips.length} trips, ${Object.keys(cal.evening).length} evenings with plans`);
  } catch (e) { console.log("Google Calendar skipped: " + e.message); }
}
db.synced_at = new Date().toISOString();
fs.writeFileSync(DATA, JSON.stringify(await seal(db, PASS)));
console.log(`Done: ${Object.keys(db.days).length} days, ${Object.keys(db.workouts).length} workouts saved (encrypted).`);

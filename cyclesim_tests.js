#!/usr/bin/env node
/* ============================================================================
   cyclesim_tests.js -- regression suite for CycleSim's engine

   Every check here corresponds to a real bug found and fixed by hand this
   session -- each one shipped silently for a while before someone happened
   to notice something looked wrong. This file exists so none of them need
   a human to catch a second time.

   USAGE
     node cyclesim_tests.js [path/to/index.html]
     (defaults to ./index.html if no path given)

   Extracts the engine directly from the live HTML file every run -- no
   manual preprocessing step, no separate copy to keep in sync. Run it any
   time after touching the engine, before shipping.

   Exits 0 if everything passes, 1 if anything fails (safe to wire into a
   pre-commit hook or CI if this project ever gets one).
   ============================================================================ */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------------------
// 1. Extract the engine from the live HTML file
// ---------------------------------------------------------------------------
const htmlPath = process.argv[2] || path.join(process.cwd(), "index.html");
if (!fs.existsSync(htmlPath)) {
  console.error("Could not find " + htmlPath + "\nUsage: node cyclesim_tests.js [path/to/index.html]");
  process.exit(1);
}
const html = fs.readFileSync(htmlPath, "utf8");

const scriptMatch = html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.error("No <script> tag found in " + htmlPath); process.exit(1); }
const fullJs = scriptMatch[1];

// The engine IIFE + everything declared before it (CITY_NAMES, SPONSORS, etc.
// live OUTSIDE the engine IIFE as top-level consts the engine reads via a
// `typeof X!=='undefined'` check -- slicing from the very start, not just the
// IIFE itself, is required or those go missing and things like team naming
// silently break in ways that have nothing to do with the actual bug).
const IIFE_END = "})(typeof window!=='undefined'?window:globalThis);";
const endIdx = fullJs.indexOf(IIFE_END);
if (endIdx < 0) { console.error("Could not find the engine IIFE boundary -- has the export line changed?"); process.exit(1); }
let engineSrc = fullJs.slice(0, endIdx + IIFE_END.length);

// Expose two additional internals needed ONLY for the sprint-predictability
// check below (stepRaceStage isn't part of the normal public API since UI
// code never needs to call it directly -- only this test does).
const API_MARK = "const API={ ATTRS, parseCSV,";
if (!engineSrc.includes(API_MARK)) {
  console.error("Could not find the API export line -- has it been rewritten? (looked for: " + API_MARK + ")");
  process.exit(1);
}
engineSrc = engineSrc.replace(API_MARK, "const API={ ATTRS, parseCSV, stepRaceStage, gauss,");

const tmpFile = path.join(os.tmpdir(), "cyclesim_engine_" + Date.now() + "_" + process.pid + ".js");
fs.writeFileSync(tmpFile, engineSrc);
global.window = global;
let E;
try {
  E = require(tmpFile);
} catch (e) {
  console.error("Engine failed to load/parse:\n" + e.stack);
  process.exit(1);
} finally {
  try { fs.unlinkSync(tmpFile); } catch (_) {}
}

// ---------------------------------------------------------------------------
// 2. Tiny test framework
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
const failures = [];
function group(name) { console.log("\n" + name); }
function check(name, fn) {
  try {
    fn();
    console.log("  \u2713 " + name);
    pass++;
  } catch (e) {
    console.log("  \u2717 " + name + "  --  " + e.message);
    failures.push(name + ": " + e.message);
    fail++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// ---------------------------------------------------------------------------
// 3. Synthetic world generator
// ---------------------------------------------------------------------------
const NATIONS = ["France", "Italy", "Spain", "Belgium", "Netherlands", "Germany", "United States",
  "Colombia", "Australia", "Japan", "Poland", "Norway", "Denmark", "Switzerland", "Portugal",
  "United Kingdom", "Ireland", "Austria", "Slovenia", "Czech Republic", "Canada", "Brazil",
  "South Africa", "New Zealand", "Sweden"];
const ATTRS = ["FLA", "MTN", "MM", "HIL", "TTR", "PRL", "COB", "SPR", "ACC", "DHI", "ATT", "STA", "RES", "REC"];

function genRidersCsv(nations, perNation) {
  let out = "Rating,Team,RIDER,Country," + ATTRS.join(",") + ",id,lastSeen\n";
  let id = 1;
  for (const nat of nations) {
    for (let i = 0; i < perNation; i++) {
      const base = 35 + Math.random() * 50;
      const vals = ATTRS.map(() => Math.max(15, Math.min(99, Math.round(base + (Math.random() - 0.5) * 30))));
      const avg = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
      out += avg + ",,Rider" + id + " " + nat + "," + nat + "," + vals.join(",") + "," + id + ",\n";
      id++;
    }
  }
  return out;
}

console.log("CycleSim regression suite");
console.log("engine: " + htmlPath);
console.log("building a synthetic test world...");
const ridersCsv = genRidersCsv(NATIONS, 160);
const riders = E.parseCSV(ridersCsv);
console.log("  " + riders.length + " riders parsed across " + NATIONS.length + " nations\n");

// =============================================================================
// GENESIS DRAFT
// =============================================================================
group("Genesis draft");

check("free agents span a real talent range, not just the deterministic weakest tail", () => {
  const { teams, freeAgents } = E.genesisDraft(riders);
  if (freeAgents.length < 15) return; // too few to draw a statistically meaningful conclusion
  const draftedAvgs = [];
  teams.forEach(t => t.riders.slice(8).forEach(r => draftedAvgs.push(r.avg)));
  const median = draftedAvgs.slice().sort((a, b) => a - b)[Math.floor(draftedAvgs.length / 2)];
  const aboveMedian = freeAgents.filter(r => r.avg > median).length;
  assert(aboveMedian > 0,
    "every single free agent rated below the drafted median -- looks like deterministic " +
    "worst-first leftovers, not a random cut of who missed the draft");
});

check('no team name falls back to the broken "XX 1" pattern (missing CITY_NAMES/SPONSORS entry)', () => {
  const { teams } = E.genesisDraft(riders);
  const broken = teams.filter(t => /^[A-Z]{2} \d+$/.test(t.name));
  assert(broken.length === 0,
    broken.length + " team(s) with a raw-code fallback name: " + broken.map(t => t.name).join(", "));
});

check("every team starts with exactly 15 riders", () => {
  const { teams } = E.genesisDraft(riders);
  const bad = teams.filter(t => t.riders.length !== 15);
  assert(bad.length === 0, bad.length + " team(s) not at 15 riders after the draft");
});

// =============================================================================
// ROSTER / RETIREMENT
// =============================================================================
group("Roster & retirement");

check("retiring a rider frees an active roster slot without removing them from t.riders", () => {
  const S = E.newGame(riders);
  const t = S.teams[0];
  const before = E.activeRiders(t).length;
  t.riders[0].retired = true;
  assert(t.riders.length === 15, "raw roster length changed on retirement -- it should stay put");
  assert(E.activeRiders(t).length === before - 1, "active count didn't drop by exactly one");
});

check("signFreeAgentTo fills an open slot and blocks over-filling a full roster", () => {
  const S = E.newGame(riders);
  const t = S.teams[0];
  t.riders[0].retired = true;
  const fa = S.freeAgents[0];
  const ok = E.signFreeAgentTo(S, fa.name, t.id);
  assert(ok === true, "signing to an open slot should succeed");
  assert(E.activeRiders(t).length === 15, "active count should be back to 15 after signing");
  const fa2 = S.freeAgents[0];
  const ok2 = E.signFreeAgentTo(S, fa2.name, t.id);
  assert(ok2 === false, "signing to an already-full roster should be rejected");
});

// =============================================================================
// DIVISION STRUCTURE
// =============================================================================
group("Division structure");

check("teams within a division are split evenly across parallel races (max-min spread <= 1)", () => {
  const S = E.newGame(riders);
  E.setupPhase(S); E.finishPhase(S); // resolve the opening championship phase
  const desc = E.setupPhase(S);
  const byDiv = {};
  desc.races.forEach(r => { if (r.tier === "NATIONAL" || r.tier === "WORLDS") return;
    (byDiv[r.division] || (byDiv[r.division] = [])).push(r.teams.length); });
  E.finishPhase(S);
  Object.keys(byDiv).forEach(d => {
    const sizes = byDiv[d];
    if (sizes.length < 2) return;
    const spread = Math.max(...sizes) - Math.min(...sizes);
    assert(spread <= 1, "division " + d + " race sizes are " + JSON.stringify(sizes) +
      " -- spread of " + spread + " (should never exceed 1)");
  });
});

// =============================================================================
// CHAMPIONSHIPS
// =============================================================================
group("Championships");

check("a championship phase produces zero promotion/relegation moves", () => {
  const S = E.newGame(riders);
  const desc = E.setupPhase(S);
  assert(desc.champs === true, "expected the opening phase to be a championship phase");
  while (E.nextUnit(S)) E.stepPhase(S);
  const log = E.finishPhase(S);
  assert(!log.moves || log.moves.length === 0,
    "championship phase produced " + (log.moves || []).length + " division moves -- should be none");
});

check("a championship phase leaves every division's team count unchanged", () => {
  const S = E.newGame(riders);
  const before = E.divisionMap(S.teams);
  const beforeCounts = { 1: before[1].length, 2: before[2].length, 3: before[3].length, 4: before[4].length };
  E.setupPhase(S);
  while (E.nextUnit(S)) E.stepPhase(S);
  E.finishPhase(S);
  const after = E.divisionMap(S.teams);
  [1, 2, 3, 4].forEach(d => assert(after[d].length === beforeCounts[d],
    "division " + d + " changed size during a championship phase: " +
    beforeCounts[d] + " -> " + after[d].length));
});

// =============================================================================
// PROMOTION / RELEGATION
// =============================================================================
group("Promotion / relegation");

check("no team relegated from D1 is immediately re-promoted in the same special phase", () => {
  const S = E.newGame(riders);
  let found = false, checked = 0;
  for (let i = 0; i < 34 * 6 && !found; i++) {
    const desc = E.setupPhase(S);
    if (desc.type === "SPECIAL") {
      while (E.nextUnit(S)) E.stepPhase(S);
      const log = E.finishPhase(S);
      if (log.moves && log.moves.length) {
        checked++;
        const relegated = new Set(log.moves.filter(m => m.kind === "relegate").map(m => m.tid));
        const bounced = log.moves.filter(m => m.kind === "promote" && relegated.has(m.tid));
        if (bounced.length) found = true;
      }
    } else {
      E.finishPhase(S);
    }
  }
  assert(checked > 0, "no special phase with moves occurred in the test window -- widen the phase count");
  assert(!found, "found a team relegated from D1 and immediately promoted back in the same phase");
});

check("a common-phase race winner's team is always among that division's promotions", () => {
  const S = E.newGame(riders);
  E.setupPhase(S); E.finishPhase(S); // resolve the opening championship phase
  let checked = 0;
  for (let i = 0; i < 10; i++) {
    E.setupPhase(S);
    while (E.nextUnit(S)) E.stepPhase(S);
    const log = E.finishPhase(S);
    [2, 3, 4].forEach(d => {
      const races = log.races.filter(r => r.division === d);
      if (!races.length) return;
      const promoted = new Set(log.moves.filter(m => m.kind === "promote" && m.to === d - 1).map(m => m.tid));
      races.forEach(r => {
        checked++;
        const winnerTeamId = r.result.gc[0].teamId;
        assert(promoted.has(winnerTeamId),
          "race \"" + r.name + "\" was won by a team that did NOT get promoted");
      });
    });
  }
  assert(checked > 0, "no races with promotions occurred in the test window");
});

// =============================================================================
// RACE SIMULATION
// =============================================================================
group("Race simulation");

check("a flat-stage sprint isn't near-deterministic for a standout sprinter (terrain noise present)", () => {
  const mkTeam = (name, avg, spr, teamId) => ({
    teamId, rider: { name, country: "France", avg,
      a: { FLA: 50, MTN: 50, MM: 50, HIL: 50, TTR: 50, PRL: 50, COB: 50, SPR: spr,
           ACC: 50, DHI: 50, ATT: 50, STA: 75, RES: 75, REC: 75 } }
  });
  const roster = [
    mkTeam("Best", 80, 97, 1), mkTeam("R1", 70, 80, 2), mkTeam("R2", 69, 78, 3),
    mkTeam("R3", 68, 76, 4), mkTeam("R4", 66, 73, 5), mkTeam("R5", 65, 70, 6),
  ];
  function makeRS() {
    const rs_riders = roster.map(e => ({
      name: e.rider.name, teamId: e.teamId, country: e.rider.country, rider: e.rider,
      gc: 0, pts: 0, kom: 0, sprintPts: 0, out: false, energy: 100, time: 0, formMul: 1
    }));
    return { division: 1, name: "Test Stage", host: "France", country: "France", tier: "COMMON",
      gt: null, nStages: 1, teams: [1, 2, 3, 4, 5, 6],
      stages: [{ name: "Stage 1", terrain: "FLA" }], riders: rs_riders,
      stageResults: [], cur: 0, done: false, abandons: [] };
  }
  const wins = {};
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const sr = E.stepRaceStage(makeRS());
    wins[sr.winner.name] = (wins[sr.winner.name] || 0) + 1;
  }
  const bestWinRate = (wins["Best"] || 0) / N;
  assert(bestWinRate < 0.97,
    "the highest-SPR rider won " + (bestWinRate * 100).toFixed(1) + "% of " + N +
    " simulated flat stages against realistic rivals -- terrain noise looks to have regressed " +
    "back toward deterministic (should be well under 97%)");
});

// =============================================================================
// CALENDAR HISTORY
// =============================================================================
group("Calendar history");

check("forming a new team mid-season doesn't change ANY phase's calendar this season " +
      "(already-played or still upcoming)", () => {
  const S = E.newGame(riders);
  for (let i = 0; i < 8; i++) { E.setupPhase(S); while (E.nextUnit(S)) E.stepPhase(S); E.finishPhase(S); }
  const before = E.seasonSchedule(S);
  const beforeMap = {};
  before.forEach(x => { beforeMap[x.phase] = (x.races || []).map(r => r.name).sort(); });
  const faNames = S.freeAgents.slice(0, 15).map(r => r.name);
  const newTeam = E.formTeam(S, faNames);
  assert(newTeam, "formTeam failed to create a team from 15 available free agents");
  const after = E.seasonSchedule(S);
  for (let p = 2; p <= 34; p++) {
    const pred = after.find(x => x.phase === p);
    if (!pred) continue;
    const afterNames = (pred.races || []).map(r => r.name).sort();
    assert(JSON.stringify(afterNames) === JSON.stringify(beforeMap[p]),
      "phase " + p + "'s calendar changed after forming a new team this season");
  }
});

check("a queued new-team fixture doesn't race until the following year", () => {
  const S = E.newGame(riders);
  for (let i = 0; i < 8; i++) { E.setupPhase(S); while (E.nextUnit(S)) E.stepPhase(S); E.finishPhase(S); }
  const newTeam = E.formTeam(S, S.freeAgents.slice(0, 15).map(r => r.name));
  const fixtureName = "Gran Premio " + newTeam.homeCity;
  const formedYear = S.year;
  let sawItSameYear = false;
  while (S.year === formedYear) {
    E.setupPhase(S); while (E.nextUnit(S)) E.stepPhase(S);
    const log = E.finishPhase(S);
    if (log.races.some(r => r.name === fixtureName)) sawItSameYear = true;
  }
  assert(!sawItSameYear, "a team formed mid-season raced in its own formation year -- should wait for the next year boundary");
});

check("a simple save+reload doesn't change any already-played phase's calendar", () => {
  const S = E.newGame(riders);
  const actual = {};
  for (let p = 1; p <= 10; p++) {
    E.setupPhase(S); while (E.nextUnit(S)) E.stepPhase(S);
    const log = E.finishPhase(S);
    actual[p] = log.races.filter(r => r.tier !== "NATIONAL" && r.tier !== "WORLDS").map(r => r.name).sort();
  }
  const S2 = E.deserialize(E.serialize(S));
  const predicted = E.seasonSchedule(S2);
  for (let p = 2; p <= 10; p++) {
    const pred = predicted.find(x => x.phase === p);
    if (!pred) continue;
    const predNames = (pred.races || []).map(r => r.name).sort();
    assert(JSON.stringify(predNames) === JSON.stringify(actual[p] || []),
      "phase " + p + "'s calendar changed after a save+reload -- actual: " +
      JSON.stringify(actual[p]) + " vs after reload: " + JSON.stringify(predNames));
  }
});

// =============================================================================
// LONG-RUN STABILITY
// =============================================================================
group("Long-run stability");

check("a 3-year simulation runs without throwing", () => {
  const S = E.newGame(riders);
  for (let i = 0; i < 34 * 3; i++) E.runPhase(S);
  assert(S.year === 3, "expected S.year===3 after 3*34 phases, got " + S.year);
});

check("no team ever ends up with a broken raw-code fallback name after 3 years " +
      "(covers both the genesis draft and in-game team formation)", () => {
  const S = E.newGame(riders);
  for (let i = 0; i < 34 * 3; i++) E.runPhase(S);
  const broken = S.teams.filter(t => /^[A-Z]{2} \d+$/.test(t.name));
  assert(broken.length === 0,
    broken.length + " team(s) with a broken name after 3 years: " + broken.map(t => t.name).join(", "));
});

check("every team stays close to 15 active riders after 3 years (market keeps rosters full)", () => {
  const S = E.newGame(riders);
  for (let i = 0; i < 34 * 3; i++) E.runPhase(S);
  const bad = S.teams.filter(t => E.activeRiders(t).length !== 15);
  // A small synthetic test world has a known, PRE-EXISTING, non-regression gap
  // here: the market's +/-1-division eligibility window can run out of nearby
  // candidate teams in a small world, leaving some rosters a rider short.
  // Measured twice independently this session at ~12.5% of teams (5/40 and
  // 33/266, both essentially identical) -- confirmed unrelated to any of this
  // session's fixes by diffing against the pristine original file. 20%
  // gives headroom above that baseline while still catching a REAL
  // regression (e.g. the market breaking outright would blow well past this).
  const rate = bad.length / S.teams.length;
  assert(rate <= 0.20,
    (rate * 100).toFixed(1) + "% of teams not at 15 active riders after 3 years " +
    "(tolerance: 20%, calibrated against a ~12.5% known small-world baseline)");
});

// ---------------------------------------------------------------------------
// 4. Summary
// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(60));
console.log(pass + " passed, " + fail + " failed");
if (fail) {
  console.log("\nFAILURES:");
  failures.forEach(f => console.log("  - " + f));
  process.exit(1);
} else {
  console.log("all clear.");
  process.exit(0);
}

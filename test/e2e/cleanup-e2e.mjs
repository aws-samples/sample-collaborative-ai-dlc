// test/e2e/cleanup-e2e.mjs
// Removes leftover e2e-generated projects (and their sprints) from Neptune so
// the staging DB / project list isn't polluted by aborted or failed runs.
//
// Usage:
//   node cleanup-e2e.mjs            # dry-run: list e2e-* projects, delete nothing
//   node cleanup-e2e.mjs --apply    # actually delete the matched projects
//   node cleanup-e2e.mjs --apply --min-age-min 30   # only delete projects >30min old
//   node cleanup-e2e.mjs --apply --force --project-id <id>  # force a single project
//
// Safety:
//   - Only projects whose name matches /^e2e-<epochMs>/ are ever considered.
//   - By default, projects younger than --min-age-min (90) are SKIPPED so an
//     in-flight run's project is never deleted out from under it.
//   - --force lowers the guard but NEVER below FORCE_FLOOR_MIN (5min): a project
//     younger than the floor is never deleted, even with --force. This prevents
//     the past incident where --force wiped an actively-running run's project.
//   - --force only applies to a single project named via --project-id; it will
//     not force-delete the entire matched set at once.
import { loadConfig } from './config.mjs';
import { srpLogin } from './auth.mjs';
import { createApiClient } from './apiClient.mjs';

const E2E_NAME = /^e2e-(\d+)/;
// Hard floor: even --force will not delete a project younger than this, so an
// active run is never destroyed out from under itself.
export const FORCE_FLOOR_MIN = 5;

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

export function ageMinutesFrom(name, now = Date.now()) {
  const m = E2E_NAME.exec(String(name || ''));
  if (!m) return null;
  const ms = Number(m[1]);
  if (!Number.isFinite(ms)) return null;
  return (now - ms) / 60000;
}

// Pure age-guard decision. Returns { ok, reason }.
//   - force only takes effect for the explicitly targeted project (forceTarget).
//   - even when forcing, age must clear FORCE_FLOOR_MIN.
//   - unknown age (non-matching name) is never deletable.
export function shouldDelete({
  age,
  minAgeMin,
  force = false,
  isForceTarget = false,
  floor = FORCE_FLOOR_MIN,
}) {
  if (age == null) return { ok: false, reason: 'unknown-age' };
  if (force && isForceTarget) {
    if (age < floor) return { ok: false, reason: `below-force-floor(<${floor}min)` };
    return { ok: true, reason: 'forced' };
  }
  if (age < minAgeMin) return { ok: false, reason: `too-recent(<${minAgeMin}min)` };
  return { ok: true, reason: 'age-ok' };
}

function ageMinutes(name) {
  return ageMinutesFrom(name);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');
  const forceProjectId = argValue('--project-id', null);
  const minAgeMin = Number(argValue('--min-age-min', '90'));

  if (force && !forceProjectId) {
    console.error(
      "Refusing to --force without --project-id: force-delete is scoped to a single project to avoid wiping an active run's set. Re-run with --project-id <id>.",
    );
    process.exit(2);
  }

  const cfg = loadConfig();
  const tokens = await srpLogin(cfg);
  const api = createApiClient({ apiBaseUrl: cfg.apiBaseUrl, idToken: tokens.idToken });

  const projects = await api.get('/projects');
  const list = Array.isArray(projects) ? projects : projects?.projects || projects?.items || [];
  const e2eProjects = list.filter((p) => E2E_NAME.test(String(p?.name || '')));

  const targets = [];
  const skipped = [];
  for (const p of e2eProjects) {
    const age = ageMinutes(p.name);
    const isForceTarget = force && String(p.id) === String(forceProjectId);
    const decision = shouldDelete({ age, minAgeMin, force, isForceTarget });
    if (decision.ok) targets.push({ p, age, reason: decision.reason });
    else skipped.push({ p, age, reason: decision.reason });
  }

  console.log(`Found ${list.length} project(s); ${e2eProjects.length} match /^e2e-/.`);
  if (force)
    console.log(`--force scoped to project-id ${forceProjectId} (floor ${FORCE_FLOOR_MIN}min).`);
  if (skipped.length) {
    console.log(
      `Skipping ${skipped.length} project(s) (use --force --project-id <id> to override a single one, never below ${FORCE_FLOOR_MIN}min):`,
    );
    for (const { p, age, reason } of skipped)
      console.log(
        `  ~ ${p.name} (${p.id})  [${age != null ? age.toFixed(1) + 'min' : '?'} old] (${reason})`,
      );
  }
  console.log(`${targets.length} eligible for deletion:`);
  for (const { p, age } of targets)
    console.log(`  - ${p.name} (${p.id})  [${age != null ? age.toFixed(1) + 'min' : '?'} old]`);
  if (!targets.length) {
    console.log('Nothing to clean.');
    return;
  }
  if (!apply) {
    console.log('\nDry-run. Re-run with --apply to delete the above.');
    return;
  }

  let deleted = 0;
  for (const { p } of targets) {
    try {
      const sprints = await api.get(`/projects/${p.id}/sprints`).catch(() => []);
      const sprintList = Array.isArray(sprints) ? sprints : sprints?.sprints || [];
      for (const s of sprintList) {
        await api
          .del(`/projects/${p.id}/sprints/${s.id}`)
          .catch((e) => console.log(`    sprint ${s.id} del failed: ${e.message}`));
      }
      await api.del(`/projects/${p.id}`);
      deleted += 1;
      console.log(`  deleted ${p.name} (${p.id}) + ${sprintList.length} sprint(s)`);
    } catch (e) {
      console.log(`  FAILED ${p.name} (${p.id}): ${e.message}`);
    }
  }
  console.log(`\nDeleted ${deleted}/${targets.length} e2e project(s).`);
}

// Only auto-run when invoked directly (not when imported by a unit test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

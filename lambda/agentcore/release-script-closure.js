// Materializes the sibling modules a pinned sensor script imports.
//
// A release's sensor script is one object in the closure; the modules it imports
// are others, published under the `runtime` role by path
// (`aidlc-release.js` `runtimeEntries`). The runtime wrote only the entry script
// next to the workspace, so a script importing `./aidlc-lib.ts` died at startup
// with `Cannot find module` before running its check. This resolves the closure
// with the same walk the compatibility analyzer uses to claim the closure is
// complete, and fails closed: a dependency the release does not publish, or one
// whose bytes do not match the recorded digest, is a release integrity failure
// naming the path — never a partial materialization and never a fallback to a
// SYSTEM copy of the same file.

import { sensorScriptPath } from '../shared/block-mappers.js';
import { SYSTEM_TENANT } from '../shared/tenant.js';
import { importSpecifiers } from '../shared/script-closure.js';
import {
  asReleaseDependencyFailure,
  resolveScriptClosure,
} from '../shared/release-script-closure.js';
import { loadScriptClosure as defaultLoadScriptClosure } from './block-loader.js';

export { resolveScriptClosure };

// Whether a SENSOR the plan resolved belongs to the methodology release itself.
//
// A pinned intent's library is the release catalog plus explicit user-tenant
// overlays (`release-resolver.js` resolveMethodologyLibrary). Only the release's
// own sensors have a release closure to read: a user overlay's script resolves
// its relative imports against the workspace it is materialized into, which the
// release never published. Asking the release for them would report the
// project's own code as corruption of a release that never owned it. This is
// the same provenance test `loadBlockScript` applies to the script bytes.
export const releaseOwnedSensorPredicate = (sensorsById) => (sensorId) =>
  (sensorsById?.[sensorId]?.tenantId ?? SYSTEM_TENANT) === SYSTEM_TENANT;

// The runtime's reader: resolves a pinned sensor's import closure out of the
// intent's release closure. Returns null in legacy mode, where a sensor script
// is a single self-contained object and there is no closure to read. The read
// itself is a methodology catalog operation, so with engine data enabled it is
// an engine-data call under the invocation grant like every other release read.
export const createReleaseScriptClosureReader = ({
  methodologyRelease = null,
  releaseOwnsSensor = null,
  loadScriptClosure = defaultLoadScriptClosure,
} = {}) => {
  if (!methodologyRelease) return null;
  if (typeof releaseOwnsSensor !== 'function') {
    throw new TypeError(
      'release-script-closure: releaseOwnsSensor is required — a reader that cannot tell a release sensor from a user overlay would hold a stage on the project\u2019s own imports',
    );
  }
  return async (sensorId, entryContent) => {
    if (!releaseOwnsSensor(sensorId)) return [];
    // A self-contained script needs no closure, so it must not cost a closure
    // read: that keeps every release whose sensor scripts import nothing on
    // exactly the object reads it performs today.
    if (!importSpecifiers(entryContent).some((specifier) => specifier.startsWith('.'))) return [];
    try {
      return await loadScriptClosure({ sensorId, entryContent, methodologyRelease });
    } catch (error) {
      // A transport failure or a denial is as unverifiable as an absent object.
      throw asReleaseDependencyFailure(error, { entryPath: sensorScriptPath(sensorId) });
    }
  };
};

export default {
  createReleaseScriptClosureReader,
  releaseOwnedSensorPredicate,
  resolveScriptClosure,
};

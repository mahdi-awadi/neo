// The console's service worker entry (ADR-0022): bundled by Bun.build and served as /sw.js (scope /).
// No exports: a worker registered without {type:"module"} is a classic script. The handlers live in
// ./sw-worker.ts (tested against a fake scope); the rule in ./sw-rules.ts.
import { attachWorker, type WorkerScope } from "./sw-worker";

attachWorker(self as unknown as WorkerScope);

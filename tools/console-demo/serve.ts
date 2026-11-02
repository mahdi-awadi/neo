// Serve the demo console (tools/console-demo/demo.ts) for a manual mobile check (ADR-0071):
//   bun tools/console-demo/serve.ts [port]        then open the printed URL (127.0.0.1 only).
import { startConsoleDemo } from "./demo";

const demo = startConsoleDemo(Number(process.argv[2] ?? 0));
console.log(`console demo: ${demo.loginUrl}`);

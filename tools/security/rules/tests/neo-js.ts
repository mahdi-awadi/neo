// Fixture for rules/custom/neo-js.yaml — intentionally vulnerable. Excluded from scans.
import jwt from "jsonwebtoken";

function handlers(req: any, res: any, db: any, cp: any, fs: any, c: any) {
  // ruleid: neo-js-mass-assignment
  db.user.create(req.body);
  // ruleid: neo-js-mass-assignment
  db.user.update({ where: { id: 1 }, data: req.body });
  // ok: neo-js-mass-assignment
  db.user.create({ data: { name: req.body.name } });

  // ruleid: neo-js-client-trusted-price
  const total = req.body.price * 2;

  // ruleid: neo-js-insecure-random-secret
  const otpCode = Math.floor(Math.random() * 1e6);
  // ok: neo-js-insecure-random-secret
  const jitter = Math.random() * 100;

  // ruleid: neo-js-cookie-missing-flags
  res.cookie("sid", "x");
  // ok: neo-js-cookie-missing-flags
  res.cookie("sid", "x", { httpOnly: true, secure: true, sameSite: "lax" });

  // ruleid: neo-js-secret-in-log
  console.log("login", req.body.password);
  // ok: neo-js-secret-in-log
  console.log("login", req.body.email);

  // ruleid: neo-js-ssrf-user-url
  fetch(req.query.url);

  // ok: neo-js-ssrf-user-url
  db.query(sql).get(req.params.id);

  // ok: neo-js-ssrf-user-url
  db.query(q.sql).get(...q.params);

  // ruleid: neo-js-ssrf-user-url
  https.get(req.body.callback);

  // ruleid: neo-js-path-traversal
  fs.readFileSync("/data/" + req.params.name);

  // ok: neo-js-path-traversal
  fs.readFileSync("/data/" + db.query(sql).name);
  // ok: neo-js-path-traversal
  fs.readFileSync("/data/" + path.basename(req.params.name));

  try { db.x(); } catch (e: any) {
    // ruleid: neo-js-error-detail-to-client
    res.status(500).json({ error: e.stack });
  }

  // ruleid: neo-js-jwt-unverified
  jwt.decode(req.headers.authorization);
  // ruleid: neo-js-jwt-unverified
  jwt.verify(t, key);
  // ok: neo-js-jwt-unverified
  jwt.verify(t, key, { algorithms: ["HS256"] });

  return total + otpCode + jitter;
}

async function llm(client: any, cp: any, db: any) {
  const r = await client.chat.completions.create({});
  const out = r.choices[0].message.content;
  // ruleid: neo-js-llm-output-to-sink
  cp.execSync(out);
  // ok: neo-js-llm-output-to-sink
  db.query(Schema.parse(out));
}

function cors(app: any, cors: any) {
  // ruleid: neo-js-cors-wildcard-credentials
  app.use(cors({ origin: "*", credentials: true }));
}

function dom(el: any, html: string) {
  // ruleid: neo-js-raw-html
  el.innerHTML = html;
  // ok: neo-js-raw-html
  el.innerHTML = "<b>static</b>";
}

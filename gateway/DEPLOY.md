# Customer Email Gateway — go-live runbook

Everything that can be pre-staged is done: secrets generated, `gateway/.env` written, Neo's
`/agent/ingress` is live (bridge verified: `{"ok":true,"result":"BRIDGE OK"}`), the Dockerfile +
compose + Traefik labels are ready. Address is **info@example.com**. The gateway container
holds **no Cloudflare/Claude credentials** — all Cloudflare access is via the Worker.

Remaining steps (need your Cloudflare account):

## 1. Cloudflare — verify the sending domain (DKIM)
Dashboard → **Email → Email Service / Sending** → add **example.com** as a sending domain →
accept the DKIM/SPF records it offers (they drop straight into your existing Cloudflare DNS). Wait
until it shows **Verified**.

## 2. Cloudflare — enable Email Routing (inbound)
Dashboard → **Email → Email Routing** → enable it for **example.com** (adds the Cloudflare MX
records). We wire the route to the Worker in step 4.

## 3. Deploy the Worker
```sh
cd /home/neo/gateway/worker
npm install
# paste the value from gateway/.env when prompted (see it with: grep GATEWAY_WORKER_SECRET ../.env):
npx wrangler secret put GATEWAY_WORKER_SECRET
npx wrangler deploy
```
`wrangler deploy` prints the Worker URL, e.g. `https://neo-email-worker.<your-subdomain>.workers.dev`.
**Copy that URL.**

## 4. Point inbound mail at the Worker + set the send URL
- **Email Routing route:** dashboard → Email Routing → **Routes** → add custom address
  `info@example.com` → **Action: Send to a Worker → neo-email-worker**.
- **Outbound URL:** put the Worker URL from step 3 into `gateway/.env`:
  ```sh
  sed -i 's#^WORKER_SEND_URL=.*#WORKER_SEND_URL=https://neo-email-worker.<your-subdomain>.workers.dev#' /home/neo/gateway/.env
  ```

## 5. Build + run the gateway container
```sh
cd /home/neo/gateway
./build.sh                       # static binary, uses local gopkg workspace
docker compose up -d --build     # joins the `proxy` network; Traefik serves neo-api.example.com
```

## 6. Verify
```sh
curl -s https://neo-api.example.com/healthz          # -> ok
```
Then email **info@example.com** from any inbox. Expected: the company runs the brief (watch it
in the Neo dashboard, tagged), and you receive a reply from info@example.com.

## Reference — what's where
- `gateway/.env` — runtime secrets (gitignored, chmod 600). `WORKER_SEND_URL` is the only TODO.
- `gateway/worker/` — the Cloudflare Worker (inbound `email()` + outbound `fetch()` via `env.EMAIL.send`).
- Neo side: `AGENT_INGRESS_SECRET` in `/home/neo/.env` (= the gateway's `NEO_INGRESS_SECRET`); the
  ingress is `POST 172.20.0.1:3003/agent/ingress`, reachable from the `proxy` network.
- Flow: customer → CF Email Routing → Worker → `POST /inbound/email` → Gemini orchestrator →
  `dispatch_to_company` → Neo `/agent/ingress` → company → result → Gemini reply → Worker
  `env.EMAIL.send` → customer.

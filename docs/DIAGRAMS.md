# Architecture Diagrams

High-quality block & flow diagrams for the AEP Data Lifecycle Helper, built in a
Figma design file with a consistent AEP-Spectrum visual system.

> **Live, editable source:** [Figma design file](https://www.figma.com/design/G9tjo1Uq1JSfCHGfzBMrZe) — pan, zoom, comment, and edit.
> PNG exports below live in [`docs/diagrams/figma/`](diagrams/figma/). The
> original Mermaid sources (`docs/diagrams/*.mmd`) are retained as a text-diffable
> fallback.

**Legend** — blue = active component/step · amber = gate / deferred / uncertain ·
green = success / persistence · red = terminal failure / threat · dark = external Adobe service.

---

## 1. System architecture
One local Node.js process: Express (REST API + static UI), bounded-concurrency in-process runners, one SQLite file, in-memory IMS token cache → Adobe APIs.

![System architecture](diagrams/figma/01-system-architecture.png)

## 2. Operator journey
The seven steps from credentials to confirmed deletion, with the per-month approval gate and the reconcile recovery path.

![Operator journey](diagrams/figma/02-operator-journey.png)

## 3. Work-order state machine
Every state and transition — including why a 5xx/timeout stays in `submitting` with quota **held**, and how reconcile / release-absent recover it.

![Work-order state machine](diagrams/figma/03-work-order-state-machine.png)

## 4. Multi-month quota planning
How identifiers pack into ≤100k work orders across day/month windows under the live daily + monthly caps, with Month 2+ gated behind explicit approval.

![Multi-month planning](diagrams/figma/04-multi-month-planning.png)

## 5. Region architecture
The Identity Service is regionally sharded; the URL is built per-credential, an allowlist blocks SSRF, and a wrong-region call silently returns empty clusters.

![Region architecture](diagrams/figma/05-region-architecture.png)

## 6. Defense in depth
Six security layers that keep a malicious browser tab from driving an unauthenticated, irreversible-delete API.

![Defense in depth](diagrams/figma/06-defense-in-depth.png)

## 7. Expansion data flow
CSV streamed from disk → pre-flight sniffer → batched Identity Graph calls (bounded concurrency) → canonicalize → bulk insert into SQLite.

![Expansion data flow](diagrams/figma/07-expansion-data-flow.png)

## 8. Submit & reconcile flow
The submission chain, the three-way POST outcome (2xx / 4xx / 5xx-timeout), and every recovery path for uncertain orphans.

![Submit and reconcile flow](diagrams/figma/08-submit-reconcile-flow.png)

---

### Regenerating
Edit the [Figma file](https://www.figma.com/design/G9tjo1Uq1JSfCHGfzBMrZe), then
re-export each frame as a PNG into `docs/diagrams/figma/` (keep the `0N-name.png`
naming so the embeds above resolve).

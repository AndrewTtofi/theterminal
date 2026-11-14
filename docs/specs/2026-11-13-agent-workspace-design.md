# The Terminal: an open-source workspace where agents build and humans decide

*Design document · 13 Nov 2026 · working name "The Terminal" (taken from the project folder; final name TBD)*

---

## 1. Intent and why

Knowledge exists. LLMs that write code exist. Hyperscalers exist. What's missing is a layer that ties them together so **anyone willing to put in the work** can take an idea through the **entire software development lifecycle** and end up with a real, operated product, without having to be an engineer.

People already pay for powerful subscriptions (Claude, ChatGPT, Gemini, Copilot, cloud credits) and own capable hardware (Apple Silicon Macs, NVIDIA GPUs), yet use a fraction of it. Existing "idea → app" tools (Lovable, Bolt, Replit Agent, v0) are **closed-source black boxes**: you can't see what's happening, you can't connect whatever you want, and you can't audit the work.

**The Terminal is an open-source, downloadable workspace in which AI agents do all of the work and humans set intent, make decisions, approve, and audit.** Every action is traceable, every decision has a named human owner, and the builder learns enough about the field they're entering to take responsibility for what they ship.

### Who it's for
Anyone who wants to build something and is willing to engage seriously: solo founders, entrepreneurs, CEOs, startups (a VC handing it to portfolio companies is one possible distribution channel, not the definition). Technical knowledge is **optional but usable**: a non-technical owner never has to read code, and a technical owner can inspect everything.

**User #1 is the author**, who will build the first real project through it (§9).

### Success looks like
- A person describes an idea, is guided through the decisions, and ends up with a **live, working, operated product**.
- They can explain **what was built, why, what it costs, and what risks they've accepted**, because the workspace showed them and recorded their decisions.
- Their **subscriptions and hardware are used to the maximum**: no idle GPU, no unused quota resetting, no capability left on the table.

---

## 2. Goals, non-goals, anti-goals

### Goals
1. **Full lifecycle**: plan, design, build (frontend, backend, mobile), infrastructure, CI/CD, ship, operate (monitoring, observability), security. Not a single niche.
2. **Agents do the work; humans decide and audit.** (Core principle, §3.)
3. **Glass box**: every agent action, decision, command, change and cost is visible on demand, in plain language by default and raw detail underneath.
4. **Connect anything**: the builder's own LLM subscriptions, cloud accounts (AWS / GCP / Azure), local hardware, and any tool via MCP or APIs.
5. **Accountability**: readiness gates and a complete decision ledger (§5).
6. **Maximum utilization** of subscriptions and hardware (§6).
7. **Plug-and-play**: download, open, start. No terminal, no Docker setup, no config files.
8. **Open source**, self-hostable, extensible by the community.
9. **Offline mode.** Without internet, the workspace, board, ledger, share view and linked machines on the local network keep working, and agents run on local models (made possible by the first project, §9). Cloud subscriptions and cloud deploy require internet. *(Added 13 Nov 2026 at the author's request.)*

### Non-goals
- Making money from hosting. Open source first; an optional hosted version may come later but nothing is designed around it.
- Teaching people to code by hand. Learning exists so humans can **decide and audit well**, not so they do the work themselves.
- Replacing the underlying agents, models or clouds. The Terminal orchestrates and governs; it doesn't compete with them.

### Anti-goals (failure even if it technically works)
- **Waste.** Hardware and subscriptions not used to their maximum, so people don't reach what they could have built. This is the author's stated #1 failure.
- **Black box.** Any action that happens without being visible and recorded.
- **Unaccountable shipping.** Something goes live without a named human having understood and signed off on what it means.
- **Getting around providers' rules.** Using subscriptions in ways that risk the user's accounts.
- **Lock-in.** The builder must own their code, infrastructure and credentials, and be able to walk away with all of it.

---

## 3. Core principle: agents work, humans decide

- **Humans never build by hand.** They set intent, choose between options, approve readiness gates, and audit.
- **Every agent proposal that needs a human arrives as a decision card**: the question, the options, the agent's recommendation, trade-offs in plain words, cost/risk implications, and supporting evidence. The human picks; the ledger records who, what, when, why and on what evidence.
- **Changes always go through an agent.** If a human wants something changed ("make the API listen on port 9000"), they instruct an agent, which makes the change with full traceability. *(My call, not explicitly confirmed.)*
- **Emergency override** exists for direct human intervention, but it is logged prominently (highlighted in red in the ledger) as an exception. *(My call.)*
- Code views and the terminal exist as **inspection tools for auditing**, not editing tools.

---

## 4. Product shape

### 4.1 Delivery: one codebase, two homes
*(Decided together.)*
- **Local (default):** a downloadable installer for macOS, Windows and Linux. It installs prerequisites silently (e.g. Git, runtimes) *(my call)*. It runs a local server with a web-based interface, wrapped in a desktop app. Private and free.
- **Own cloud:** one click deploys the same workspace into the **builder's own** cloud account (AWS/GCP/Azure). Agents then run 24/7 and collaborators can log in. Credentials still never touch a third party. Deploying the workspace to your cloud can double as the first guided lesson in infrastructure.
- **Optional hosted version later**, not required and not designed around.
- **Own local address** *(author's decision, 14 Nov 2026)*: the local workspace is served at a dedicated hostname (e.g. `http://theterminal.localhost:<port>`), and its session cookie is scoped to that hostname. Browser cookies don't separate ports, so a cookie on `127.0.0.1` would also be sent to any other local web server, including apps agents build and run. A dedicated hostname keeps the workspace key away from them.

### 4.2 Subscriptions and models
- Connects to subscriptions **through each provider's official tools and APIs** (e.g. Claude Code / Claude Agent SDK, Codex CLI, Gemini CLI, API keys), never by scraping or working around terms. *(My call, aligned with the anti-goal.)*
- **Local models** (via the first project, §9, or existing engines like Ollama/llama.cpp/MLX/vLLM) are treated as just another capacity source.

### 4.3 Main screen: lifecycle board plus modular panels
*(Decided together, using mockups reviewed during design.)*
- **Home base is the lifecycle board**: Plan → Design → Build → Ship → Operate, with work items as cards in each stage. The board teaches the process by showing it.
- **Everything else is a panel** the user can pin, move, collapse or close, and save as a layout:
  conversation · live agent feed · needs-you (decisions and gates) · decision ledger · learn · code and diffs (read-only) · terminal (read-only) · cost and usage · capacity · monitoring · connections · daily digest.
- **Presets:** *Guided* (default for new users: board plus conversation) and *Operator* (board, code, terminal, feed, ledger, cost). Users can save their own.
- **Clicking a card** always opens its story: what was done (plain words), decisions and why, and raw code/commands/logs underneath.
- **Decisions and gates can't be hidden by any layout.** When a human is needed, it surfaces regardless of arrangement. *(My call.)*

### 4.4 Project overview / share view
*(Decided together; mockup `share-view-v2.html`.)* An auto-generated page (never hand-written) that can be shared as a **link**, shown full-screen in **present** mode, or exported as **PDF**. It contains:
- One-line pitch, owner, dates, live demo link, lifecycle progress.
- Headline numbers: tasks done by agents, spend vs budget plus running cost/day, human decisions made/waiting, health/uptime.
- What it does and why.
- **Tech stack**: layer, choice, plain-language why, linked to the deciding ledger entry, with licence status.
- **Agent workforce**: which agent did what, which model, cost.
- **Waiting on a human decision**: assignee, and what is paused on it.
- Decisions made (with approver and evidence link), audit status, last 7 days (links to daily digests).

### 4.5 Collaboration
*(Proposed by me, accepted as part of the share-view discussion.)*
- Inviting a collaborator prompts moving the workspace to the owner's cloud (or a temporary secure share link while the laptop is on).
- **Human roles:** **Owner** (accountable, holds credentials, final say) · **Approver** (signs off decisions/gates in their area) · **Auditor** (inspects work and evidence) · **Viewer** (read-only; investors, advisors, clients).
- Every ledger entry names a person. Gates can require a specific person or role.
- Presence: you can see who's in the project and what they're looking at.
- Collaborators use connected subscriptions/cloud *through* the workspace without ever seeing raw credentials.

---

## 5. Accountability: readiness gates and the decision ledger
*(Confirmed by the author: "yes exactly, plus a full audit trail of every decision".)*

- **Readiness gates:** before a consequential step (taking payments, exposing a service to a network, storing personal data, going to production, spending above budget), the workspace explains in plain language what it means and what the risks are, and requires a named human to review and sign off. Agents pause on that branch of work until then.
- **Decision ledger:** an append-only record of every decision and every agent action: who/what, when, why, the options considered, the evidence, what changed, model used, cost. It is filterable, linkable from every card and share view, and exportable for audit.
- **Learn on the way:** gates and decision cards carry short, contextual explanations of the field ("what quantization is and why it lets a 30B model fit in 24 GB", "what a refund policy needs"), so the human understands what they're signing.

---

## 6. Maximum utilization (capacity)
Derived from the author's anti-goal.
- The workspace keeps an inventory of **capacity**: each subscription (limits, reset windows, remaining quota), API budgets, cloud credits, and local hardware (GPU/CPU/RAM).
- A **router** sends each job to the most suitable capacity. Heavy reasoning goes to top models; cheap, high-volume work (summaries, feed narration, first-pass review) goes to local models when available.
- A **scheduler** queues non-urgent work into unused quota windows and idle hardware time.
- A **capacity panel** shows used vs. available per source, so waste is visible.

---

## 7. Architecture: core plus lifecycle packs
*(Structure proposed by me and accepted without objection.)*

**Core** (built first, shared by everything):
1. **Intake:** turns a described idea into a clear, reviewable plan, asking the questions that fill in missing context, and shows the plan in plain language before work starts.
2. **Agent orchestration:** launches and coordinates agents (via the providers' official tooling), each with a role, scope and budget.
3. **Glass-box activity:** captures every agent action and narrates it in plain language, with raw detail underneath.
4. **Decision ledger and readiness gates** (§5).
5. **Connections:** subscriptions, cloud accounts, local hardware, MCP servers, APIs, all in one place, with credentials owned by the Owner.
6. **Capacity router and scheduler** (§6).
7. **Workspace UI:** lifecycle board, panels, share view, roles.

**Lifecycle packs** (plug into the core; each brings its own know-how, agent playbooks, readiness gates and learning content):
web apps · mobile apps · backend/APIs · infrastructure · CI/CD · monitoring and observability · security. The community can contribute more (data pipelines, games, IoT…).

Open-source building blocks worth borrowing rather than rebuilding: Monaco (code and diff views), xterm.js (terminal view), MCP (tool connections), Claude Agent SDK and other official agent CLIs, Terraform/Pulumi (infrastructure), Electron or Tauri (desktop shell). VS Code itself was considered as a base and rejected: its file/editor-centric model is the wrong default for this user, and forking it is a heavy maintenance burden.

---

## 8. Constraints
- Open-source licence for the whole core.
- Cross-platform installer (macOS, Windows, Linux) that a non-technical person can complete.
- Credentials stay with the Owner (local machine or the Owner's own cloud). No third party holds them.
- Use providers only through their official tools and APIs, within their terms.
- The ledger must be complete: no agent action may bypass it.

---

## 9. First project (the dogfood test): Local Model Hub
The author builds this entirely through The Terminal. It exercises frontend, backend, infra, observability, a security gate, and the capacity loop.
- Detects the machine (Apple Silicon Mac or NVIDIA desktop) and explains in plain language what it can run.
- Recommends and installs suitable open-weight models (Llama, Qwen, Mistral, Gemma) using proven engines (Ollama/llama.cpp, MLX on Mac, vLLM on NVIDIA).
- Provides a chat interface plus a standard (OpenAI-compatible) API endpoint.
- Dashboard: GPU/memory usage, tokens/sec, health.
- Lets the Mac use models running on the desktop GPU over the home network, behind a **readiness gate** on network exposure.
- **Loop:** once running, The Terminal uses these local models as a capacity source (§6).

Note: Ollama and LM Studio already cover part of this; the goal is to test the workspace, not to compete.

---

## 10. Scope, enforcement and environment (settled after builder review)

### 10.1 First milestone: full core first *(author's decision)*
The author chose to build the **full core** before using The Terminal on Local Model Hub, rather than a thin slice. Milestone 1 therefore includes everything in §4–§7: intake, orchestration, glass-box narration, ledger and gates, connections, capacity router and scheduler, lifecycle board with modular panels, share view (link/present/PDF), own-cloud deploy, collaboration with all four roles and presence, and installers. Lifecycle packs are built after the core, with the order left to the builder (§11). The plan should still sequence the core internally so that each part can be tested as it lands.

### 10.2 Ledger completeness and gate enforcement *(my call)*
- **Mediate, don't reconstruct.** The Terminal intercepts every agent action **before** it executes, using the official permission and hook mechanisms of the agent tooling (e.g. Claude Agent SDK tool-permission callbacks and hooks, Codex CLI approval modes, Gemini CLI equivalents). Each action is recorded and can be held at a readiness gate. This follows from the author's "full audit trail of every decision".
- An agent integration is only supported if it allows this kind of interception. Integrations that can only be logged after the fact are out of scope for v1.
- **Isolation:** agents work only inside the project's own folder (git worktree per agent), with the tooling's built-in sandboxing where available. They never get unrestricted access to the user's machine. The builder chooses the isolation mechanism per OS, within the "no Docker setup for the user" constraint.

### 10.3 Subscriptions and provider terms *(my call, providers confirmed by the author)*
- **Day-one providers (author has all of these):** Claude Pro/Max (via Claude Code / Claude Agent SDK), ChatGPT Plus/Pro (via Codex CLI), Google Gemini (via Gemini CLI), and pay-per-use API keys (Anthropic, OpenAI, etc.).
- **Personal subscriptions are used locally, by their owner, through official tools.** Collaborators and always-on cloud agents use **API keys**, because consumer plans are generally licensed for one person's use. The workspace makes this distinction visible in the connections panel.
- **Provider terms (researched 14 Nov 2026):** Anthropic's documentation says third-party products built on the Claude Agent SDK should use API-key authentication. It does not permit routing requests through Free/Pro/Max/Ultra plans on behalf of users, or collecting or intermediating Claude.ai credentials, without prior approval. Gemini CLI's terms allow driving the official CLI, but extracting its OAuth tokens is a violation. Codex app-server supports ChatGPT login; the third-party terms are unverified.
- **Claude subscription is an opt-in, at the user's own risk** *(author's decision, 14 Nov 2026)*. Claude defaults to API keys (or Bedrock/Vertex credentials). A user may explicitly opt in to running Claude through **their own, unmodified, already-logged-in Claude Code installation**. The UI must show a clear warning that this may break Anthropic's terms and put their account at risk. The opt-in is recorded in the ledger with the exact warning text the user accepted. The Terminal never reads, stores, copies or proxies any Claude.ai credential or session token. The author will also ask Anthropic for written approval.
- **Everything ships inside The Terminal** *(author's decision, 14 Nov 2026: "i want everything to be packed from our app. everything should be handled by it")*. The agent programs are bundled with the app and used by default: Codex (`@openai/codex`, Apache-2.0), Gemini CLI (`@google/gemini-cli`, Apache-2.0), and Claude Code through the Claude Agent SDK, which ships its own Claude Code binary. Nothing has to be installed separately. Login modes still use the user's own login on the provider's own page; The Terminal never reads it. **Before public release**, confirm with Anthropic in writing that redistributing the Claude Agent SDK inside the app is permitted: its licence is "All rights reserved, subject to Anthropic's Legal Agreements".
- **Capacity data:** where a provider doesn't publish remaining quota or reset windows, the capacity system **estimates** them from observed usage and rate-limit responses and labels them as estimates. Exact numbers are used where available.

### 10.4 Machines and operating systems *(author's decision)*
- The author's setup: an **Apple Silicon Mac** and a **Windows desktop with an NVIDIA GPU, using WSL**.
- **The Terminal is installed on both machines, and the two instances are linked.** A project can span linked machines. Agents run on whichever machine the work requires (e.g. vLLM work on the desktop), and all actions land in **one shared project ledger** and one board. Linking is a core feature, not a Local Model Hub special case.
- **Installers in milestone 1:** macOS (Apple Silicon) and Windows (including setting up and using WSL for Linux tooling). Linux remains a goal (§8), but its installer can come after milestone 1 *(my call)*.

---

## 11. Left to the builder
- Programming languages, frameworks, and the desktop shell (Electron vs Tauri), within the constraints in §8. The author wants to **discuss** these choices rather than hand them over, so the plan should present recommendations for the author to approve.
- Storage format for the ledger and project state.
- Exact order of lifecycle packs after the core (the first project suggests infra, backend, frontend and observability come early).
- How intake questions are generated, and how agents are prompted per role.
- Visual design beyond the agreed layouts.

## 12. My calls (for the author to check)
1. Humans never edit directly; all changes go through agents; emergency override is logged in red.
2. Decisions and gates surface regardless of panel layout.
3. Installer silently installs prerequisites.
4. Subscriptions are used only via official tools and APIs.
5. Collaboration triggers a move to the Owner's cloud, with a temporary share link as the alternative.
6. Working name "The Terminal".
7. Every agent action is intercepted before it runs; only agent tooling that supports this is integrated.
8. Agents are confined to the project folder (one worktree per agent).
9. Collaborators and cloud agents use API keys, not personal subscriptions.
10. Quota is estimated where providers don't publish it, and labelled as an estimate.
11. Linux installer comes after milestone 1 (macOS and Windows/WSL first).

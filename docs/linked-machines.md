# Linked machines

This page describes how to link two Terminals on one local network, what that lets them do, and what never crosses between them. It also covers local models (Ollama and llama.cpp) and what keeps working without an internet connection. Where a part is still being built, a note in the page source marks it for checking.

## What linking is

Linking connects two computers that each run The Terminal and sit on the same local network, for example a Mac and a desktop with a strong graphics card. Once they are linked:

- each one can see the other's capacity (its hardware, its local models and which connections it has) in the Capacity view;
- you can ask the other one to run an agent for you, using its own models and connections, and decide what that agent may do from either computer;
- the entries the other computer records about that run come back to this one, signed, so this computer holds the whole story of the project.

**What crosses the link.** Capacity, cleaned first (hardware, local model names, and the names and kinds of connections). Run requests, with the project's repository. Signed ledger entries about a remote run. Your decisions about it.

**What never crosses.** API keys, logins, cloud secrets, MCP headers, local model keys, the machine's private identity key and the session token. Each computer keeps its own. When an agent runs on the other machine, it gets that machine's own connections. This computer only sends the ids of the connections it wants used.

Names that cross (the machine's name, connection names) are cleaned on the way: secrets are redacted, home folders and email addresses are replaced, and hidden characters are shown visibly.

## Turning it on

Linking is off until you turn it on, in the **Machines** view (activity bar). You are asked to accept this sentence exactly:

> I understand that enabling linking lets other computers on my local network reach this computer, that only computers I pair with a code can use it, and that agents they start run here with this computer's own connections. I choose to enable it.

- Linking uses a second port, **4418** (or the next free one, up to 20 above it). The workspace itself, with the board and the ledger, stays on this computer only, behind its session token. It is not reachable from the network.
- macOS and Windows ask whether to allow incoming connections the first time. Answer **Allow**, and on Windows choose the **private network** profile. If you refuse, the other computer cannot connect.
- Your choice is remembered until you turn linking off. The Terminal starts listening again by itself after a restart.
- The server that listens is the one the desktop app starts. Quitting the app stops it.
- Only IPv4 is used for now.

Turning linking off stops the listener right away. Computers you paired stay paired and can connect again when you turn it back on.

## Pairing

Pairing makes two computers trust each other. Do it once per pair, with both of them on.

1. On the first computer, open **Machines** and **Show a code**. It shows a 20-character code and this computer's addresses.
2. On the second computer, open **Enter a code**. Computers found on the network are listed. Pick one, or type its address (`host:port`). Then type the code.

What is in the code: the first part of the showing computer's fingerprint (so the other side can tell it reached the right computer) and a one-time secret. The secret is never sent. Both sides prove they know it, in a way that cannot be replayed on another connection.

- A code is valid for **10 minutes** and is used once.
- Five wrong tries close it. Show a new one to try again.
- If nothing answers when you type a code, the other computer is probably not showing one, or linking is off there.

### Compare the fingerprints yourself

The Terminal does not do this check for you. After pairing, both screens show a fingerprint: a few groups of four characters for each computer. Look at each machine's own fingerprint in **Machines**, under **This computer**, and check it is the same as the one the other computer shows for it. If they differ, unlink at once and start again.

### When the network hides computers

Computers find each other with mDNS, a way for devices on one network to announce themselves without a central server. Some networks and firewalls block it. Then no computer appears in the list, and you type the address shown under the code instead. The announcement carries only `TheTerminal-` and the first eight characters of the machine id, never your computer's name or your user name.

## How the link is protected

- Every connection is mutual TLS 1.3. Older TLS versions are refused.
- Each Terminal has its own identity key, kept in the OS keychain. The machine id is made from its public half.
- A computer accepts a connection only if the other side's key is one it paired with. There is no certificate authority and no shortcut. Anyone else on the network is cut off during the handshake, except while you are showing a code.
- The link listener serves link requests only. None of the workspace's routes can be reached on it.

## Running on another machine

<!-- verify: this whole section describes remote runs (Tasks 7c and 8b: routes and UI, still being built). Check each statement against the shipped routes, the Run on selector and GET /api/link/verify before merging. -->

Choose the other computer in **Run on** when you start a run. Then:

- The project is copied to that machine as a git bundle (a single file holding the repository). What you committed to the repository crosses, including files an agent wrote there. Your keychain, ledger and token are not in the repository, so they do not.
- The agent runs there under that machine's own approval gate, with that machine's connections and models. This computer sends only the ids of the connections to use.
- Decisions are made here and sent there. **The approval happens on the worker**: nothing runs on the other machine unless its own gate asks and a decision for that action arrives. You cannot run a command there that its gate has not approved.
- Every entry the other machine records about the run comes back signed with its key and is marked `On <machine>`. This computer checks the signature against the key it paired with before it records anything.
- When the run finishes, the changes arrive here as a bundle and appear in Changes, as for a local run.
- **The other machine keeps its own record** of what it did. Its ledger holds the run's entries, plus a note that it received the project from you, accepted the run and received your decisions. The project appears there as received from this computer.
- `GET /api/link/verify` re-checks every mirrored entry against the paired machine's key and tells you if any was altered.

**If the other machine sends something wrong.** A bad signature, an entry from another run, project or action, or an entry the worker is not allowed to send ends the run here and records it as failed. The Terminal treats a machine that sends these as compromised and does not carry on. Slow or out-of-order frames after a reconnect are not treated this way, and the next good entry is recorded.

**You cannot stop or decide a remote run from the local run controls.** The local Stop button and local decisions do not apply to a run that is on another machine. A request to do so is refused and never records a local "finished" entry. Stop and decide through the remote run's own controls. <!-- verify: remote Stop and decision routes and their wording (Tasks 7c and 8b) -->

## Local models

A local model is an open-weight model served on this computer by **Ollama** or **llama.cpp server**. The Terminal never installs them.

- **Detection.** Capacity looks, when you ask, for Ollama on `127.0.0.1:11434` and llama.cpp server on `127.0.0.1:8080`, and lists the models each reports. It looks nowhere else.
- **The connection.** Add a **Local model** connection in the Connections view (see [Connections and credentials](connections-and-credentials.md#local-models)): the server URL, the model name, the API style and an optional key.
- **Only Codex runs on local models for now.** Codex has first-class support for custom model providers. Claude Code and Gemini CLI have no supported local backend, and routing them through compatibility layers would mean getting around the providers' rules. Starting a Claude or Gemini run with a local model is refused.
- **The API style is `responses` by default.** The bundled Codex no longer accepts the older `chat` style, and Ollama and llama.cpp server both offer `responses`. A connection set to `chat` is refused at the start of the run with that explanation.
- **Loopback only.** The server address must be this computer's own (`127.0.0.1`, `localhost` or `[::1]`). The Terminal does not send an agent to a model server on the network, because such servers usually have no password.
- **The key stays out of the agent's reach.** If the server wants a key, the key is held in the keychain and handed to Codex as one fixed variable, `LOCAL_MODEL_API_KEY`, and never appears in the agent's commands, its prompt, the ledger or anything it reports. No other variable can carry a local model key.
- **Using the desktop's model from the Mac.** Run the agent on the desktop (a remote run), where the model is on its own loopback. The agent then uses the desktop's local model connection.

## Working offline

The Terminal does not need the internet for its own work. Without it, these keep working:

- opening the workspace, the board, cards, intake and gates;
- the ledger and its export, and every decision;
- the agent feed, changes, diffs and files;
- the Learn view;
- pairing and linked machines on your network (discovery, the link, capacity, remote runs, signed entries and decisions);
- runs on local models, on this computer or a linked one;
- hardware and local model detection, and the Capacity view's local figures;
- the desktop app.

These are degraded, with a plain message:

- cloud model runs fail at the provider, with the agent program's own error;
- cloud account credentials cannot be fetched, so a run that needs them does not start (`cloud_credentials_failed`);
- the GitHub view shows the last loaded data, marked stale, or `Could not reach GitHub`;
- connection tests of cloud providers say `Could not reach the provider`;
- signing in to a provider fails.

**The Offline indicator is a guess, and says so.** The status bar shows `Offline (inferred)` only. The Terminal never contacts a third party to find out. It watches the results of calls you caused (a connection test, a cloud grant, the GitHub view). If one fails because the name could not be found or the network was unreachable, it concludes you are offline. Any answer at all means you are online again. A refused connection or a timeout says nothing, so the state does not change. It never blocks anything.

## When things go wrong

- **A machine shows `offline`.** The last check could not reach it: it is asleep, off, on another network, or linking is off there. It is shown with its last known figures and when it was last seen. Nothing needs doing: the next check, when you open Machines or Capacity, finds it again. A remote run that was already going carries on there, and its entries are collected again after it returns. <!-- verify: resuming of a remote run after the worker comes back (Task 8b UI and 7c routes) -->
- **A machine's key changed.** If a paired machine answers with a different key from the one you paired with, this is not treated as offline. It could be a reinstall, or someone pretending. The Machines view warns that its key changed. Unlink it and pair again, and compare the fingerprints. <!-- verify: key-mismatch warning in the Machines view and the 409 machine_key_mismatch answer (Task 6b, not yet on the integration branch) -->
- **The keychain is unavailable.** The identity key lives in the OS keychain. If it cannot be read, linking is unavailable: the listener does not start, pairing is refused and Machines says so. Nothing is ever kept as a file instead. Unlock or fix the keychain and reopen the app. If the key is gone while the ledger remembers one, this computer gets a new identity and every machine must be paired again.
- **The other computer cannot find this one.** Check that linking is on at both ends, that the firewall allowed it, that both are on the same network (guest networks often separate devices) and try the address by hand.
- **Unlinking.** In **Machines**, choose **Unlink** on a machine and confirm. This computer stops accepting it right away. It is recorded in the ledger, and the other computer still lists the pairing until you unlink there as well. To use it again, pair again.

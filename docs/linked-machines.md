# Linked machines

This page describes how to link two Terminals on one local network, what that lets them do, and what never crosses between them. It also covers local models (Ollama and llama.cpp) and what keeps working without an internet connection.

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

Computers find each other with mDNS, a way for devices on one network to announce themselves without a central server. Some networks and firewalls block it. Then no computer appears in the list, and you type the address shown under the code instead. Looking for computers runs only when you open the **Machines** view or the **Link a machine** panel, which you do on purpose, and stops about a minute after you leave them. It never runs when the app loads or in the Agents view. The Run on list uses only the machines you already paired and looks at nothing on the network. The announcement carries only `TheTerminal-` and the first eight characters of the machine id, never your computer's name or your user name.

## How the link is protected

- Every connection is mutual TLS 1.3. Older TLS versions are refused.
- Each Terminal has its own identity key, kept in the OS keychain. The machine id is made from its public half.
- A computer accepts a connection only if the other side's key is one it paired with. There is no certificate authority and no shortcut. Anyone else on the network is cut off during the handshake, except while you are showing a code.
- The link listener serves link requests only. None of the workspace's routes can be reached on it.

## Running on another machine

Choose the other computer in **Run on** when you start a run. The list appears once at least one machine is paired. A machine that is offline is listed but cannot be chosen. When you choose one, the connections and local models offered are that machine's, and the agents offered are the ones it has.

- **Your prompt is cleaned before it is sent.** Secrets are redacted, home folders and email addresses are replaced, and hidden characters are shown visibly. Only the cleaned prompt is recorded and sent.
- **The project is copied** to that machine as a git bundle (a single file holding the repository). What you committed to the repository crosses, including files an agent wrote there. Your keychain, ledger and token are not in the repository, so they do not.
- **The run is approved on the machine that runs it.** The agent runs there under that machine's own approval gate, with that machine's connections and models. This computer sends only the ids of the connections to use. Nothing runs on the other machine unless its own gate asks and your decision for that action arrives. You cannot run a command there that its gate has not approved. Your decision is made here, on a card that says "This agent runs on <machine>. Your decision is sent there.", and goes to the worker. If the machine cannot be reached, the card says "Could not reach <machine>. Your decision was not sent." and the action stays waiting.
- **Every entry comes back signed.** The other machine's entries are checked against the key you paired with before anything is recorded, then shown as `On <machine>`.
- **Changes come back verified and wait for your review.** When the run finishes, the changes are fetched and checked: the file must be a valid bundle, must start from the project as you sent it, and must not clash with anything here. They then appear in Changes, as for a local run. Until then, the Changes view says "The changes arrive when the run finishes on <machine>". They are never merged automatically: you review them as you would any other run's.
- **A refused import is recorded and not retried.** If the changes fail those checks, this computer records that it refused them and why ("what it sent could not be read", "they clash with records here", "they do not start from the project as it was sent", "they name the wrong working copy", "the machine no longer has them" or, when you unlink the machine before they arrive, "the machine was unlinked before they arrived"). The Changes view and the ledger say so. It does not try again, because the same answer would come back. A failure that may pass, such as the machine being unreachable at that moment, is retried by itself.
- **The other machine keeps its own record** of what it did. Its ledger holds the run's entries, plus a note that it received the project from you, accepted the run and received your decisions. The project appears there as received from this computer.
- **Waiting uploads are limited.** Each machine may leave at most 4 project uploads and 1 GiB waiting on the machine that runs them. An upload that is never started expires after 1 hour and is removed, and the worker clears out old ones when it starts. Past a limit, the start is refused ("too many projects are waiting to start there").
- `GET /api/link/verify` re-checks every mirrored entry against the paired machine's key and tells you how many it checked and which, if any, were altered.

**If the other machine sends something suspicious, the run ends.** A bad signature, an entry from another run, project or action, an entry the worker is not allowed to send, or an entry that is not valid ends the run here and records it as failed ("The run on <machine> stopped: signature check failed"). The Terminal treats a machine that sends these as compromised and does not carry on. Slow or out-of-order entries after a reconnect are not treated this way: the next good entry is recorded.

**A changed machine key ends the run.** If the machine answers with a different key from the one you paired with, the run ends and is recorded as stopped because the machine's key changed. See "When things go wrong".

**You cannot stop or decide a remote run from your machine except through the worker.** Stop and your decisions on a remote run are sent to the machine that runs it. This computer never records its own "finished" entry or decision for that run: it records only what the worker reports back, signed. The answer to your request is not taken as proof either. If the machine cannot be reached, nothing is recorded and the run carries on there.

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

**The Offline indicator is a guess, and says so.** The status bar shows `Offline (inferred)` only. The Terminal never contacts a third party to find out. The word "inferred" is part of the label for that reason. It watches the results of calls you caused (a connection test, a cloud grant, the GitHub view). If one fails because the name could not be found or the network was unreachable, it concludes you are offline. Any answer at all means you are online again. A refused connection or a timeout says nothing, so the state does not change. It never blocks anything.

## When things go wrong

- **A machine shows `offline`.** The last check could not reach it: it is asleep, off, on another network, or linking is off there. It is shown with its last known figures and when it was last seen, or "never seen". Nothing needs doing: the next check, when you open Machines or Capacity, finds it again. A remote run that was already going carries on there. This computer keeps asking for its entries, and carries on from the last one it recorded, so none is recorded twice. While it waits, the machine shows offline. A silent connection (no sign of life for 2 minutes) is treated as lost and opened again. If the run's changes cannot be fetched yet because the machine is unreachable, that is tried again too.
- **"This machine's key has changed. Unlink it and pair again."** If a paired machine answers with a different key from the one you paired with, this is not treated as offline. It could be a reinstall, or someone pretending. The Machines view shows that sentence in place of the machine's figures, its dot and the status bar say `key changed`, the Run on picker lists it as `(key changed)` and the Capacity views show the state `key changed` with no figures; any remote run on it ends. Unlink the machine and pair again, and compare the fingerprints.
- **The keychain is unavailable.** The identity key lives in the OS keychain. If it cannot be read, linking is unavailable: the listener does not start, pairing is refused and Machines says so. Nothing is ever kept as a file instead. Unlock or fix the keychain and reopen the app. If the key is gone while the ledger remembers one, this computer gets a new identity and every machine must be paired again.
- **The other computer cannot find this one.** Check that linking is on at both ends, that the firewall allowed it, that both are on the same network (guest networks often separate devices) and try the address by hand.
- **Unlinking.** In **Machines**, choose **Unlink** on a machine and confirm. First, every run this computer has on that machine is asked to stop (a quick, best-effort request; a machine that is off or does not answer never holds up the unlink). Then this computer stops accepting it, and every remote run on it ends here as "the machine was unlinked". It is recorded in the ledger, and the other computer still lists the pairing until you unlink there as well; when it does, any run it was executing for this computer is stopped there too. To use it again, pair again.

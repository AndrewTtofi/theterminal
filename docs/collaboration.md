# Collaboration

This page describes how to invite other people into your workspace, what each role can see and do, how people sign in, and what the ledger records about them. It also covers turning on remote access, which is what lets anyone other than you reach the workspace at all.

Until you invite someone, nothing changes: the workspace is yours alone, on your own computer, behind the session token. To run it on a server for a team, see [Self-hosting](self-hosting.md).

## Who is who

There is always exactly one **Owner**: you. The Owner signs in on the computer that runs The Terminal, without a password, as before. Everyone else is invited, gets a name and a role, and signs in with a passkey or a key kept in their browser.

| Role | What it is |
|---|---|
| Viewer | Can see the board, every card's story, the ledger, the agent feed and who is here. Cannot change anything. |
| Reviewer | Everything a viewer can, plus deciding what agents may do, making plan decisions, moving cards and signing off gates that allow their role. |
| Maintainer | Everything a reviewer can, plus starting and stopping agents (on API keys), adding cards, running the intake and giving runs access to connections by name. |
| Owner | Everything. Only the Owner manages connections, people, remote access and gate requirements, and only the Owner holds credentials. |

The server checks the role on every request, so hiding a button in the screen is never the only protection. A person below the needed role gets a refusal, and the screen shows the control switched off with the reason.

### What each role can do, in words

- **Viewers** read. They see projects, the board, each card's story and gates, runs and their outcomes, the pending decisions, the agent feed, the ledger, who is here, and the status of the workspace. They can look after their own account: rename themselves, add or remove their own passkeys and keys, sign out of their own sessions.
- **Viewers do not see file contents or diffs.** The Changes view, a run's diff and its files are for **reviewers and above**, because a worktree can hold anything an agent wrote. A viewer who opens Changes sees a run picker and a note that only reviewers and above can open file contents. The list of changed files is behind the same rule, so a viewer does not see it either.
- **The ledger export needs a reviewer.** Reading the ledger on screen is for everyone, but the NDJSON export carries people's names, so it asks for a reviewer or above. Verifying a linked machine's mirrored entries is also a reviewer's.
- **Reviewers** decide. They answer what an agent asks to do (approve or deny), make plan and intake decisions, move cards between columns and sign off or waive a gate, as long as that gate allows their role (see "Gates" below).
- **Maintainers** work. They create projects and cards, change a card's status, start and stop runs, and run the intake (the questions that turn an idea into cards). They can tick connections for a run by name.
- **Only the Owner** adds, edits or removes connections and their secrets, signs in to provider subscriptions, runs Detect in the Capacity view, uses the emergency override, pairs or unlinks machines, manages people and invitations, switches remote access, changes who may sign a gate, and previews, confirms and shares a Share view.

## Inviting someone

Open **People** and choose **Invite someone**. Pick the role (viewer, reviewer or maintainer; there is only one Owner), and The Terminal shows a link.

- **The link is shown once.** It holds a one-time code. Copy it then; it is not shown again, and The Terminal does not keep the code in a form it can show you later. If you lose it, revoke the invitation and make another.
- **It works once and expires after 7 days.** Pending invitations are listed under People, and you can revoke one at any time. A used, revoked or expired link answers as if it never existed.
- **Send it over a channel you trust.** Anyone who gets the link before the person you meant can join in their place. You can see who joined in the People list and remove them.
- **Roles other than Owner only.** There is no way to invite a second Owner or to promote anyone to Owner.

The person opens the link and sees the role they are invited to and what it allows. They type the name that will appear in the ledger beside everything they do, and create a passkey or a key (see below). They are signed in straight away.

### The fingerprint in the link

A link to a workspace reached over the network ends in `#fp=` followed by a fingerprint: a short code that identifies the certificate the workspace uses. It exists so the person can tell they reached your workspace and not something in between.

**The join page cannot check it for you.** It shows two things: the fingerprint in the link, and the fingerprint this connection reports. It never says they match, because a page cannot see which certificate the browser accepted, and an interceptor would simply report the fingerprint it had copied from you. Only your browser's own certificate details can tell.

To compare it yourself:

1. Click the lock icon next to the address in the browser, and open the certificate details.
2. Find the SHA-256 fingerprint.
3. Check it is the same as the one in the link, group by group.

If they differ, stop. Do not type a name or create a key. Ask the Owner, over another channel, for the fingerprint and the link again: someone may be intercepting the connection. If the link carries something that is not a fingerprint at all, the page refuses to go on.

With a trusted certificate (Let's Encrypt, see [Remote access](#remote-access)) the browser checks the certificate for you and shows no warning. The fingerprint is then a second confirmation. With a self-signed certificate, the browser warns that it does not know the certificate. Continue only after the fingerprints match.

## Passkeys and browser keys

A person proves who they are with one of two kinds of credential. Both are asked for again on every sign-in; there are no passwords.

- **A passkey** lives in the person's device or password manager and is unlocked with a PIN, fingerprint or face. The Terminal always asks for that check, never just for a touch. It works only on a **name**, such as `workspace.example.com`.
- **A key for this browser** is created in the browser and kept there. It proves identity the same way a passkey does, without the device check, and only that one browser can use it. It is the way in when passkeys are not possible.

**Passkeys do not work on raw IP addresses.** Browsers refuse them there, so a workspace reached as `https://192.168.1.20:4318` cannot use them. The join page then says that this browser cannot use passkeys here and creates a key for this browser instead. To get passkeys, give the workspace a name (a domain, or a name your network resolves).

Each person can hold several credentials. Under **People**, **Add a passkey** and **Add a key for this browser** add another one, for example on a new laptop or a phone. Nobody can remove their last credential, the Owner included, or they would be locked out: the Owner's session token opens the workspace on this computer only, so on a server reached over the network their passkey or key is their only way in. Add another credential first, then remove the old one. Removing a lost device's credential is how you cut it off.

## Signing in, sessions and lockouts

- **The Owner** signs in on the computer that runs The Terminal with the session token, as always. On the network, the Owner signs in with a passkey or key like everyone else, and **turning on remote access needs the Owner to have one** first. Add one under People.
- **Others** open the workspace's address, go to the sign-in page and use their passkey or key.
- **A session lasts 14 days** and is a cookie that scripts cannot read, never sent to other sites, and sent over TLS only on the network.
- **A session belongs to one way in.** A session made on the local address does not work on the network address, and the other way round. This is why the Owner is shown as signed in separately in each.
- **People see their own sessions** under People, each marked "This computer" or "Over the network", with when it started and was last used. Each can be signed out on its own, or **Sign out everywhere** ends all of them. The Owner can sign out any person's sessions.
- **Role changes and removal take effect at once.** The role is looked up on every request, not stored in the session, so promoting or demoting someone applies to the next click. Their open live connections are closed, and the screen asks who is signed in again. Removing a person ends every session they hold immediately, and their credentials stop working. Their name stays in the history of what they did.
- **Five failed sign-ins for the same credential from the same address lock that pair for 15 minutes.** The lockout is recorded in the ledger once. Someone else, or the same person from another address, is not affected.
- **Rate limits.** The join and sign-in endpoints answer at most 10 requests a minute from one address (one /64 for IPv6). Past that they answer "too many requests" and say when to try again. When The Terminal runs in Docker, the address it sees may not be the client's, see [Self-hosting](self-hosting.md#client-addresses).

## What the ledger records about people

The ledger records: that someone was invited, revoked and joined, with their name and role; renames; role changes; removals; credentials added and removed (the label, never a key); sign-ins (which way: local or remote, and by passkey or key); and lockouts.

It does not record: session ids or cookies, IP addresses, browser or device details (user agent), or anything that could be used to sign in. Presence (below) is not recorded at all.

A person's name is cleaned before it is recorded, like any text: control characters are shown visibly, and a name that looks like a secret is refused.

## Gates and who may sign them

Each readiness gate says who may sign it or waive it. The defaults:

- A **reviewer or above** signs the plan approval and ready to ship.
- **Only the Owner** signs network exposure, payments, personal data, go live and over budget.

The Owner can change this for a project: on the gate's card, **Change who may sign** offers a role (reviewer, maintainer or Owner) or one named person. A gate that a person may not sign shows "You cannot sign this gate. It needs ..." and its buttons are off. The server refuses too, and records nothing. Changing the requirement is itself recorded. Waiving or signing a gate is recorded with the person's name.

## Collaborators and connections

**Collaborators never see how a connection is set up.** Everyone but the Owner sees connections by **name** and kind, and whether each is working: no settings, no keys, no server addresses, commands, folders or regions. The Owner's own view of a connection is the only place its settings are shown. Entries in the ledger about connections show collaborators the sentence, not the configuration.

**Collaborators' runs use API keys only.** A maintainer starts an agent run with the connections they pick by name. That run is always on an API key, never on anyone's personal login:

- A key comes from a connection the Owner added, or from the server's own environment variable for the provider.
- With neither, the start is refused with "No API key is configured for ... Ask the Owner to add one in Connections." Nothing is recorded.
- The agent program is given an empty home folder of its own for its settings, so it cannot find the Owner's saved logins, even by accident.

Collaborators can pick what a run may use, by name; they cannot add one. The Capacity view for non-Owners shows what is available without plans, budgets or the Owner's modes; the status bar does not show them the summed monthly budget, and the agents list does not show how each provider is signed in.

## Who is here

**People** and the side bar show who is looking at the workspace, which project, and which view. Presence is **in memory only**: it is never written to the ledger or to disk, it holds no address or session detail, and it is gone when the server stops. Someone who goes quiet drops off after 5 minutes. It exists so two people do not review the same run without knowing.

## Removing a person

The Owner chooses **Remove** next to a person under People. Their sessions end at once, their passkeys and keys stop working, and a record is added to the ledger. What they did stays, under their name. A removed person's name still appears in earlier decisions on the Share page.

You cannot remove yourself, and you cannot change the Owner's role.

## The Share view and people

The [Share view](share-view.md) now names people:

- A decision shows the name of whoever signed or decided it.
- What is waiting on a human reads "a reviewer or above" instead of a person.
- The Owner appears under the name the Owner chose.
- A decision by someone who has since left reads "a former collaborator" only when nothing of them is recorded; a removed person's name stays.

Pages you confirmed before this release are unchanged, and still say "Owner": a confirmed page is never rewritten.

## Runs on a linked machine

When a collaborator asks for a run on a [linked machine](linked-machines.md), the requesting computer's ledger names the person who asked. The other machine's own ledger records the Owner as the requester: the link does not yet carry the person across. The run is on an API key there too.

## Remote access

**Remote access is off by default.** Nothing but your own computer can reach the workspace until the Owner turns it on in **People**, **Remote access**: "Allow people on the network to reach this workspace". Turning it on means The Terminal listens on **all of the computer's network addresses (`0.0.0.0`)**, on a port you choose (4318 by default), over TLS only. There is no plain-HTTP workspace on the network.

Things to know:

- **The token is never accepted on the network.** The local session token works only on the local address. On the network, only a person's session does.
- **Remote access can be turned on only from the local address,** by the Owner.
- **The Host rule.** On the network, a request must name this listener. With a domain set, that is the domain, the domain with `:443`, or the domain with the port. Without a domain, it is any IP address with the port (the address a router or Docker forwards to the computer is not one the computer knows as its own), or the computer's own host name with the port. Any other name is refused with `bad_host`. This stops other sites from pointing a name at your computer and talking to it; an IP address cannot be pointed anywhere. The health check (`/healthz`) is the one exception.
- **Origin checks.** Calls from a page on another site are refused.
- **Your firewall and router.** Reaching the workspace from other places is up to your firewall and your router's port forwarding. On macOS and Windows the system asks whether to allow incoming connections the first time. Answer **Allow**, and on Windows choose the private network profile unless you mean to publish it wider.
- **Turning it off** closes the network listener and every open network connection at once. Network sessions are separate from the local one, so the Owner at the computer is unaffected.

### Certificates

Pick one of three:

- **Self-signed** (the default). The Terminal makes a certificate for the computer's own names and addresses, valid for ten years, and keeps its key in the secret store. Browsers warn about it, because nobody they trust vouches for it. That is why invitation links carry the certificate's fingerprint: people compare it, as above, once. The fingerprint is shown in People under Remote access, with a Copy button, and in the log of a headless server.
- **Let's Encrypt (`acme`).** With a domain, the Owner gets a trusted certificate and browsers show no warning. This needs:
  - a **domain** (a name such as `workspace.example.com`, never an address) with a DNS record pointing at this computer;
  - **port 80 reachable from the internet** to this computer. Let's Encrypt checks you control the domain by fetching a file from port 80 (the HTTP-01 check). While the certificate is used, port 80 answers only that check and sends everything else (GET and HEAD) to `https://<your domain>` with a 301. The target is built from your configured domain, never from the request;
  - **port 443**, or the port you chose, reachable for people.

  Enabling can take **up to 3 minutes**, because The Terminal waits for the certificate to be issued; after that it fails with a short reason. The Terminal accepts Let's Encrypt's subscriber agreement on your behalf when you choose it. The certificate is **renewed by itself**: it is checked twice a day and renewed when less than 30 days remain, and port 80 stays open for that. The account key and the certificate key are kept in the secret store, never in a file or the ledger.
- **Your own certificate (`provided`).** Give the paths to a certificate and its key. The domain must match it.

**Hairpin NAT.** If the computer is behind a home or office router, testing from inside your own network with your own domain may fail even when it works from outside, because many routers do not send traffic for their own public address back in (this is called hairpin NAT). Test from a phone on mobile data, or add the computer's inside address to your DNS inside the network.

**Proxies.** Certificate orders go out through `HTTPS_PROXY`, and skip hosts in `NO_PROXY`, if those environment variables are set for the server. Port 80 and your domain still need to be reachable by Let's Encrypt itself, which does not use your proxy.

**Privileged ports.** On Linux, a normal user cannot listen on port 80. Enabling Let's Encrypt there then fails and remote access stays off. Run in Docker (see [Self-hosting](self-hosting.md)), or give the program permission to bind low ports, or use a self-signed or provided certificate.

## Where to read more

- [Self-hosting](self-hosting.md): running the workspace on a server.
- [Connections and credentials](connections-and-credentials.md): what is stored where.
- [Share view](share-view.md) and [Linked machines](linked-machines.md).

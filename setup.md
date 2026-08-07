# Setup Guide — SS Remote (no VPS)

Use this when you and a friend are in different places (for example India ↔ US) and you **do not** want to rent a server. Everything runs on your two PCs. When the host runs `ss start all`, a free public tunnel is opened automatically so the connection works over the internet.

---

## What you need

On **both** computers:

1. [Node.js 18+](https://nodejs.org/) (LTS)
2. This project folder (copy via USB, zip, GitHub, etc.)
3. Internet access

No VPS. No paid account required.

| Role | Who | What they run |
|------|-----|----------------|
| **Host** | Person whose PC will be controlled | `ss start all` |
| **Controller** | Person who watches and controls | `ss connect <url>` |

---

## 1. Install on both PCs

```bash
cd "Remote Access"
npm install
npm link --workspace=ss
```

Check:

```bash
ss help
```

Agree on a secret pair code (any short string). On **both** PCs:

```bash
ss config set pairCode our-secret-2026
```

---

## 2. Host PC (the one being shared)

```bash
ss start all
```

What this does:

1. Starts a local relay on your PC
2. Opens a **free public internet tunnel** to that relay (localtunnel by default)
3. Starts the silent screen-share agent (no extra windows)

You will see something like:

```text
Send this command to your friend:

  ss connect wss://some-name.loca.lt
```

Copy that whole `ss connect …` line and send it to your friend (WhatsApp, Discord, email, etc.).

Useful host commands:

```bash
ss status          # see if relay / tunnel / agent are up
ss share           # print the public link again
ss logs            # live agent/relay logs (Ctrl+C to stop)
ss logs --once     # print recent lines and exit
ss logs clear      # empty the log file
ss stop all        # stop sharing
```

### Host shortcuts (privacy / pause control)

While the agent is running, use these on the **host keyboard** (works even if another app is focused):

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+L` | Disable remote mouse & keyboard (screen share continues) |
| `Ctrl+Alt+U` | Resume remote mouse & keyboard |

On Windows these use the built-in hotkey API (no extra binary). If a shortcut is already taken by another app, change it with `ss config set`.

The controller sees a label: **Keyboard and Mouse disabled**.

### Host priority (auto)

If the **host** uses their own mouse or keyboard while someone is connected, remote control is paused automatically so both sides don’t fight. The controller sees:

**Host is using this PC**

When the host stops for about 2 seconds, control returns to the controller (unless you locked with `Ctrl+Alt+L`).

```bash
ss config set hostPriorityMs 2000
```

Change shortcuts if you want:

```bash
ss config set lockInputShortcut Ctrl+Alt+L
ss config set unlockInputShortcut Ctrl+Alt+U
```

Then restart the host agent (`ss stop all` → `ss start all`).

### Optional: more reliable Cloudflare tunnel

If localtunnel feels flaky, use Cloudflare’s free quick tunnel instead (downloads a small helper once, still no account/VPS):

**Windows (PowerShell):**

```powershell
$env:SS_TUNNEL="cloudflare"
ss start all
```

**macOS / Linux:**

```bash
SS_TUNNEL=cloudflare ss start all
```

The share link will look like `wss://….trycloudflare.com`.

### Switch back to localtunnel (leave Cloudflare)

`$env:SS_TUNNEL` only affects the **current** terminal. To stop using Cloudflare:

**Windows (PowerShell) — same window where you set it:**

```powershell
Remove-Item Env:SS_TUNNEL
```

Or force localtunnel:

```powershell
$env:SS_TUNNEL="localtunnel"
```

Then restart:

```powershell
ss stop all
ss start all
```

**macOS / Linux:** just open a new terminal (or unset the variable) and run `ss start all` normally — do **not** prefix with `SS_TUNNEL=cloudflare`.

```bash
unset SS_TUNNEL
ss stop all
ss start all
```

A new terminal window never has `$env:SS_TUNNEL` set, so `ss start all` uses localtunnel by default.

---

## 3. Controller PC (you / the friend who controls)

After installing the project and setting the **same** `pairCode`:

Paste and run the command the host sent:

```bash
ss connect wss://some-name.loca.lt
```

That saves the public URL and opens the viewer. Click the remote screen to focus it, then use mouse and keyboard normally.

If you prefer manual steps:

```bash
ss config set relayUrl wss://some-name.loca.lt
ss config set pairCode our-secret-2026
ss viewer
```

---

## 4. End the session

On the **host**:

```bash
ss stop all
```

The public link dies with the tunnel. Next time the host runs `ss start all`, you get a **new** URL — send the new `ss connect …` line again.

---

## Same Wi‑Fi / same house only

If both PCs are on the same network and you do not need the internet tunnel:

```bash
# Host
ss start relay
ss start agent

# Controller — use the host's LAN IP, e.g. 192.168.1.20
ss config set relayUrl ws://192.168.1.20:9000
ss viewer
```

---

## Tuning for long distance (India ↔ US)

Higher latency is normal across continents. If video feels heavy:

```bash
ss config set fps 8
ss config set maxWidth 1280
ss config set quality 45
```

Then restart the host:

```bash
ss stop all
ss start all
```

---

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| `ss` not found | Run `npm link --workspace=ss` again from the project root, or use `npm run ss -- start all` |
| Tunnel timeout | Check host internet; run `ss start all` again; or try Cloudflare mode below |
| Viewer cannot reach relay | Host must keep `ss start all` running; use the **latest** URL from `ss share` |
| Browser password page on loca.lt | Use Cloudflare mode: `$env:SS_TUNNEL="cloudflare"; ss start all` |
| Black / waiting screen | Confirm both PCs use the same `pairCode` (`ss config`) |
| Mouse/keyboard not working | Click inside the viewer canvas so it has focus |
| Cursor feels offset / laggy | Restart host after update (`ss stop all` then `ss start all`). Click the screen once. |
| Copy/paste not syncing | Click the remote screen, then use Ctrl+C / Ctrl+V as usual. Text clipboard only (not files/images). |
| Agent log | `~/.ss-remote/agent.log` (Windows: `C:\Users\<you>\.ss-remote\agent.log`) |

---

## Security (personal use)

- Anyone who has the live tunnel URL **and** your `pairCode` can try to connect while the host is sharing
- Use a non-obvious `pairCode`
- Run `ss stop all` when you are done
- Only share the `ss connect` link with the person you trust

This project has no login system by design — it is meant for two people who already trust each other.

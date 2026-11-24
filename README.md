# DecLoc Chat — Decentralized Local Chat

> [Jump to Estonian version / Eesti keeles ↓](#decloc-chat--detsentraliseeritud-kohalik-vestlus)

**DecLoc Chat** is a lightweight, zero-dependency, end-to-end encrypted (**E2EE**) group chat web app (PWA).

You do **not** need a company account, phone number, email address, app store, or heavy cloud backend. You can run it in **2 minutes for free on GitHub Pages**, or host the entire chat + private database yourself on an **old Android phone (Termux)**, a **Raspberry Pi**, a **laptop**, or a **small VPS**.

---

## What It Can Do (Features)

* **Zero build step, zero external libraries:** plain HTML, CSS, and JavaScript. No `npm install`, no Docker required.
* **Private password-protected chatrooms:** create as many group or 1-on-1 rooms as you like. Share a **1-click invite link** (or tell your friend the room name + passphrase out loud).
* **True End-to-End Encryption (E2EE):**
  * All messages, reactions, read receipts, and call signals are encrypted inside your browser (`PBKDF2` + `HMAC-SHA256` + `AES-256-GCM`) before leaving your device.
  * Invite link secrets live in the URL `#join=...` fragment, which browsers **never** send to web servers.
  * Each room derives a separate cryptographic identity for you so public relays cannot link your activity across different rooms.
* **Strict per-room locked relays (no cross-leaks):**
  * When creating a room, choose either **Public Nostr relays** (5 open defaults that you can toggle individually in Settings) **OR** a **Custom relay** (your own phone/VPS relay `wss://...` or a public `.onion` Nostr relay in Tor Browser).
  * Once created, a room is permanently locked to that relay choice — private-relay rooms **never** send traffic to public relays.
* **Optional Personal Password (portable identity + device lock):**
  * Leave blank for instant device-only access, **or** set an optional personal password to keep the exact same verified identity across phones/computers (and delete your own past messages from any device).
  * Optionally enable **Device lock** to store your key encrypted (`AES-256-GCM`) and require your password when reopening the app.
* **Unforgeable Room Handles (`Name-xxxx`), Persistent Members & Archived Tags:**
  * Every participant automatically gets a room-unique 4-character alphanumeric tag (e.g. `Jaan-4fl7`) derived cryptographically from their room key — impossible to edit or spoof, so two people with the same name are always distinguishable.
  * When someone renames (e.g. `Jaan-4fl7` → `Ott-56gb`), the change is signed and hash-linked like a mini blockchain in that room; clicking any name shows their full verified name history.
  * The **Members** list shows everyone in the room (both **Online** and **Offline**). If a user leaves and erases all their data from the room, their messages and display name are completely removed from Members and only their last unique code (e.g. `archived-56gb`) remains under **Archived members**. If 4-char codes ever saturate (e.g. bot flood), the oldest archived tag is released one-by-one (**FIFO**); if all slots are held by active members, tags automatically expand **4 → 5 → 6…** characters so the room never hits a member cap.
* **Delete only your own messages from everywhere:** delete individual messages or all of your messages in a room — removes them from your browser, sends a standard **NIP-09 (`kind: 5`)** deletion request to Nostr relays, and sends an encrypted delete instruction to other participants' devices. Only the original author can delete their own messages.
* **Room Creator & Admin Governance (`Name-xxxx (admin)`):**
  * The creator of a room automatically becomes its founding **Admin** (`(admin)` badge in Members, messages, and identity history) and can grant or revoke admin rights (`+Admin` / `−Admin`) for other members so a room can have multiple admins.
  * Any Admin can **block & erase** a member from the room (wiping their messages across all devices and physically deleting them on `relay/server.mjs`), **generate a new room password** (automatically migrating all non-blocked members via per-member **secp256k1 ECDH + AES-256-GCM** encrypted envelopes so blocked users cannot re-enter under a new name), or **delete the entire room everywhere** (wiping all participants' messages, the room itself, and all SQLite room events).
  * If an Admin wants to delete themselves from a room that has other active members, they **must designate another member as the new Admin** (who inherits full authority to manage and nuke the room); if the Admin is the **only member in the room**, deleting themselves completely from the room automatically deletes the entire room everywhere.
* **Read receipts ("Seen by"):** subtly shows who saw the latest message and at what time (can be turned off in Settings).
* **Full Emoji & GIF support:** 450+ categorized emojis with offline English & Estonian search, recent emojis, `+` full emoji reactions on messages, plus GIF support via direct `https://` URLs or an optional free **GIPHY API key**.
* **P2P WebRTC voice & video calls:** direct peer-to-peer calls inside any room with 4 Messenger/WhatsApp-style layouts (**Compact**, **Grid**, **50/50 Split**, **Spotlight + PiP**), front/rear camera switch, **Screen Wake Lock** (keeps mobile screens awake), automatic camera & ICE-restart recovery after screen lock or network switches, and optional **TURN server** support in Settings for strict 4G/5G NATs.
* **Strong Multi-Channel Notifications:** 1-click bell (`🔔`) in the header enables OS notifications (Desktop, Android Chrome, iOS 16.4+ PWA), louder 2-note chime + mobile vibration, incoming call ringtone, blinking tab title + red-dot unread favicon badge, PWA home-screen app badge, built-in **VAPID Web Push** on `relay/server.mjs` (wakes locked/closed mobile browsers!), and optional privacy-safe **`ntfy.sh`** push alerts for static GitHub Pages.
* **Installable PWA:** add to your phone's home screen like a normal app. Includes dark/light theme, English (default) & Estonian interface, and profile backup export/import.

---

## Quick Beginner Guide: How Everyday Chatting Works

If you just want to use the app with non-technical friends or family:

1. **Open the chat link** in Chrome, Safari, or Firefox.
2. **Pick your display name** (e.g. `Alex`).
   * *Optional:* you can also set a **Personal Password** (private to you — NOT shared with anyone). It lets you sign in with the same verified `#xxxx` identity on another phone and optionally lock the app on your device. If you skip it, everything still works immediately!
3. **Create a room:** click **+ New room**, type a room name (e.g. `Family`), keep the auto-generated passphrase (or write your own), and choose **Public relays** or **Custom relay**.
4. **Invite friends:** click **Invite → Copy invite link** (or **Share…** on mobile) and send the link to your friend.
5. **Your friend clicks the link**, types their name, and is immediately inside the encrypted group chat!
6. **Install like an app (optional):**
   * **Android (Chrome):** tap the `⋮` menu → **Add to Home screen** / **Install app**.
   * **iPhone (Safari):** tap the Share icon (`↑`) → **Add to Home Screen**.

> **Tip — two different passwords:**
> * **Room passphrase** = shared with everyone in that room (the key to enter and decrypt that room).
> * **Personal password (optional)** = private only to *you*, proves your `#xxxx` identity across devices and optionally locks your browser.

---

## Step-by-Step Setup Options (Choose the One That Fits You)

### Option 1: Easiest — Free on GitHub Pages (0 servers, ~2 minutes)

Best if you want **zero server maintenance** and want to use the open public Nostr relays.

**Step 1:** Click **Fork** on this GitHub repository (or upload these files into a new public GitHub repository).

**Step 2:** In your repository on GitHub, open **Settings → Pages**.

**Step 3:** Under **Build and deployment**:
* **Source:** `Deploy from a branch`
* **Branch:** `main` and folder `/ (root)`
* Click **Save**.

**Step 4:** Wait ~1 minute and refresh the page. Your chat is now live at:
```text
https://<your-github-username>.github.io/<repo-name>/
```

#### Optional: Connect Your Own Subdomain (e.g. `chat.yourdomain.com`)

1. Open your domain provider's **DNS settings** and add one `CNAME` record:
   ```text
   Type:  CNAME
   Name:  chat
   Value: <your-github-username>.github.io
   ```
2. In GitHub **Settings → Pages → Custom domain**, enter `chat.yourdomain.com` and click **Save**.
3. Wait a moment for DNS to verify, then check **Enforce HTTPS** (GitHub automatically provides a free SSL certificate).

---

### Option 2: Self-Host on an Old Android Phone (Termux + Cloudflare Tunnel)

Best if you want **both the web app and your own private SQLite Nostr relay database** to live physically on your old Android phone — works even on **4G/5G mobile data (CGNAT)** with **zero router configuration** and **zero accounts**!

**Step 1: Install Termux on the old Android phone**
* Download and install **Termux** from **[F-Droid](https://f-droid.org/packages/com.termux/)** *(important: do not use the outdated Google Play Store version)*.
* In Android Settings → Apps → Termux → Battery, set battery usage to **Unrestricted** so Android does not put the server to sleep.

**Step 2: Install Node.js, Git, and Cloudflare Tunnel inside Termux**
Open Termux and run these commands one by one:
```bash
pkg update && pkg upgrade -y
pkg install -y git nodejs cloudflared
```

**Step 3: Download DecLoc Chat**
```bash
git clone https://github.com/<your-username>/<your-repo>.git decloc-chat
cd decloc-chat
```

**Step 4: Start the chat server + free no-account tunnel**
```bash
bash relay/start-termux.sh
```
*(Or make it executable once with `chmod +x relay/start-termux.sh && ./relay/start-termux.sh`.)*
After a few seconds, Termux prints a public link that looks like:
```text
https://something-random.trycloudflare.com
```
Open that link in any browser and share it with friends!
* DecLoc Chat automatically detects your phone's built-in relay (`/decloc-relay.json`) and pre-selects **your phone's relay** when creating rooms.
* All encrypted messages are saved in `relay/data/decloc-relay.db` (SQLite) on your phone and **survive phone restarts**.
* Note: the free no-account `trycloudflare.com` URL changes whenever you restart the tunnel (your saved messages stay safely in `decloc-relay.db`).

#### Optional: Permanent Custom Domain with a Free Cloudflare Account
If you want a **permanent address** (like `https://chat.yourdomain.com`) that never changes on reboot:
1. Create a free account at Cloudflare and add your domain's DNS.
2. Go to **Zero Trust → Networks → Tunnels → Create a tunnel**, point `chat.yourdomain.com` to `http://127.0.0.1:7777`, and copy the tunnel token.
3. Run in Termux:
   ```bash
   bash relay/start-termux.sh --token YOUR_CLOUDFLARE_TUNNEL_TOKEN
   ```

#### Optional: Keep Running in the Background While Using Termux (New Session or `tmux`)
Do **not** press `Ctrl + C` (that stops the server):
* **Easiest way in Termux:** swipe from the left edge of the screen → tap **NEW SESSION** to open a second terminal tab while the server keeps running in the first session.
* **Or use `tmux`** (especially handy over SSH):
```bash
pkg install -y tmux
tmux new -s decloc
bash relay/start-termux.sh
```
* Once the link appears on screen, press **`Ctrl + B`**, release, and press **`D`** (*detach*) — the server keeps running in the background and you can use Termux normally.
* To reopen the server screen later:
  ```bash
  tmux attach -t decloc
  ```
* Also tap **Acquire wakelock** on the Termux notification in Android's notification shade so Android does not put the server to sleep.

> **Battery tip:** If an old phone stays plugged in 24/7, enable a battery charge limit (60–80%) in Android settings if your phone supports it, so the battery stays healthy long-term.

---

### Option 3: Run on Your Computer or Raspberry Pi (Testing or Home Network)

Requires **Node.js 22+** (uses built-in `node:sqlite`, zero `npm install` needed; older Node 18/20 falls back automatically to an NDJSON file).

**Step 1: Start the built-in server (web app + local SQLite relay)**
```bash
node relay/server.mjs
```

**Step 2: Test in your browser**
* Open `http://localhost:7777` in your browser and create a room.
* Copy the **Invite link** and open it in an **Incognito / Private window** to test chatting, reactions, read receipts, deletion, and calls between two users right away!

**Useful CLI flags for `relay/server.mjs`:**
```bash
# Listen on your local Wi-Fi / LAN network on port 8080:
node relay/server.mjs --host 0.0.0.0 --port 8080

# Store the SQLite database in a custom folder:
node relay/server.mjs --data /path/to/my-data

# Run ONLY the Nostr relay (e.g. if your web app is on GitHub Pages):
node relay/server.mjs --no-static --port 7777

# See all options:
node relay/server.mjs --help
```

*(To test static-only mode with public relays without the local relay, run `python3 -m http.server 8080` and open `http://localhost:8080`.)*

---

### Option 4: 100% Independent Self-Hosting on Any Linux VPS (with Auto-HTTPS)

Best if you want a **permanent 24/7 private server** with your own domain, independent of both GitHub and Cloudflare (~3–4 €/month on providers like Hetzner or OVH).

**Step 1: Install Node.js (v22+) and Caddy on the VPS (Debian/Ubuntu example)**
```bash
sudo apt update && sudo apt install -y git caddy
# Install Node.js 22 (via NodeSource or nvm)
```

**Step 2: Clone and start DecLoc Chat**
```bash
git clone https://github.com/<your-username>/<your-repo>.git /opt/decloc-chat
cd /opt/decloc-chat
node relay/server.mjs --host 127.0.0.1 --port 7777
```
*(In production, run it via `systemd` or `tmux` so it restarts automatically.)*

**Step 3: Point your domain DNS `A` record (`chat.yourdomain.com`) to your VPS IP, and add 3 lines to `/etc/caddy/Caddyfile`:**
```caddyfile
chat.yourdomain.com {
    reverse_proxy 127.0.0.1:7777
}
```
Reload Caddy (`sudo systemctl reload caddy`) — Caddy automatically obtains and renews a free Let's Encrypt HTTPS certificate (with full `wss://` WebSocket support)!

---

## Strong Notifications & Lock-Screen Push Alerts

To make sure you never miss a message or incoming call:
1. **1-click Notifications:** Click the bell icon (`🔔`) in the top-left header (or open **Settings → Notifications → Test sound & alert**) to enable OS pop-ups, sound, vibration, blinking tab title, red unread badge on the browser tab & PWA icon, and incoming call ringtones.
2. **Waking closed/locked phones when self-hosting (`relay/server.mjs`):** Built-in **VAPID Web Push** (`RFC 8292` + `RFC 8291`) is automatic! Once you install the PWA and click `🔔`, your own server wakes your phone even when the browser is closed (only a generic *"New encrypted message"* / *"Incoming voice/video call"* alert is sent — never message plaintext).
3. **Waking closed/locked phones on static GitHub Pages (optional `ntfy.sh`):** Install the free **ntfy** app (Android/iPhone/Desktop), generate a secret topic URL in **Settings → Optional ntfy.sh push URL**, and subscribe your group to that same topic in the ntfy app. Again, only a generic privacy-safe alert is sent — never your chat text.

---

## Using Public `.onion` Nostr Relays (Tor Browser)

DecLoc Chat supports `.onion` Nostr relays in **Custom relay** mode:
1. Open DecLoc Chat in **Tor Browser** (or Brave's Tor window).
2. Click **+ New room** → select **Custom relay** → paste a `.onion` Nostr relay address (e.g. `ws://example...onion`).
3. Rooms on `.onion` relays are marked with `🧅` and strictly isolate all traffic to that relay.
*(Note: Tor Browser disables WebRTC calls by default to protect your IP address.)*

---

## Customizing Your Copy (`config.js`)

Edit [config.js](./config.js) to customize defaults before publishing:

| Option | What it does |
| :--- | :--- |
| `APP_NAME` | App name shown in the header and browser tab (default: `'DecLoc Chat'`). |
| `DEFAULT_LANG` | Initial UI language: `'en'` (default) or `'et'`. |
| `DEFAULT_RELAYS` | List of 5 default public Nostr relays for **Public** rooms. |
| `SITE_PASSCODE_SHA256` | Optional front-door gate passcode hash (`null` = disabled). Generate a SHA-256 hash with: `printf '%s' 'my-code' \| sha256sum`. |
| `ICE_SERVERS` | STUN (or your own TURN) servers used for P2P WebRTC voice & video calls. |
| `GIPHY_API_KEY` | Optional free GIPHY API key from `developers.giphy.com` to enable live GIF search for all users (users can also set their own key in Settings). |

---

## Running Automated Tests

Verify BIP-340 Schnorr cryptography, E2EE encryption, self-only NIP-09 deletion, strict per-room relay isolation, and the built-in SQLite relay server:

```bash
node --test tests/*.test.mjs
```

---

## Security & Privacy Model (Honest Summary)

* **Room encryption:** `PBKDF2-SHA256` (200,000 iterations) derives domain-separated `HMAC-SHA256` keys: a public `channelId` tag and a secret `AES-256-GCM` key. Each message uses a fresh random 96-bit IV and binds `pubkey:channelId` as authenticated additional data (`AAD`).
* **Signatures:** Every Nostr event (`kind: 42` messages/reactions/read receipts/tombstones, `kind: 5` NIP-09 deletions, `kind: 20042` ephemeral presence/typing/WebRTC signaling) is signed and verified with pure-JS **BIP-340 secp256k1 Schnorr**.
* **Good to know:**
  * On **public relays**, relays cannot read your messages or room names, but they can see the IP address connecting to them (use a VPN or Tor Browser if you want to hide your IP).
  * On **your own relay** (`relay/server.mjs`), NIP-09 deletions physically erase your events from SQLite immediately. Public relays generally honor NIP-09, though third-party servers cannot be 100% forced to delete old ciphertext (DecLoc Chat clients still block deleted messages via encrypted tombstones).
  * P2P WebRTC voice/video calls connect directly between callers' browsers (exposing IP addresses to call participants); if both callers are behind strict symmetric 4G/5G NATs, adding a TURN server in `config.js` improves call connectivity.

## License

[MIT](./LICENSE)
















---

# DecLoc Chat — Detsentraliseeritud kohalik vestlus

> [Back to English version / Inglise keeles ↑](#decloc-chat--decentralized-local-chat)

**DecLoc Chat** on ülikerge, null-sõltuvusega ja otsast lõpuni krüpteeritud (**E2EE**) grupivestlus (PWA).

Sul **ei ole vaja** suurfirma kontot, telefoninumbrit, e-maili, äpipoodi ega rasket pilveserverit. Saad selle käima panna **2 minutiga tasuta GitHub Pagesis** — või jooksutada tervet chatti koos oma privaatse andmebaasiga **vanas Androidi telefonis (Termux)**, **Raspberry Pi-s**, **arvutis** või **pisikeses VPS-is**.

---

## Mida see oskab (Võimalused)

* **Null build-sammu, null välist teeki:** puhas HTML, CSS ja JavaScript. Ei vaja `npm install`-i ega Dockerit.
* **Privaatsed parooliga jututoad:** loo nii palju grupivestlusi või kahe-inimese tube kui soovid. Jaga **1-kliki kutselinki** (või ütle sõbrale toa nimi + parool suuliselt).
* **Täielik otsast lõpuni krüpteering (E2EE):**
  * Kõik sõnumid, reaktsioonid, lugemiskinnitused ja kõnesignaalid krüpteeritakse sinu brauseris (`PBKDF2` + `HMAC-SHA256` + `AES-256-GCM`) enne seadmest lahkumist.
  * Kutselingi salajane osa on URL-i `#join=...` lõpus, mida brauser **mitte kunagi** veebiserverile ei saada.
  * Igas toas tuletatakse kasutajale eraldi võtmepaar, nii et avalike relay'de pealt ei saa eri tubade kasutajaid omavahel kokku viia.
* **Toapõhiselt lukustatud relay-valik (null lekkimist tubade vahel):**
  * Toa loomisel valid kas **Avalikud Nostr relay'd** (5 vaikeserverit, mida saab Seadetes ükshaaval sisse/välja lülitada) **VÕI** **Enda relay** (sinu telefoni/VPS-i `wss://...` aadress või avalik `.onion` Nostr relay Tor Browseris).
  * Pärast loomist on tuba püsivalt selle relay külge lukustatud — oma relay-ga loodud toa liiklus **ei lähe kunagi** avalikesse relay'desse.
* **Valikuline isiklik parool (kaasaskantav identiteet + seadmelukk):**
  * Jäta tühjaks koheseks seadmepõhiseks kasutamiseks **või** määra valikuline isiklik parool, millega saad teises telefonis/arvutis tagasi täpselt sama krüptograafilise identiteedi ja õiguse kustutada enda vanu sõnumeid.
  * Soovi korral lülita sisse **Seadmelukk** (*Device lock*), mis hoiab sinu võtit seadmes krüpteeritult (`AES-256-GCM`) ja küsib parooli äpi uuesti avamisel.
* **Võltsimatud toanimed (`Nimi-xxxx`), liikmete nimekiri ja arhiveeritud koodid:**
  * Iga kasutaja nime taha arvutatakse automaatselt tema toavõtmest 4 unikaalset tähte/numbrit (nt `Jaan-4fl7`), mida kasutaja ei saa ise määrata ega muuta — nii on ka samanimelised inimesed alati selgelt eristatavad.
  * Nime muutmisel (nt `Jaan-4fl7` → `Ott-56gb`) salvestatakse allkirjastatud ja räsiga eelmise nime külge seotud plokk jututuppa; nimele klikkides näeb kogu kinnitatud nimeajalugu.
  * **Liikmete** nimekiri näitab kõiki tuppa sisenenud kasutajaid (nii **Sees** kui ka **Ühenduseta**). Kui kasutaja lahkub koos kõigi oma andmete kustutamisega, eemaldatakse tema nimi ja sõnumid täielikult ning **Arhiveeritud liikmete** alla jääb ainult tema viimane unikaalne kood (nt `archived-56gb`). Kui 4-kohalised koodid peaksid kunagi täituma (nt automaatika rünnakul), vabastatakse arhiivist vanim kood ühekaupa (**FIFO**) ning kui kõik on aktiivsetel liikmetel, laieneb kood automaatselt **4 → 5 → 6…** sümbolile — nii ei saa jututuba kunagi täis.
* **Ainult enda sõnumite kustutamine igalt poolt:** kustuta üksik sõnum või kõik enda sõnumid toas — eemaldatakse sinu brauserist, saadetakse standardne **NIP-09 (`kind: 5`)** kustutamispalve Nostr-serveritele ning krüpteeritud kustutuskäsk teiste osalejate seadmetele. Kustutada saab ainult sõnumi tegelik autor.
* **Jututoa looja ja admini õigused (`Nimi-xxxx (admin)`):**
  * Esimene jututoa looja saab automaatselt jututoa asutaja-**adminiks** (`(admin)` märgis Liikmete all, sõnumitel ja nimeajaloos) ning saab vajadusel anda või eemaldada admin-õiguse (`+Admin` / `−Admin`) teistele liikmetele, nii et jututoas võib olla ka mitu admini.
  * Iga admin saab jututoas liikmeid **blokeerida ja kustutada** (eemaldab liikme ning kustutab tema sõnumid kõigi osalejate seadmetest ja `relay/server.mjs` andmebaasist), **genereerida jututoale uue parooli** (kõik mitte-blokeeritud liikmed viiakse automaatselt üle individuaalse **secp256k1 ECDH + AES-256-GCM** krüptoümbrikuga, nii et blokeeritud kasutaja ei saa uue nimega sisse tulla) või **kustutada terve jututoa igalt poolt** (kustutab kõik sõnumid, teiste andmed, jututoa enda ja SQLite andmebaasi kirjed).
  * Kui admin soovib ennast täielikult jututoast kustutada, aga toas on teisi liikmeid, **peab ta enne lahkumist määrama kellegi teise adminiks** (kes saab täieliku õiguse tuba hallata ja igalt poolt kustutada); kui admin on jututoas **ainus liige**, kustutab enda täielik kustutamine jututoast automaatselt ka terve jututoa igalt poolt.
* **Lugemiskinnitused („Nähtud“):** näitab väikeselt sõnumi all, kes ja mis kell viimast teksti nägi (saab Seadetes välja lülitada).
* **Täielik Emoji ja GIF tugi:** 450+ kategooriatega emojit (otsing nii eesti kui inglise keeles, hiljutised emojid, `＋` täielik reaktsioonivalija) ning GIF-ide saatmine otselingiga (`https://`) või valikulise tasuta **GIPHY API võtmega**.
* **P2P WebRTC hääl- ja videokõned:** otse brauserite vahel koos 4 Messengeri/WhatsAppi stiilis paigutusega (**Kompaktne**, **Võrdne täisekraan**, **50/50 jagatud ekraan**, **Fookus + paremal all pilt-pildis**), esi-/tagakaamera vahetuse, **Screen Wake Lock'i** (hoiab kõne ajal ekraani ärkvel), automaatse kaamera ja ICE-taastusega pärast ekraanilukku/võrguvahetust ning valikulise **TURN-serveri** seadega rangete 4G/5G võrkude jaoks.
* **Võimsad teated igal seadmel:** 1-kliki kelluke (`🔔`) päises lülitab sisse OS-teavitused (arvuti, Android Chrome, iOS 16.4+ PWA), selgema 2-toonilise heli + mobiilse vibratsiooni, sissetuleva kõne helina, vilkuva brauseri saki + punase lugemata märgi ikoonil, PWA avakuva punase numbri, sisseehitatud **VAPID Web Push'i** serveris `relay/server.mjs` (äratab ka lukus/suletud telefoni!) ja valikulise privaatsuskindla **`ntfy.sh`** toe GitHub Pagesi jaoks.
* **Paigaldatav PWA:** lisa telefoni avakuvale nagu päris äpp. Tume/hele teema, inglise (vaikimisi) ja eesti keel, varukoopia eksport/import.

---

## Lihtne kasutusjuhend tavakasutajale

Kui tahad äppi kasutada sõprade või perega:

1. **Ava chati link** oma telefoni või arvuti brauseris (Chrome, Safari, Firefox).
2. **Vali endale nimi** (nt `Mari`). *(Paremas ülanurgas `ET` nupuga saad kohe eesti keele peale lülitada!)*
   * *Valikuline:* võid lisada ka **Isikliku parooli** (ainult sinu enda teada — ära jaga seda teistega). Sellega saad uues telefonis või uuel lingil tagasi oma `#xxxx` kontrollkoodi ja saad soovi korral äpi selles seadmes parooliga lukustada. Võid selle ka täiesti tühjaks jätta!
3. **Loo jututuba:** vajuta **+ Uus tuba**, pane toale nimi (nt `Pere`), jäta genereeritud parool alles (või kirjuta enda oma) ja vali kas **Avalikud relay'd** või **Enda relay**.
4. **Kutsu sõbrad:** vajuta toas **Kutsu → Kopeeri kutselink** (mobiilis **Jaga…**) ja saada link sõbrale.
5. **Sõber vajutab lingile**, sisestab oma nime ja on kohe privaatses grupivestluses!
6. **Lisa telefonis avakuvale (nagu päris äpp):**
   * **Android (Chrome):** vajuta paremal üleval `⋮` → **Lisa avakuvale** / **Installi rakendus**.
   * **iPhone (Safari):** vajuta all jagamisikooni (`↑`) → **Lisa avakuvale**.

> **NB! Kaks erinevat parooli:**
> * **Toa salaparool** = ühine kõigile selles toas olijatele (võti tuppa sisenemiseks ja sõnumite dekrüpteerimiseks).
> * **Isiklik parool (valikuline)** = ainult *sinu* enda oma, tõestab sinu `#xxxx` identiteeti eri seadmetes ja lukustab soovi korral äpi.

---

## Ülespaneku juhend samm-sammult (vali endale sobiv variant)

### Variant 1: Kõige lihtsam — tasuta GitHub Pagesis (0 serverit, ~2 minutit)

Parim valik, kui sa ei taha ühtegi serverit hallata ja soovid kasutada avalikke Nostr relay'sid.

**Samm 1:** Vajuta selles GitHubi repos nuppu **Fork** (või laadi need failid uude avalikku GitHubi reposse).

**Samm 2:** Ava oma GitHubi repos ülevalt **Settings → Pages**.

**Samm 3:** Jaotises **Build and deployment**:
* **Source:** `Deploy from a branch`
* **Branch:** `main` ja kaust `/ (root)`
* Vajuta **Save**.

**Samm 4:** Oota ~1 minut ja värskenda lehte. Sinu chat töötab nüüd aadressil:
```text
https://<sinu-githubi-kasutajanimi>.github.io/<repo-nimi>/
```

#### Valikuline: oma alamdomeeni lisamine (nt `chat.sinudomeen.ee`)

1. Ava oma domeenipakkuja **DNS-seaded** ja lisa üks `CNAME` kirje:
   ```text
   Tüüp:   CNAME
   Nimi:   chat
   Väärtus: <sinu-githubi-kasutajanimi>.github.io
   ```
2. Ava GitHubis **Settings → Pages → Custom domain**, kirjuta sinna `chat.sinudomeen.ee` ja vajuta **Save**.
3. Kui DNS on kinnitatud, tee linnuke **Enforce HTTPS** ette (GitHub väljastab automaatselt tasuta SSL-sertifikaadi).

---

### Variant 2: Vana Androidi telefon serverina (Termux + Cloudflare Tunnel)

Parim valik, kui tahad, et **nii veebileht kui ka sinu enda privaatne SQLite Nostr relay andmebaas** elaksid füüsiliselt sinu vanas telefonis — töötab ka **4G/5G mobiilse neti (CGNAT)** taga **ilma ruuterit seadistamata** ja **ilma ühtegi kontot tegemata**!

**Samm 1: Paigalda vanasse telefoni Termux**
* Laadi **Termux** alla lehelt **[F-Droid](https://f-droid.org/packages/com.termux/)** *(NB! Ära kasuta vananenud Google Play Store'i versiooni)*.
* Lülita Androidi seadetest (**Seaded → Rakendused → Termux → Aku**) aku optimeerimine välja (**Piiramatu / Unrestricted**), et Android serverit taustal magama ei paneks.

**Samm 2: Paigalda Termuxis Node.js, Git ja Cloudflare Tunnel**
Ava Termux ja sisesta käsud ükshaaval:
```bash
pkg update && pkg upgrade -y
pkg install -y git nodejs cloudflared
```

**Samm 3: Tõmba DecLoc Chat telefoni**
```bash
git clone https://github.com/<sinu-kasutajanimi>/<sinu-repo>.git decloc-chat
cd decloc-chat
```

**Samm 4: Käivita server + tasuta kontovaba tunnel**
```bash
bash relay/start-termux.sh
```
*(Või anna skriptile käivitusõigus: `chmod +x relay/start-termux.sh && ./relay/start-termux.sh`.)*
Mõne sekundi pärast ilmub ekraanile avalik aadress kujul:
```text
https://suvaline-nimi.trycloudflare.com
```
Ava see link brauseris ja jaga sõpradele!
* DecLoc Chat tunneb automaatselt ära sinu telefoni sisseehitatud relay (`/decloc-relay.json`) ja valib uue toa loomisel vaikimisi **sinu telefoni relay**.
* Kõik krüpteeritud sõnumid salvestuvad sinu telefonis faili `relay/data/decloc-relay.db` (SQLite) ja **säilivad ka pärast telefoni taaskäivitust**.
* NB! Tasuta kontovaba `trycloudflare.com` aadress muutub iga kord, kui tunneli kinni paned ja uuesti käivitad (aga kõik sinu andmed jäävad `decloc-relay.db` faili alles).

#### Valikuline: püsiv oma alamdomeen tasuta Cloudflare'i kontoga
Kui tahad **püsivat aadressi** (nt `https://chat.sinudomeen.ee`), mis restardil ei muutu:
1. Loo tasuta Cloudflare'i konto ja suuna oma domeeni DNS Cloudflare'i.
2. Ava Cloudflare'is **Zero Trust → Networks → Tunnels → Create a tunnel**, suuna `chat.sinudomeen.ee` aadressile `http://127.0.0.1:7777` ja kopeeri tunneli token.
3. Käivita Termuxis:
   ```bash
   bash relay/start-termux.sh --token SINU_CLOUDFLARE_TUNNELI_TOKEN
   ```

#### Valikuline: jäta server Termuxis taustale jooksma (uus sessioon või `tmux`)
Ära vajuta `Ctrl + C` (see peatab serveri):
* **Kõige lihtsam viis Termuxis:** tõmba ekraani vasakust servast menüü lahti → vajuta **NEW SESSION** — server jääb esimesse sessiooni edasi jooksma ja saad uues sessioonis muid käske kirjutada (midagi pole vaja juurde paigaldada).
* **Või kasuta `tmux`-i** (eriti mugav üle SSH):
```bash
pkg install -y tmux
tmux new -s decloc
bash relay/start-termux.sh
```
* Kui link on ekraanil, vajuta **`Ctrl + B`**, lase lahti ja vajuta **`D`** — server jääb taustale edasi jooksma ja saad Termuxi tavapäraselt edasi kasutada.
* Hiljem saad serveri ekraani uuesti avada käsuga:
  ```bash
  tmux attach -t decloc
  ```
* Vajuta Androidi teavitusribal Termuxi teavituse all ka **„Acquire wakelock“**, et Android serverit unerežiimis kinni ei paneks.

> **Aku nipp:** Kui vana telefon on 24/7 laadija otsas, lülita võimalusel Androidi akuseadetest sisse laadimispiirang (60–80%), et aku pikalt terve püsiks.

---

### Variant 3: Käivitamine arvutis või Raspberry Pi-s (testimine või koduvõrk)

Vajab **Node.js 22+** (kasutab sisseehitatud `node:sqlite` moodulit, `npm install` pole vajalik; vanemal Node 18/20 versioonil lülitub automaatselt NDJSON failile).

**Samm 1: Käivita sisseehitatud server (veebileht + kohalik SQLite relay)**
```bash
node relay/server.mjs
```

**Samm 2: Proovi brauseris**
* Ava brauseris `http://localhost:7777` ja loo uus tuba.
* Kopeeri **Kutselink** ja ava see **inkognito-aknas** — saad kohe kahe kasutajana reaalajas vestlust, reaktsioone, „Nähtud“ märkeid, kustutamist ja kõnesid proovida!

**Kasulikud käsureavalikud (`relay/server.mjs`):**
```bash
# Kuula terves koduses Wi-Fi võrgus pordil 8080:
node relay/server.mjs --host 0.0.0.0 --port 8080

# Salvesta SQLite andmebaas enda valitud kausta:
node relay/server.mjs --data /tee/minu/andmeteni

# Käivita AINULT Nostr relay (nt kui veebileht ise on GitHub Pagesis):
node relay/server.mjs --no-static --port 7777

# Vaata kõiki valikuid:
node relay/server.mjs --help
```

*(Kui tahad testida ainult staatilist veebilehte avalike relay'dega, käivita `python3 -m http.server 8080` ja ava `http://localhost:8080`.)*

---

### Variant 4: 100% iseseisev server oma Linuxi VPS-is (automaatse HTTPS-iga)

Parim valik, kui tahad **püsivat 24/7 oma serverit** enda domeenil ilma GitHubist või Cloudflare'ist sõltumata (~3–4 €/kuu nt Hetzneris või OVH-s).

**Samm 1: Paigalda VPS-i Node.js (v22+) ja Caddy (Debian/Ubuntu näide)**
```bash
sudo apt update && sudo apt install -y git caddy
# Paigalda Node.js 22 (nt NodeSource või nvm kaudu)
```

**Samm 2: Klooni ja käivita DecLoc Chat**
```bash
git clone https://github.com/<sinu-kasutajanimi>/<sinu-repo>.git /opt/decloc-chat
cd /opt/decloc-chat
node relay/server.mjs --host 127.0.0.1 --port 7777
```
*(Püsivaks tööks käivita see `systemd` teenuse või `tmux`-i sees.)*

**Samm 3: Suuna oma domeeni DNS `A`-kirje (`chat.sinudomeen.ee`) VPS-i IP-aadressile ja lisa `/etc/caddy/Caddyfile` faili 3 rida:**
```caddyfile
chat.sinudomeen.ee {
    reverse_proxy 127.0.0.1:7777
}
```
Laadi Caddy uuesti (`sudo systemctl reload caddy`) — Caddy hangib ja uuendab tasuta Let's Encrypti HTTPS-sertifikaadi (koos `wss://` WebSocketi toega) täiesti automaatselt!

---

## Tugevad teated ja lukustatud ekraani push-teavitused

Et ükski sõnum ega kõne märkamata ei jääks:
1. **1-kliki teated:** vajuta päises kellukese (`🔔`) ikoonile (või ava **Seaded → Teated → Testi heli ja teavitust**), et aktiveerida süsteemi teavitused, heli, vibratsioon, vilkuv brauseri sakk, punane lugemata sõnumite täpp ikoonil ja sissetuleva kõne helin.
2. **Lukus/suletud telefoni äratamine oma serveris (`relay/server.mjs`):** sisseehitatud **VAPID Web Push** (`RFC 8292` + `RFC 8291`) töötab automaatselt! Lisa äpp avakuvale (PWA) ja vajuta `🔔` — sinu enda server äratab telefoni ka siis, kui brauser on täiesti suletud (saadetakse ainult üldine *"New encrypted message"* / *"Incoming voice/video call"* äratus, mitte kunagi sõnumi teksti).
3. **Lukus/suletud telefoni äratamine GitHub Pagesis (valikuline `ntfy.sh`):** paigalda telefoni tasuta **ntfy** äpp, genereeri **Seaded → Valikuline ntfy.sh push-aadress** alt salajane aadress ja lisa sama teema oma grupi liikmete ntfy äppi. Ka sinna saadetakse ainult üldine äratus — mitte kunagi päris vestluse sisu.

---

## Avalike `.onion` Nostr relay'de kasutamine (Tor Browser)

DecLoc Chat toetab `.onion` Nostr relay'sid **Enda relay** (*Custom relay*) valikus:
1. Ava DecLoc Chat **Tor Browseris** (või Brave'i Tor-aknas).
2. Vajuta **+ Uus tuba** → vali **Enda relay** → sisesta `.onion` Nostr relay aadress (nt `ws://naidis...onion`).
3. `.onion` toad tähistatakse ikooniga `🧅` ja kogu liiklus püsib rangelt ainult selles relay's.
*(NB! Tor Browser keelab IP-aadressi kaitseks WebRTC videokõned vaikimisi ära.)*

---

## Kohandamine ([config.js](./config.js))

Failis [config.js](./config.js) saad enne avaldamist muuta vaikeseadeid:

| Seade | Selgitus |
| :--- | :--- |
| `APP_NAME` | Rakenduse nimi päises ja brauseri sakil (vaikimisi `'DecLoc Chat'`). |
| `DEFAULT_LANG` | Vaikimisi keel: `'en'` (inglise) või `'et'` (eesti). |
| `DEFAULT_RELAYS` | 5 vaikimisi avalikku Nostr relay-serverit avalike tubade jaoks. |
| `SITE_PASSCODE_SHA256` | Valikuline üldine ligipääsukood lehe esiaknale (`null` = väljas). SHA-256 räsi saad käsuga: `printf '%s' 'minu-kood' \| sha256sum`. |
| `ICE_SERVERS` | STUN (või oma TURN) serverid P2P WebRTC hääl- ja videokõnedeks. |
| `GIPHY_API_KEY` | Valikuline tasuta GIPHY API võti lehelt `developers.giphy.com` reaalajas GIF-i otsinguks (kasutajad saavad võtme lisada ka Seadetes). |

---

## Automaattestide käivitamine

Kontrollib BIP-340 Schnorr krüptograafiat, E2EE krüpteerimist, ainult-omaniku NIP-09 kustutamist, ranget toapõhist relay-isolatsiooni ja sisseehitatud SQLite serverit:

```bash
node --test tests/*.test.mjs
```

---

## Turvamudel (aus kokkuvõte)

* **Toa krüpteering:** `PBKDF2-SHA256` (200 000 iteratsiooni) + domeenieraldusega `HMAC-SHA256` tuletab eraldi avaliku `channelId` ja salajase `AES-256-GCM` võtme. Igal sõnumil on värske juhuslik 96-bitine IV ja autentitud lisaandmed (`AAD = pubkey:channelId`).
* **Allkirjastamine:** kõik Nostr sündmused (`kind: 42` sõnumid/reaktsioonid/lugemiskinnitused/kustutuskäsud, `kind: 5` NIP-09 kustutamised, `kind: 20042` kohalolu/kirjutamine/WebRTC) allkirjastatakse ja kontrollitakse puhta JS **BIP-340 secp256k1 Schnorr** allkirjaga.
* **Hea teada:**
  * **Avalikud relay'd** ei näe sinu sõnumite sisu ega tubade nimesid, küll aga näevad nad ühenduva seadme IP-aadressi (IP peitmiseks kasuta VPN-i või Tor Browserit).
  * **Oma serveris** (`relay/server.mjs`) kustutab NIP-09 sinu sõnumid SQLite failist kohe ja jäädavalt. Avalikud relay'd üldiselt austavad NIP-09-t, aga kolmandate osapoolte servereid ei saa 100% sundida (DecLoc Chati kliendid blokeerivad kustutatud sõnumid siiski alati krüpteeritud kustutuskäsu abil).
  * **P2P WebRTC kõned** ühenduvad otse helistajate brauserite vahel (kõne osalejad näevad teineteise IP-d); kahe range 4G/5G mobiilivõrgu vahel aitab kõnede töökindlust parandada oma TURN-serveri lisamine faili `config.js`.

## Litsents

[MIT](./LICENSE)

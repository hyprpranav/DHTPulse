# DHTPulse — Complete Technical Architecture & Migration Guide

This document provides a comprehensive, end-to-end technical explanation of how **DHTPulse** operates, followed by a complete architectural conversion guide explaining how to migrate any existing **USB Web Serial / COM port** website to this wireless **Firebase Realtime Database** cloud system.

---

# PART 1: The A-to-Z Technical Logic of DHTPulse

```mermaid
flowchart TD
    subgraph ESP32 ["1. Edge Layer (ESP32 DevKit)"]
        A1["DHT11 Sensor Read (GPIO 4)"] --> A2{"Valid? (not NaN, 0-100% RH)"}
        A2 -- No --> A3["Drop reading & Log Error"]
        A2 -- Yes --> A4["Fetch UTC Milliseconds via SNTP"]
        A4 --> A5["Build JSON (Latest & History)"]
        A5 --> A6["Send HTTPS/TLS Payload via FirebaseClient"]
    end

    subgraph Firebase ["2. Cloud Layer (Firebase RTDB)"]
        B1["Evaluate Security Rules (auth != null)"] --> B2{"Schema Valid?"}
        B2 -- No --> B3["403 Forbidden / Reject Write"]
        B2 -- Yes --> B4["Atomic Write /DHTPulse/device_01/latest"]
        B4 --> B5["Append /DHTPulse/device_01/history/{ts}"]
        B5 --> B6["WebSocket Pub/Sub Broadcast"]
    end

    subgraph WebApp ["3. Client Layer (Vercel Web Dashboard)"]
        C1["Firebase JS SDK v10 (onValue listener)"] --> C2["Receive Delta Update"]
        C2 --> C3["Compute Presence: now - ts < 10s?"]
        C3 --> C4["Update Temperature & Humidity Cards"]
        C4 --> C5["Prepend Row to History Table (Max 20)"]
    end

    A6 --> B1
    B6 --> C1
```

---

## 1. ESP32 Firmware Logic & Algorithms

### A. Wi-Fi Connection & Non-Blocking Reconnect Loop
* **Problem in traditional IoT code:** Beginners often use `while (WiFi.status() != WL_CONNECTED) delay(500);` inside `loop()`. If the router or phone hotspot turns off for even 5 seconds, the ESP32 freezes completely, stops monitoring sensors, and trips the hardware Watchdog Timer (WDT), causing endless reboot loops.
* **DHTPulse Solution:**
  1. `WiFi.mode(WIFI_STA);` configures the ESP32 strictly as a station (Wi-Fi client).
  2. `WiFi.setAutoReconnect(true);` instructs the ESP32 baseband radio to attempt reconnects at the hardware layer.
  3. In `monitorWiFiConnection()`, we track `millis() - lastWifiRetryTime >= 5000`. If disconnected, it issues a non-blocking `WiFi.reconnect()` every 5 seconds. The rest of the microcontroller keeps running smoothly without freezing.

### B. Accurate UTC Millisecond Timestamps via SNTP
* **Why not use `millis()` for timestamps?** `millis()` only counts milliseconds since the ESP32 booted. If the board resets, `millis()` resets to 0. Historical logs in a database need **real-world Unix Epoch timestamps** (milliseconds since Jan 1, 1970).
* **How DHTPulse does it:**
  1. In `setup()`, we call `configTime(0, 0, "pool.ntp.org", "time.nist.gov");`.
  2. As soon as Wi-Fi connects, the ESP32's built-in Simple Network Time Protocol (SNTP) daemon contacts atomic clock servers over UDP port 123 in the background.
  3. `gettimeofday(&tv, NULL)` reads the synchronized time down to the microsecond.
  4. Formula used: `(tv.tv_sec * 1000ULL) + (tv.tv_usec / 1000ULL)`.
  5. If NTP is still syncing upon first boot, a safety check (`tv.tv_sec > 1672531199`, corresponding to year 2023+) ensures we never store garbage timestamps like `0` or `1970`.

### C. Sensor Sampling & Validation Algorithm
* **DHT11 Physical Constraints:** The DHT11 is a capacitive humidity sensor with a thermistor. It requires at least **1.5 to 2.0 seconds** between reads. Polling it faster returns cached data or electrical read errors.
* **Non-Blocking Timer:** Instead of `delay(2000)` (which halts the CPU), we use `if (millis() - lastUploadTime >= 2000)`.
* **Validation Guard:**
  ```cpp
  if (isnan(humidity) || isnan(temperature) || humidity < 0.0 || humidity > 100.0 || temperature < -40.0 || temperature > 80.0) {
      Serial.println("[ ERROR ] SENSOR READ FAILED");
      return; // Abort upload immediately
  }
  ```
  This prevents sending `null`, `NaN`, or corrupted voltage spikes to Firebase.

### D. Firebase Client Handshake & Authentication
* The Mobizt library initializes a secure TLS (SSL) socket with Firebase over port 443.
* When `USE_EMAIL_AUTH` is `false`, it executes `Firebase.signUp(&config, &auth, "", "")`.
* The ESP32 sends a REST payload to Google's Identity Toolkit API (`identitytoolkit.googleapis.com`). Google returns an **ID Token (JWT)**, a **Refresh Token**, and a unique **Anonymous User ID (UID)**.
* The library automatically refreshes expired tokens in the background before they expire (every 60 minutes) without interrupting telemetry streaming.

### E. Data Packaging & Realtime Database Writes
Every 2 seconds, two nodes are written:
1. **`/DHTPulse/device_01/latest`**: Overwritten with the most recent values:
   ```json
   {
     "temperature": 29.5,
     "humidity": 65,
     "timestamp": 1795187770000,
     "status": "online"
   }
   ```
2. **`/DHTPulse/device_01/history/{timestamp}`**: Appended as an immutable historical record:
   ```json
   {
     "temperature": 29.5,
     "humidity": 65,
     "timestamp": 1795187770000
   }
   ```
   Because the key is the exact timestamp integer, each reading creates a unique, chronological row without ever overwriting past records.

---

## 2. Firebase Cloud Architecture & Security Logic

### A. What Was Activated in Firebase
1. **Realtime Database (RTDB):** Unlike traditional SQL databases (PostgreSQL/MySQL) that require polling queries, RTDB uses persistent **WebSockets**. Whenever data changes in the cloud, Firebase pushes the delta change directly to connected clients in sub-100ms.
2. **Authentication Service (Anonymous Provider):** Enables Google to generate temporary crypto tokens for the ESP32 and web browsers without requiring users to type a password.

### B. Security Rules Deep-Dive (`database.rules.json`)
The database security rules act as a cloud-level firewall. They validate every packet before it touches the database:

1. **Deny Everything by Default:**
   ```json
   ".read": false,
   ".write": false
   ```
   No public read or write access exists at the root. Hackers scanning Firebase URLs cannot read or delete your data.
2. **Authentication Enforcement:**
   ```json
   ".read": "auth != null",
   ".write": "auth != null"
   ```
   Only clients with a valid JWT token from Firebase Auth can read or write.
3. **Data Type & Boundary Validation:**
   ```json
   "temperature": {
     ".validate": "newData.isNumber() && newData.val() >= -40 && newData.val() <= 80"
   },
   "humidity": {
     ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 100"
   }
   ```
   If someone attempts to write `"hot"` or `9999`, the database server itself drops the packet and returns `HTTP 403 Permission Denied`.
4. **Append-Only History Protection:**
   ```json
   "$timestamp": {
     ".write": "auth != null && !data.exists()"
   }
   ```
   `!data.exists()` is a critical security rule. It means: *A write is only permitted if the data at this key does not exist yet.* Once a timestamp entry is written, it cannot be modified or overwritten.

---

## 3. Web Dashboard Frontend Architecture

### A. Modular Firebase SDK v10 (ES Modules)
The dashboard uses vanilla JavaScript loaded as an ES Module (`<script type="module" src="app.js">`) via the Google CDN. There are no bundlers (Webpack/Vite), no Node servers, and no build steps.

### B. Real-Time Streaming vs. Polling
Instead of using `setInterval(fetch, 2000)` (which wastes bandwidth and causes latency), we attach a WebSocket listener:
```javascript
unsubscribeLatest = onValue(latestRef, (snapshot) => {
  if (snapshot.exists()) {
    renderLatestData(snapshot.val());
  }
});
```
When the ESP32 uploads a new number, Firebase automatically pushes the packet down the open WebSocket connection to the browser within ~50ms.

### C. Device Presence Watchdog (Online/Offline Detection)
* **The Problem:** Microcontrollers don't cleanly send a "Goodbye, I died" message when someone unplugs the power or the battery runs out.
* **The Algorithm:**
  1. Every incoming packet from the ESP32 contains a `timestamp`.
  2. The frontend runs a 1-second interval ticker:
     $$\Delta t = \text{Date.now()} - \text{lastReceivedTimestamp}$$
  3. If $\Delta t \le 10{,}000\text{ ms}$, status = **`ONLINE`** (green pulsing badge).
  4. If $\Delta t > 10{,}000\text{ ms}$ (no data for 10 seconds), status = **`OFFLINE`** (red badge).

---

# PART 2: How to Convert Any USB Cable/Web Serial Website to Firebase Cloud

If you have an existing website where the user connects their ESP32 via a USB cable, clicks a "Connect" button in the browser (using the browser's `navigator.serial` API), and streams data through a COM port, here is the exact architectural blueprint to convert that website into a wireless cloud dashboard.

---

## 1. Architectural Comparison

| Dimension | Existing System (Web Serial) | New System (Firebase Cloud) |
|:---|:---|:---|
| **Physical Connection** | USB cable plugged into user's laptop | Wireless (Wi-Fi 2.4 GHz) |
| **Range** | 1 meter (USB cable limit) | Anywhere in the world (Internet) |
| **Browser Support** | Desktop Chrome/Edge only (no iOS, no Android Firefox) | All browsers (iOS Safari, Android Chrome, Mac, Windows) |
| **Multi-Client** | Only 1 computer can connect to the COM port at a time | Hundreds of people can view the dashboard simultaneously |
| **Data Persistence** | Lost when browser tab is closed | Permanently saved in cloud database |

---

## 2. Firmware Conversion (ESP32 Side)

### What to Keep
- Your sensor setup code (`dht.begin()`, pin configurations, sensor reading math).
- `Serial.begin(115200);` and your `Serial.print()` statements (keep them for USB debugging).

### What to Add
1. **Wi-Fi & Time Headers:**
   ```cpp
   #include <WiFi.h>
   #include <time.h>
   ```
2. **Firebase Client Headers:**
   ```cpp
   #include <Firebase_ESP_Client.h>
   #include <addons/TokenHelper.h>
   #include <addons/RTDBHelper.h>
   ```
3. **Wi-Fi + Firebase Initialization:**
   In your `setup()` function, connect to Wi-Fi and initialize the Firebase client with your API key, database URL, and credentials.
4. **Replace `Serial.println(data)` as Primary Transport:**
   Instead of relying solely on `Serial.print("TEMP:25.4,HUM:60\n")` to talk to the browser, pack those variables into a `FirebaseJson` object and send them with:
   ```cpp
   Firebase.RTDB.setJSON(&fbdo, "/DHTPulse/device_01/latest", &jsonLatest);
   ```

---

## 3. Frontend Conversion (Website Side)

### Step 1: Remove Web Serial Code
In your existing website's JavaScript, **delete or comment out** the Web Serial API functions:

```javascript
// ❌ DELETE / REMOVE THIS CODE:
let port;
let reader;

async function connectSerial() {
  port = await navigator.serial.requestPort(); // ❌ REMOVE
  await port.open({ baudRate: 115200 });       // ❌ REMOVE
  
  const decoder = new TextDecoderStream();     // ❌ REMOVE
  const inputDone = port.readable.pipeTo(decoder.writable); // ❌ REMOVE
  const inputStream = decoder.readable;        // ❌ REMOVE
  reader = inputStream.getReader();            // ❌ REMOVE
  
  while (true) {                               // ❌ REMOVE
    const { value, done } = await reader.read();
    if (done) break;
    parseSerialData(value);                    // ❌ REMOVE
  }
}

// ❌ REMOVE "Connect COM Port" button from HTML:
// <button onclick="connectSerial()">Connect Device via USB</button>
```

---

### Step 2: Add Firebase SDK & Real-Time Listener
Replace the serial reader with the official Firebase Realtime Database listener:

```html
<!-- In your HTML <head> or before </body>: -->
<script type="module">
  import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
  import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
  import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

  // 1. Paste your Firebase project configuration
  const firebaseConfig = {
    apiKey: "AIzaSyDlFs_h1Lg1MqrioOw40r00nz_Le6oFCPg",
    authDomain: "dhtpulse-lab.firebaseapp.com",
    databaseURL: "https://dhtpulse-lab-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "dhtpulse-lab"
  };

  // 2. Initialize Firebase and authenticate
  const app = initializeApp(firebaseConfig);
  const db = getDatabase(app);
  const auth = getAuth(app);
  await signInAnonymously(auth);

  // 3. Connect real-time listener (replaces while(true) serial reader)
  const deviceRef = ref(db, "DHTPulse/device_01/latest");
  onValue(deviceRef, (snapshot) => {
    if (snapshot.exists()) {
      const data = snapshot.val();
      
      // Pass data straight into your website's existing UI updater functions!
      updateDashboardUI(data.temperature, data.humidity);
    }
  });

  function updateDashboardUI(temp, hum) {
    document.getElementById("temp-display").textContent = temp + " °C";
    document.getElementById("hum-display").textContent = hum + " %";
  }
</script>
```

---

## 4. Universal Adaptation Checklist (For Any Existing Website)

When converting any future IoT project from USB Serial to Cloud:

1. **On Firebase Console:**
   - [ ] Create a new project.
   - [ ] Enable **Realtime Database** (choose your closest region).
   - [ ] Enable **Authentication** → **Sign-in method** → **Anonymous**.
   - [ ] Paste the security rules from `database.rules.json` to prevent unauthorized database access.
2. **In the ESP32 Code:**
   - [ ] Add `#include <WiFi.h>` and `#include <Firebase_ESP_Client.h>`.
   - [ ] Put your Wi-Fi SSID and password at the top.
   - [ ] Replace or augment the `Serial.print()` lines with `Firebase.RTDB.setJSON()`.
3. **In the Web Code:**
   - [ ] Delete `navigator.serial` request port and baud rate open commands.
   - [ ] Import `initializeApp`, `getDatabase`, and `onValue` from the Firebase CDN.
   - [ ] In the `onValue()` callback, take `data.temperature` and `data.humidity` and pass them into your existing dashboard display functions.
4. **Deploy:**
   - [ ] Upload the static HTML/CSS/JS to Vercel, Netlify, or GitHub Pages. The dashboard will now work on laptops, iPads, iPhones, and Android phones from anywhere in the world.

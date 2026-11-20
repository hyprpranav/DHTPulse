/**
 * ============================================================================
 * DHTPulse — Real-Time IoT Monitoring & Connectivity Lab
 * File: app.js
 * Architecture: Vanilla JavaScript (ES Modules) + Firebase JS SDK v10
 * ============================================================================
 */

import { initializeApp, getApps, deleteApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { 
  getDatabase, 
  ref, 
  onValue, 
  get, 
  query, 
  limitToLast, 
  off 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { 
  getAuth, 
  signInAnonymously, 
  signInWithEmailAndPassword,
  onAuthStateChanged 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// ============================================================================
// 1. DEFAULT FIREBASE CONFIGURATION
// ============================================================================
// Connected to dhtpulse-lab project
const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDlFs_h1Lg1MqrioOw40r00nz_Le6oFCPg",
  authDomain: "dhtpulse-lab.firebaseapp.com",
  databaseURL: "https://dhtpulse-lab-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "dhtpulse-lab",
  storageBucket: "dhtpulse-lab.firebasestorage.app",
  messagingSenderId: "740293667474",
  appId: "1:740293667474:web:a132d7992c2acf2409544b"
};

const DEFAULT_SETTINGS = {
  authMode: "anonymous", // "anonymous" or "email"
  testEmail: "dhtpulse-device@test.com",
  testPassword: "dhtpulseSecurePass123",
  deviceId: "device_01",
  offlineTimeoutMs: 10000 // 10 seconds timeout for device offline detection
};

// ============================================================================
// 2. STATE MANAGEMENT
// ============================================================================
let app = null;
let db = null;
let auth = null;
let activeConfig = null;
let activeSettings = null;

let isLiveMonitoring = true;
let unsubscribeLatest = null;
let unsubscribeHistory = null;

let lastReceivedTimestamp = 0;
let previousTemp = null;
let previousHum = null;
let displayedHistory = [];

// ============================================================================
// 3. DOM ELEMENTS
// ============================================================================
const els = {
  // Status & indicators
  streamIndicator: document.getElementById("stream-indicator"),
  streamIndicatorText: document.getElementById("stream-indicator-text"),
  devicePresenceBadge: document.getElementById("device-presence-badge"),
  devicePresenceText: document.getElementById("device-presence-text"),
  deviceName: document.getElementById("device-name"),
  wifiStatus: document.getElementById("wifi-status"),
  firebaseStatus: document.getElementById("firebase-status"),
  deviceStateDesc: document.getElementById("device-state-desc"),
  lastReceivedTime: document.getElementById("last-received-time"),
  displayLastSync: document.getElementById("display-last-sync"),
  rtdbPathPreview: document.getElementById("rtdb-path-preview"),
  
  // Sensor metrics
  tempValue: document.getElementById("temp-value"),
  tempBar: document.getElementById("temp-bar"),
  tempBadge: document.getElementById("temp-badge"),
  tempTrend: document.getElementById("temp-trend"),
  
  humValue: document.getElementById("hum-value"),
  humBar: document.getElementById("hum-bar"),
  humBadge: document.getElementById("hum-badge"),
  humTrend: document.getElementById("hum-trend"),
  
  // Table
  historyTbody: document.getElementById("history-tbody"),
  historyCount: document.getElementById("history-count"),
  
  // Controls
  btnRefresh: document.getElementById("btn-refresh"),
  btnToggleLive: document.getElementById("btn-toggle-live"),
  btnLiveText: document.getElementById("btn-live-text"),
  btnClearTable: document.getElementById("btn-clear-table"),
  btnTestConnection: document.getElementById("btn-test-connection"),
  btnOpenSettings: document.getElementById("btn-open-settings"),
  
  // Modal
  configModal: document.getElementById("config-modal"),
  btnCloseModal: document.getElementById("btn-close-modal"),
  configForm: document.getElementById("config-form"),
  btnResetConfig: document.getElementById("btn-reset-config"),
  emailAuthFields: document.getElementById("email-auth-fields"),
  
  // Form inputs
  cfgApiKey: document.getElementById("cfg-apiKey"),
  cfgDbUrl: document.getElementById("cfg-dbUrl"),
  cfgProjId: document.getElementById("cfg-projId"),
  cfgAuthType: document.getElementById("cfg-authType"),
  cfgEmail: document.getElementById("cfg-email"),
  cfgPassword: document.getElementById("cfg-password"),
  cfgDeviceId: document.getElementById("cfg-deviceId"),
  
  // Toast
  toast: document.getElementById("toast"),
  toastMessage: document.getElementById("toast-message"),
  toastIcon: document.getElementById("toast-icon")
};

// ============================================================================
// 4. STORAGE & CONFIGURATION HELPERS
// ============================================================================
function loadStoredSettings() {
  const storedConfig = localStorage.getItem("dhtpulse_firebase_config");
  const storedSettings = localStorage.getItem("dhtpulse_settings");
  
  if (storedConfig) {
    try {
      const parsed = JSON.parse(storedConfig);
      if (isPlaceholderConfig(parsed)) {
        activeConfig = { ...DEFAULT_FIREBASE_CONFIG };
        localStorage.setItem("dhtpulse_firebase_config", JSON.stringify(activeConfig));
      } else {
        activeConfig = parsed;
      }
    } catch {
      activeConfig = { ...DEFAULT_FIREBASE_CONFIG };
    }
  } else {
    activeConfig = { ...DEFAULT_FIREBASE_CONFIG };
  }

  activeSettings = storedSettings ? JSON.parse(storedSettings) : { ...DEFAULT_SETTINGS };
  
  // Update UI path preview
  if (els.rtdbPathPreview) {
    els.rtdbPathPreview.textContent = `/DHTPulse/${activeSettings.deviceId}`;
  }
}

function saveSettings(config, settings) {
  localStorage.setItem("dhtpulse_firebase_config", JSON.stringify(config));
  localStorage.setItem("dhtpulse_settings", JSON.stringify(settings));
  activeConfig = config;
  activeSettings = settings;
}

function isPlaceholderConfig(config) {
  return !config.apiKey || 
         config.apiKey.includes("YOUR_") || 
         !config.databaseURL || 
         config.databaseURL.includes("YOUR_PROJECT_ID");
}

// ============================================================================
// 5. NOTIFICATION TOAST
// ============================================================================
let toastTimeout = null;
function showToast(message, type = "info") {
  if (toastTimeout) clearTimeout(toastTimeout);
  
  const icons = {
    info: "ℹ️",
    success: "✅",
    warning: "⚠️",
    error: "❌"
  };
  
  els.toastIcon.textContent = icons[type] || "ℹ️";
  els.toastMessage.textContent = message;
  els.toast.classList.remove("hidden");
  
  toastTimeout = setTimeout(() => {
    els.toast.classList.add("hidden");
  }, 4000);
}

// ============================================================================
// 6. FIREBASE INITIALIZATION & AUTHENTICATION
// ============================================================================
async function initFirebase() {
  updateConnectionStatus("connecting", "Connecting to Firebase...");
  
  if (isPlaceholderConfig(activeConfig)) {
    updateConnectionStatus("disconnected", "Configuration Needed");
    els.firebaseStatus.textContent = "AWAITING CONFIGURATION";
    showToast("Please configure your Firebase credentials via the Config button.", "warning");
    return;
  }
  
  try {
    // If an existing app is running, clean it up
    const existingApps = getApps();
    if (existingApps.length > 0) {
      await deleteApp(existingApps[0]);
    }
    
    app = initializeApp(activeConfig);
    db = getDatabase(app);
    auth = getAuth(app);
    
    // Authenticate
    if (activeSettings.authMode === "email" && activeSettings.testEmail && activeSettings.testPassword) {
      updateConnectionStatus("connecting", "Authenticating (Email/Pass)...");
      await signInWithEmailAndPassword(auth, activeSettings.testEmail, activeSettings.testPassword);
      showToast("Authenticated as " + activeSettings.testEmail, "success");
    } else {
      updateConnectionStatus("connecting", "Authenticating (Anonymous)...");
      await signInAnonymously(auth);
      showToast("Connected to Firebase (Anonymous Auth)", "success");
    }
    
    els.firebaseStatus.textContent = "CONNECTED (Authenticated)";
    updateConnectionStatus("connected", "Live Streaming");
    
    // Attach real-time listeners if enabled
    if (isLiveMonitoring) {
      startRealtimeListeners();
    } else {
      manualFetchData();
    }
    
  } catch (error) {
    console.error("Firebase Initialization Error:", error);
    updateConnectionStatus("error", "Auth / Connection Error");
    els.firebaseStatus.textContent = "ERROR: " + (error.code || error.message);
    showToast("Firebase Error: " + error.message, "error");
  }
}

// ============================================================================
// 7. REAL-TIME DATA STREAMING (RTDB LISTENERS)
// ============================================================================
function startRealtimeListeners() {
  if (!db || !auth || !auth.currentUser) return;
  
  const deviceId = activeSettings.deviceId || "device_01";
  const latestRef = ref(db, `DHTPulse/${deviceId}/latest`);
  const historyQuery = query(ref(db, `DHTPulse/${deviceId}/history`), limitToLast(20));
  
  // Stop any previous listeners
  stopRealtimeListeners();
  
  // 1. Listen for Latest Reading
  unsubscribeLatest = onValue(latestRef, (snapshot) => {
    updateSyncTime();
    if (snapshot.exists()) {
      const data = snapshot.val();
      renderLatestData(data);
    } else {
      els.deviceStateDesc.textContent = "No telemetry recorded at /DHTPulse/" + deviceId + "/latest";
    }
  }, (error) => {
    console.error("Latest listener error:", error);
    showToast("Read Permission Denied. Check RTDB Security Rules.", "error");
  });
  
  // 2. Listen for History Readings (Up to 20)
  unsubscribeHistory = onValue(historyQuery, (snapshot) => {
    if (snapshot.exists()) {
      const historyObj = snapshot.val();
      // Transform map into sorted array (newest first)
      const rows = [];
      Object.keys(historyObj).forEach((key) => {
        const item = historyObj[key];
        rows.push({
          id: key,
          temperature: item.temperature,
          humidity: item.humidity,
          timestamp: item.timestamp || Number(key) || 0
        });
      });
      
      // Sort reverse chronological
      rows.sort((a, b) => b.timestamp - a.timestamp);
      displayedHistory = rows.slice(0, 20);
      renderHistoryTable(displayedHistory);
    }
  }, (error) => {
    console.error("History listener error:", error);
  });
}

function stopRealtimeListeners() {
  if (unsubscribeLatest) {
    unsubscribeLatest();
    unsubscribeLatest = null;
  }
  if (unsubscribeHistory) {
    unsubscribeHistory();
    unsubscribeHistory = null;
  }
}

// ============================================================================
// 8. MANUAL DATA FETCH (get() without full page refresh)
// ============================================================================
async function manualFetchData() {
  if (!db || !auth || !auth.currentUser) {
    showToast("Not connected to Firebase. Please check configuration.", "warning");
    return;
  }
  
  const deviceId = activeSettings.deviceId || "device_01";
  const latestRef = ref(db, `DHTPulse/${deviceId}/latest`);
  const historyQuery = query(ref(db, `DHTPulse/${deviceId}/history`), limitToLast(20));
  
  try {
    showToast("Fetching latest data from Firebase...", "info");
    const [latestSnap, historySnap] = await Promise.all([
      get(latestRef),
      get(historyQuery)
    ]);
    
    updateSyncTime();
    
    if (latestSnap.exists()) {
      renderLatestData(latestSnap.val());
      showToast("Data refreshed successfully!", "success");
    } else {
      showToast("No latest reading found for " + deviceId, "warning");
    }
    
    if (historySnap.exists()) {
      const historyObj = historySnap.val();
      const rows = [];
      Object.keys(historyObj).forEach((key) => {
        const item = historyObj[key];
        rows.push({
          id: key,
          temperature: item.temperature,
          humidity: item.humidity,
          timestamp: item.timestamp || Number(key) || 0
        });
      });
      rows.sort((a, b) => b.timestamp - a.timestamp);
      displayedHistory = rows.slice(0, 20);
      renderHistoryTable(displayedHistory);
    }
  } catch (error) {
    console.error("Manual fetch error:", error);
    showToast("Fetch failed: " + error.message, "error");
  }
}

// ============================================================================
// 9. UI RENDERING FUNCTIONS
// ============================================================================
function renderLatestData(data) {
  if (!data) return;
  
  const temp = typeof data.temperature === "number" ? data.temperature : parseFloat(data.temperature);
  const hum = typeof data.humidity === "number" ? data.humidity : parseFloat(data.humidity);
  const timestamp = data.timestamp ? Number(data.timestamp) : Date.now();
  
  lastReceivedTimestamp = timestamp;
  
  // Render Temperature
  if (!isNaN(temp)) {
    els.tempValue.textContent = temp.toFixed(1);
    
    // Scale 0°C to 50°C for meter fill
    const tempPercent = Math.max(0, Math.min(100, (temp / 50) * 100));
    els.tempBar.style.width = `${tempPercent}%`;
    
    // Status Badge & Trend
    if (temp < 18) {
      els.tempBadge.textContent = "Cool";
      els.tempBadge.style.color = "#38bdf8";
    } else if (temp <= 28) {
      els.tempBadge.textContent = "Normal";
      els.tempBadge.style.color = "#34d399";
    } else {
      els.tempBadge.textContent = "Warm";
      els.tempBadge.style.color = "#fbbf24";
    }
    
    if (previousTemp !== null) {
      const diff = (temp - previousTemp).toFixed(1);
      els.tempTrend.textContent = diff > 0 ? `▲ +${diff}°C` : (diff < 0 ? `▼ ${diff}°C` : "= Stable");
    }
    previousTemp = temp;
  }
  
  // Render Humidity
  if (!isNaN(hum)) {
    els.humValue.textContent = Math.round(hum);
    
    const humPercent = Math.max(0, Math.min(100, hum));
    els.humBar.style.width = `${humPercent}%`;
    
    if (hum < 30) {
      els.humBadge.textContent = "Dry";
      els.humBadge.style.color = "#fbbf24";
    } else if (hum <= 60) {
      els.humBadge.textContent = "Optimal";
      els.humBadge.style.color = "#34d399";
    } else {
      els.humBadge.textContent = "Humid";
      els.humBadge.style.color = "#38bdf8";
    }
    
    if (previousHum !== null) {
      const diff = Math.round(hum - previousHum);
      els.humTrend.textContent = diff > 0 ? `▲ +${diff}%` : (diff < 0 ? `▼ ${diff}%` : "= Stable");
    }
    previousHum = hum;
  }
  
  // Format Date/Time
  const dateObj = new Date(timestamp);
  els.lastReceivedTime.textContent = `${dateObj.toLocaleDateString()} ${dateObj.toLocaleTimeString()} (${formatTimeAgo(timestamp)})`;
  
  // Recompute online / offline status immediately
  evaluateDevicePresence();
}

function renderHistoryTable(records) {
  els.historyCount.textContent = `${records.length} Records`;
  
  if (!records || records.length === 0) {
    els.historyTbody.innerHTML = `
      <tr>
        <td colspan="4" class="empty-state">
          <div class="empty-wrap">
            <span class="empty-icon">📭</span>
            <p>No historical records displayed.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }
  
  const rowsHtml = records.map((item, idx) => {
    const date = new Date(item.timestamp);
    const timeFormatted = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    const tVal = typeof item.temperature === "number" ? item.temperature.toFixed(1) : item.temperature;
    const hVal = typeof item.humidity === "number" ? Math.round(item.humidity) : item.humidity;
    
    return `
      <tr>
        <td class="font-mono text-muted">#${idx + 1}</td>
        <td><span class="val-badge val-temp">${tVal} °C</span></td>
        <td><span class="val-badge val-hum">${hVal} %</span></td>
        <td class="font-mono text-muted">${timeFormatted}</td>
      </tr>
    `;
  }).join("");
  
  els.historyTbody.innerHTML = rowsHtml;
}

// ============================================================================
// 10. DEVICE PRESENCE & ONLINE/OFFLINE DETECTION
// ============================================================================
function evaluateDevicePresence() {
  if (!lastReceivedTimestamp) {
    setDeviceStatusUI(false, "Waiting for initial sensor payload");
    return;
  }
  
  const now = Date.now();
  const diffMs = now - lastReceivedTimestamp;
  const timeoutMs = activeSettings.offlineTimeoutMs || 10000;
  
  if (diffMs <= timeoutMs) {
    setDeviceStatusUI(true, `Streaming live telemetry (active ${Math.round(diffMs / 1000)}s ago)`);
  } else {
    setDeviceStatusUI(false, `No telemetry received for ${Math.round(diffMs / 1000)}s (Threshold: ${timeoutMs / 1000}s)`);
  }
}

function setDeviceStatusUI(isOnline, description) {
  els.devicePresenceBadge.className = `badge ${isOnline ? "badge-online" : "badge-offline"}`;
  els.devicePresenceText.textContent = isOnline ? "ONLINE" : "OFFLINE";
  els.deviceStateDesc.textContent = description;
}

function updateConnectionStatus(state, message) {
  els.streamIndicator.className = `status-pill status-${state}`;
  els.streamIndicatorText.textContent = message;
}

function updateSyncTime() {
  const d = new Date();
  els.displayLastSync.textContent = d.toLocaleTimeString();
}

function formatTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

// Periodic ticker: every 1s check device online/offline and refresh time-ago
setInterval(() => {
  evaluateDevicePresence();
  if (lastReceivedTimestamp > 0) {
    const dateObj = new Date(lastReceivedTimestamp);
    els.lastReceivedTime.textContent = `${dateObj.toLocaleDateString()} ${dateObj.toLocaleTimeString()} (${formatTimeAgo(lastReceivedTimestamp)})`;
  }
}, 1000);

// ============================================================================
// 11. CONTROLS & EVENT LISTENERS
// ============================================================================

// 1. Refresh Data Button
els.btnRefresh.addEventListener("click", async () => {
  els.btnRefresh.disabled = true;
  await manualFetchData();
  setTimeout(() => { els.btnRefresh.disabled = false; }, 600);
});

// 2. Toggle Live Monitoring Button
els.btnToggleLive.addEventListener("click", () => {
  isLiveMonitoring = !isLiveMonitoring;
  
  if (isLiveMonitoring) {
    els.btnToggleLive.classList.add("active");
    els.btnLiveText.textContent = "Live Monitoring: ON";
    updateConnectionStatus("connected", "Live Streaming");
    startRealtimeListeners();
    showToast("Real-time listener resumed", "info");
  } else {
    els.btnToggleLive.classList.remove("active");
    els.btnLiveText.textContent = "Live Monitoring: OFF";
    updateConnectionStatus("disconnected", "Paused (Manual Only)");
    stopRealtimeListeners();
    showToast("Real-time listener paused", "info");
  }
});

// 3. Clear Display Button (Clears only DOM table, does NOT touch Firebase)
els.btnClearTable.addEventListener("click", () => {
  displayedHistory = [];
  renderHistoryTable([]);
  showToast("History display cleared (Firebase records preserved)", "info");
});

// 4. Connection Test Button
els.btnTestConnection.addEventListener("click", async () => {
  if (!db) {
    showToast("Firebase client is not initialized.", "error");
    return;
  }
  
  const startTime = performance.now();
  els.btnTestConnection.disabled = true;
  updateConnectionStatus("connecting", "Testing Connection...");
  
  try {
    const deviceId = activeSettings.deviceId || "device_01";
    const testRef = ref(db, `DHTPulse/${deviceId}/latest`);
    const snap = await get(testRef);
    const latency = Math.round(performance.now() - startTime);
    
    updateConnectionStatus("connected", isLiveMonitoring ? "Live Streaming" : "Connected");
    showToast(`Firebase Ping Success! Latency: ${latency}ms`, "success");
  } catch (error) {
    const latency = Math.round(performance.now() - startTime);
    updateConnectionStatus("error", "Ping Failed");
    showToast(`Connection Test Failed (${latency}ms): ${error.message}`, "error");
  } finally {
    els.btnTestConnection.disabled = false;
  }
});

// ============================================================================
// 12. CONFIGURATION MODAL HANDLERS
// ============================================================================
els.btnOpenSettings.addEventListener("click", () => {
  // Populate form with current active values
  els.cfgApiKey.value = activeConfig.apiKey || "";
  els.cfgDbUrl.value = activeConfig.databaseURL || "";
  els.cfgProjId.value = activeConfig.projectId || "";
  els.cfgAuthType.value = activeSettings.authMode || "anonymous";
  els.cfgDeviceId.value = activeSettings.deviceId || "device_01";
  els.cfgEmail.value = activeSettings.testEmail || "";
  els.cfgPassword.value = activeSettings.testPassword || "";
  
  toggleAuthFields(els.cfgAuthType.value);
  els.configModal.classList.remove("hidden");
});

els.btnCloseModal.addEventListener("click", () => {
  els.configModal.classList.add("hidden");
});

els.cfgAuthType.addEventListener("change", (e) => {
  toggleAuthFields(e.target.value);
});

function toggleAuthFields(authMode) {
  if (authMode === "email") {
    els.emailAuthFields.classList.remove("hidden");
  } else {
    els.emailAuthFields.classList.add("hidden");
  }
}

els.btnResetConfig.addEventListener("click", () => {
  if (confirm("Reset configuration to default placeholders?")) {
    localStorage.removeItem("dhtpulse_firebase_config");
    localStorage.removeItem("dhtpulse_settings");
    loadStoredSettings();
    els.configModal.classList.add("hidden");
    initFirebase();
  }
});

els.configForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  
  const updatedConfig = {
    ...activeConfig,
    apiKey: els.cfgApiKey.value.trim(),
    databaseURL: els.cfgDbUrl.value.trim(),
    projectId: els.cfgProjId.value.trim(),
    authDomain: `${els.cfgProjId.value.trim()}.firebaseapp.com`
  };
  
  const updatedSettings = {
    ...activeSettings,
    authMode: els.cfgAuthType.value,
    deviceId: els.cfgDeviceId.value.trim(),
    testEmail: els.cfgEmail.value.trim(),
    testPassword: els.cfgPassword.value
  };
  
  saveSettings(updatedConfig, updatedSettings);
  els.configModal.classList.add("hidden");
  showToast("Configuration saved! Reconnecting...", "info");
  
  await initFirebase();
});

// ============================================================================
// 13. BOOTSTRAP APPLICATION
// ============================================================================
window.addEventListener("DOMContentLoaded", () => {
  loadStoredSettings();
  initFirebase();
});

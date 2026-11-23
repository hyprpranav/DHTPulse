/**
 * ============================================================================
 * ThermoTrace — Industrial Thermal & Optical Monitoring
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
  remove,
  off 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { 
  getAuth, 
  signInAnonymously 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// ============================================================================
// 1. DEFAULT FIREBASE CONFIGURATION
// ============================================================================
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
  deviceId: "converter_01",
  offlineTimeoutMs: 10000 // 10s watchdog
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
let previousMachineryTemp = null;
let previousOpticalVolt = null;

// Telemetry datasets
let rawHistoryRecords = []; // All records fetched from Firebase
let filteredHistoryRecords = []; // Records after active filters
let selectedTimestamps = new Set();
let pendingDeleteTimestamps = [];

// ============================================================================
// 3. DOM ELEMENTS
// ============================================================================
const els = {
  // Status pills & badges
  streamIndicator: document.getElementById("stream-indicator"),
  streamIndicatorText: document.getElementById("stream-indicator-text"),
  thermalAlertBadge: document.getElementById("thermal-alert-badge"),
  thermalAlertText: document.getElementById("thermal-alert-text"),
  devicePresenceBadge: document.getElementById("device-presence-badge"),
  devicePresenceText: document.getElementById("device-presence-text"),
  
  // Overview
  deviceName: document.getElementById("device-name"),
  wifiStatus: document.getElementById("wifi-status"),
  firebaseStatus: document.getElementById("firebase-status"),
  refractoryRiskDesc: document.getElementById("refractory-risk-desc"),
  lastReceivedTime: document.getElementById("last-received-time"),
  displayLastSync: document.getElementById("display-last-sync"),
  rtdbPathPreview: document.getElementById("rtdb-path-preview"),
  
  // Card 1: Machinery Surface Heat (MLX90614)
  machineryTempValue: document.getElementById("machinery-temp-value"),
  machineryTempBar: document.getElementById("machinery-temp-bar"),
  mlxAlertBadge: document.getElementById("mlx-alert-badge"),
  mlxAmbientVal: document.getElementById("mlx-ambient-val"),
  machineryTempTrend: document.getElementById("machinery-temp-trend"),
  
  // Card 2: Thermal Differential (ΔT)
  deltaTempValue: document.getElementById("delta-temp-value"),
  deltaTempBar: document.getElementById("delta-temp-bar"),
  gradientBadge: document.getElementById("gradient-badge"),
  deltaRiskText: document.getElementById("delta-risk-text"),
  gradientTrend: document.getElementById("gradient-trend"),
  
  // Card 3: Optical Radiation (BPW34)
  opticalVoltValue: document.getElementById("optical-volt-value"),
  opticalBar: document.getElementById("optical-bar"),
  opticalBadge: document.getElementById("optical-badge"),
  opticalIndexVal: document.getElementById("optical-index-val"),
  opticalTrend: document.getElementById("optical-trend"),
  
  // Card 4: Environmental Reference (DHT11)
  envTempValue: document.getElementById("env-temp-value"),
  envHumValue: document.getElementById("env-hum-value"),
  envHumBar: document.getElementById("env-hum-bar"),
  envBadge: document.getElementById("env-badge"),
  envStatusDesc: document.getElementById("env-status-desc"),
  
  // History Table & Batch Controls
  historyTbody: document.getElementById("history-tbody"),
  historyCount: document.getElementById("history-count"),
  filterTime: document.getElementById("filter-time"),
  filterAlert: document.getElementById("filter-alert"),
  selectAllRows: document.getElementById("select-all-rows"),
  selectedCount: document.getElementById("selected-count"),
  btnDeleteSelected: document.getElementById("btn-delete-selected"),
  btnPruneOld: document.getElementById("btn-prune-old"),
  btnExportCsv: document.getElementById("btn-export-csv"),
  
  // Global Action Buttons
  btnRefresh: document.getElementById("btn-refresh"),
  btnToggleLive: document.getElementById("btn-toggle-live"),
  btnLiveText: document.getElementById("btn-live-text"),
  btnTestConnection: document.getElementById("btn-test-connection"),
  btnOpenSettings: document.getElementById("btn-open-settings"),
  
  // Modals
  configModal: document.getElementById("config-modal"),
  btnCloseModal: document.getElementById("btn-close-modal"),
  configForm: document.getElementById("config-form"),
  btnResetConfig: document.getElementById("btn-reset-config"),
  cfgApiKey: document.getElementById("cfg-apiKey"),
  cfgDbUrl: document.getElementById("cfg-dbUrl"),
  cfgProjId: document.getElementById("cfg-projId"),
  cfgDeviceId: document.getElementById("cfg-deviceId"),
  
  deleteModal: document.getElementById("delete-modal"),
  btnCloseDeleteModal: document.getElementById("btn-close-delete-modal"),
  btnCancelDelete: document.getElementById("btn-cancel-delete"),
  btnConfirmDelete: document.getElementById("btn-confirm-delete"),
  deleteModalMsg: document.getElementById("delete-modal-msg"),
  
  // Toast
  toast: document.getElementById("toast"),
  toastMessage: document.getElementById("toast-message"),
  toastIcon: document.getElementById("toast-icon")
};

// ============================================================================
// 4. SETTINGS & LOCAL STORAGE
// ============================================================================
function loadStoredSettings() {
  const storedConfig = localStorage.getItem("thermotrace_firebase_config") || localStorage.getItem("dhtpulse_firebase_config");
  const storedSettings = localStorage.getItem("thermotrace_settings") || localStorage.getItem("dhtpulse_settings");
  
  if (storedConfig) {
    try {
      const parsed = JSON.parse(storedConfig);
      if (!parsed.apiKey || parsed.apiKey.includes("YOUR_")) {
        activeConfig = { ...DEFAULT_FIREBASE_CONFIG };
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
  
  // Sync UI path preview
  if (els.rtdbPathPreview) {
    els.rtdbPathPreview.textContent = `/ThermoTrace/${activeSettings.deviceId}`;
  }
}

function saveSettings(config, settings) {
  localStorage.setItem("thermotrace_firebase_config", JSON.stringify(config));
  localStorage.setItem("thermotrace_settings", JSON.stringify(settings));
  activeConfig = config;
  activeSettings = settings;
}

// ============================================================================
// 5. TOAST NOTIFICATION
// ============================================================================
let toastTimeout = null;
function showToast(message, type = "info") {
  if (toastTimeout) clearTimeout(toastTimeout);
  const icons = { info: "ℹ️", success: "✅", warning: "⚠️", error: "❌" };
  els.toastIcon.textContent = icons[type] || "ℹ️";
  els.toastMessage.textContent = message;
  els.toast.classList.remove("hidden");
  toastTimeout = setTimeout(() => { els.toast.classList.add("hidden"); }, 4000);
}

// ============================================================================
// 6. FIREBASE INITIALIZATION & AUTHENTICATION
// ============================================================================
async function initFirebase() {
  updateConnectionStatus("connecting", "Connecting to Cloud...");
  
  try {
    const existingApps = getApps();
    if (existingApps.length > 0) {
      await deleteApp(existingApps[0]);
    }
    
    app = initializeApp(activeConfig);
    db = getDatabase(app);
    auth = getAuth(app);
    
    // Authenticate anonymously
    updateConnectionStatus("connecting", "Authenticating...");
    await signInAnonymously(auth);
    
    els.firebaseStatus.textContent = "CONNECTED (Authenticated)";
    updateConnectionStatus("connected", "Live Streaming");
    showToast("Connected to Firebase RTDB Cloud", "success");
    
    if (isLiveMonitoring) {
      startRealtimeListeners();
    } else {
      manualFetchData();
    }
  } catch (error) {
    console.error("Firebase Init Error:", error);
    updateConnectionStatus("error", "Auth Error");
    els.firebaseStatus.textContent = "ERROR: " + (error.code || error.message);
    showToast("Firebase Error: " + error.message, "error");
  }
}

// ============================================================================
// 7. REAL-TIME TELEMETRY STREAMING
// ============================================================================
function startRealtimeListeners() {
  if (!db || !auth || !auth.currentUser) return;
  
  const deviceId = activeSettings.deviceId || "converter_01";
  
  // Listen to ThermoTrace primary node (with fallback support)
  const latestRef = ref(db, `ThermoTrace/${deviceId}/latest`);
  const historyRef = ref(db, `ThermoTrace/${deviceId}/history`);
  
  stopRealtimeListeners();
  
  // 1. Real-time Latest Telemetry
  unsubscribeLatest = onValue(latestRef, (snapshot) => {
    updateSyncTime();
    if (snapshot.exists()) {
      renderLatestData(snapshot.val());
    } else {
      // Check legacy path if converter_01 has not pushed yet
      fallbackCheckLegacyLatest(deviceId);
    }
  }, (err) => {
    console.warn("Latest node read notice:", err);
  });
  
  // 2. Real-time Full Historical Ledger (No 20-record limit!)
  unsubscribeHistory = onValue(historyRef, (snapshot) => {
    if (snapshot.exists()) {
      const historyMap = snapshot.val();
      parseAndSetHistory(historyMap);
    } else {
      fallbackCheckLegacyHistory(deviceId);
    }
  }, (err) => {
    console.warn("History node read notice:", err);
  });
}

function stopRealtimeListeners() {
  if (unsubscribeLatest) { unsubscribeLatest(); unsubscribeLatest = null; }
  if (unsubscribeHistory) { unsubscribeHistory(); unsubscribeHistory = null; }
}

async function fallbackCheckLegacyLatest(deviceId) {
  try {
    const legacySnap = await get(ref(db, `DHTPulse/${deviceId}/latest`));
    if (legacySnap.exists()) {
      renderLatestData(legacySnap.val());
    } else {
      els.refractoryRiskDesc.textContent = "Waiting for initial sensor transmission...";
    }
  } catch (e) { /* ignore */ }
}

async function fallbackCheckLegacyHistory(deviceId) {
  try {
    const legacyHistSnap = await get(ref(db, `DHTPulse/${deviceId}/history`));
    if (legacyHistSnap.exists()) {
      parseAndSetHistory(legacyHistSnap.val());
    }
  } catch (e) { /* ignore */ }
}

function parseAndSetHistory(historyMap) {
  const records = [];
  Object.keys(historyMap).forEach((key) => {
    const item = historyMap[key];
    const ts = item.timestamp ? Number(item.timestamp) : Number(key) || 0;
    records.push({
      id: key,
      machineryTemp: item.machineryTemp !== undefined ? item.machineryTemp : (item.temperature || 0),
      ambientTemp: item.ambientTemp !== undefined ? item.ambientTemp : 25.0,
      deltaTemp: item.deltaTemp !== undefined ? item.deltaTemp : Math.max(0, (item.machineryTemp || item.temperature || 0) - (item.ambientTemp || 25.0)),
      envHumidity: item.envHumidity !== undefined ? item.envHumidity : (item.humidity || 0),
      opticalVoltage: item.opticalVoltage !== undefined ? item.opticalVoltage : ((item.opticalRadiation || 0) / 1000 * 3.3),
      opticalRadiation: item.opticalRadiation || 0,
      alertLevel: item.alertLevel || "NORMAL",
      timestamp: ts
    });
  });
  
  // Sort reverse-chronological (newest first)
  records.sort((a, b) => b.timestamp - a.timestamp);
  rawHistoryRecords = records;
  applyHistoryFilters();
}

// ============================================================================
// 8. DATA RENDERING & SENSOR GAUGE CALCULATIONS
// ============================================================================
function renderLatestData(data) {
  if (!data) return;
  
  const machineryTemp = data.machineryTemp !== undefined ? Number(data.machineryTemp) : Number(data.temperature || 0);
  const ambientTemp = data.ambientTemp !== undefined ? Number(data.ambientTemp) : 25.0;
  const deltaTemp = data.deltaTemp !== undefined ? Number(data.deltaTemp) : Math.max(0, machineryTemp - ambientTemp);
  const envHumidity = data.envHumidity !== undefined ? Number(data.envHumidity) : Number(data.humidity || 0);
  const opticalVoltage = data.opticalVoltage !== undefined ? Number(data.opticalVoltage) : Number((data.opticalRadiation || 0) / 1000 * 3.3);
  const opticalRadiation = Number(data.opticalRadiation || 0);
  const alertLevel = data.alertLevel || classifyAlert(machineryTemp, deltaTemp);
  const ts = data.timestamp ? Number(data.timestamp) : Date.now();
  
  lastReceivedTimestamp = ts;
  
  // --- CARD 1: MLX90614 Machinery Surface Heat ---
  els.machineryTempValue.textContent = machineryTemp.toFixed(1);
  const machBarPercent = Math.max(0, Math.min(100, (machineryTemp / 600) * 100));
  els.machineryTempBar.style.width = `${machBarPercent}%`;
  els.mlxAmbientVal.textContent = `${ambientTemp.toFixed(1)} °C`;
  
  if (previousMachineryTemp !== null) {
    const diff = (machineryTemp - previousMachineryTemp).toFixed(1);
    els.machineryTempTrend.textContent = diff > 0 ? `▲ +${diff}°C` : (diff < 0 ? `▼ ${diff}°C` : "= Stable");
  }
  previousMachineryTemp = machineryTemp;
  
  // --- CARD 2: Thermal Differential (ΔT) ---
  els.deltaTempValue.textContent = deltaTemp.toFixed(1);
  const deltaBarPercent = Math.max(0, Math.min(100, (deltaTemp / 400) * 100));
  els.deltaTempBar.style.width = `${deltaBarPercent}%`;
  
  if (deltaTemp >= 400) {
    els.gradientBadge.textContent = "CRITICAL RUNAWAY";
    els.gradientBadge.className = "metric-badge badge-critical";
    els.deltaRiskText.textContent = "Refractory Failure Imminent";
    els.deltaRiskText.style.color = "#ef4444";
  } else if (deltaTemp >= 200) {
    els.gradientBadge.textContent = "WARNING LEVEL";
    els.gradientBadge.className = "metric-badge badge-warning";
    els.deltaRiskText.textContent = "Shell Expansion Risk";
    els.deltaRiskText.style.color = "#f97316";
  } else if (deltaTemp >= 80) {
    els.gradientBadge.textContent = "ELEVATED HEAT";
    els.gradientBadge.className = "metric-badge badge-elevated";
    els.deltaRiskText.textContent = "Moderate Gradient";
    els.deltaRiskText.style.color = "#fbbf24";
  } else {
    els.gradientBadge.textContent = "STABLE GRADIENT";
    els.gradientBadge.className = "metric-badge";
    els.deltaRiskText.textContent = "Normal Range";
    els.deltaRiskText.style.color = "#34d399";
  }
  
  // --- CARD 3: BPW34 Optical Radiation ---
  els.opticalVoltValue.textContent = opticalVoltage.toFixed(2);
  const opticalPercent = Math.max(0, Math.min(100, (opticalVoltage / 3.3) * 100));
  els.opticalBar.style.width = `${opticalPercent}%`;
  els.opticalIndexVal.textContent = `${Math.round(opticalRadiation)} / 1000`;
  
  if (previousOpticalVolt !== null) {
    const optDiff = (opticalVoltage - previousOpticalVolt).toFixed(2);
    els.opticalTrend.textContent = optDiff > 0 ? `▲ +${optDiff}V` : (optDiff < 0 ? `▼ ${optDiff}V` : "= Steady");
  }
  previousOpticalVolt = opticalVoltage;
  
  // --- CARD 4: DHT11 Environmental Reference ---
  els.envTempValue.textContent = ambientTemp.toFixed(1);
  els.envHumValue.textContent = Math.round(envHumidity);
  els.envHumBar.style.width = `${Math.max(0, Math.min(100, envHumidity))}%`;
  
  // Overall System Thermal Alert Badge
  applyAlertBadge(alertLevel, machineryTemp, deltaTemp);
  
  // Time formatting
  const d = new Date(ts);
  els.lastReceivedTime.textContent = `${d.toLocaleDateString()} ${d.toLocaleTimeString()} (${formatTimeAgo(ts)})`;
  
  evaluateDevicePresence();
}

function classifyAlert(objTemp, deltaTemp) {
  if (objTemp >= 500 || deltaTemp >= 400) return "CRITICAL";
  if (objTemp >= 300 || deltaTemp >= 200) return "WARNING";
  if (objTemp >= 120 || deltaTemp >= 80) return "ELEVATED";
  return "NORMAL";
}

function applyAlertBadge(level, objTemp, deltaTemp) {
  els.thermalAlertBadge.className = `badge badge-${level.toLowerCase()}`;
  els.thermalAlertText.textContent = `THERMAL ${level}`;
  
  if (level === "CRITICAL") {
    els.refractoryRiskDesc.textContent = `CRITICAL ALERT: Shell at ${objTemp.toFixed(1)}°C (ΔT: ${deltaTemp.toFixed(1)}°C)! Refractory check required.`;
    els.refractoryRiskDesc.style.color = "#f87171";
  } else if (level === "WARNING") {
    els.refractoryRiskDesc.textContent = `Warning: High thermal flux detected. Inspect converter perimeter.`;
    els.refractoryRiskDesc.style.color = "#fb923c";
  } else if (level === "ELEVATED") {
    els.refractoryRiskDesc.textContent = `Elevated operating state. Normal production heat observed.`;
    els.refractoryRiskDesc.style.color = "#fbbf24";
  } else {
    els.refractoryRiskDesc.textContent = `Thermal integrity optimal. Shell temperature within safe envelope.`;
    els.refractoryRiskDesc.style.color = "#34d399";
  }
}

// ============================================================================
// 9. HISTORY FILTERING, RENDERING & PAGINATION
// ============================================================================
function applyHistoryFilters() {
  const timeFilter = els.filterTime.value;
  const alertFilter = els.filterAlert.value;
  const now = Date.now();
  
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTodayMs = startOfToday.getTime();
  
  filteredHistoryRecords = rawHistoryRecords.filter((item) => {
    // Time filter
    if (timeFilter === "today" && item.timestamp < startOfTodayMs) return false;
    if (timeFilter === "24h" && (now - item.timestamp > 24 * 3600 * 1000)) return false;
    if (timeFilter === "7d" && (now - item.timestamp > 7 * 24 * 3600 * 1000)) return false;
    
    // Alert filter
    if (alertFilter === "elevated" && item.alertLevel === "NORMAL") return false;
    if (alertFilter === "warning" && (item.alertLevel === "NORMAL" || item.alertLevel === "ELEVATED")) return false;
    if (alertFilter === "critical" && item.alertLevel !== "CRITICAL") return false;
    
    return true;
  });
  
  renderHistoryTable(filteredHistoryRecords);
}

function renderHistoryTable(records) {
  els.historyCount.textContent = `${records.length} of ${rawHistoryRecords.length} Records`;
  
  if (!records || records.length === 0) {
    els.historyTbody.innerHTML = `
      <tr>
        <td colspan="9" class="empty-state">
          <div class="empty-wrap">
            <span class="empty-icon">📭</span>
            <p>No historical records matching the active filters.</p>
          </div>
        </td>
      </tr>
    `;
    updateBatchSelectionUI();
    return;
  }
  
  const rowsHtml = records.map((item, idx) => {
    const isSelected = selectedTimestamps.has(item.id);
    const d = new Date(item.timestamp);
    const formattedDate = `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
    const alertClass = `badge-${item.alertLevel.toLowerCase()}`;
    
    return `
      <tr class="${isSelected ? "row-selected" : ""}" data-id="${item.id}">
        <td>
          <label class="checkbox-container">
            <input type="checkbox" class="row-checkbox" data-id="${item.id}" ${isSelected ? "checked" : ""}>
            <span class="checkmark"></span>
          </label>
        </td>
        <td class="font-mono text-muted text-sm">#${idx + 1}</td>
        <td><span class="val-badge val-hot">${item.machineryTemp.toFixed(1)} °C</span></td>
        <td><span class="val-badge val-env">${item.ambientTemp.toFixed(1)} °C</span></td>
        <td><span class="val-badge val-delta">+${item.deltaTemp.toFixed(1)} °C Δ</span></td>
        <td><span class="val-badge val-env">${Math.round(item.envHumidity)} %</span></td>
        <td><span class="val-badge val-optical">${item.opticalVoltage.toFixed(2)}V (${Math.round(item.opticalRadiation)})</span></td>
        <td><span class="badge ${alertClass}">${item.alertLevel}</span></td>
        <td class="font-mono text-muted text-sm">${formattedDate}</td>
      </tr>
    `;
  }).join("");
  
  els.historyTbody.innerHTML = rowsHtml;
  
  // Attach checkbox listeners
  document.querySelectorAll(".row-checkbox").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = e.target.getAttribute("data-id");
      if (e.target.checked) {
        selectedTimestamps.add(id);
      } else {
        selectedTimestamps.delete(id);
      }
      updateBatchSelectionUI();
    });
  });
  
  updateBatchSelectionUI();
}

function updateBatchSelectionUI() {
  const count = selectedTimestamps.size;
  els.selectedCount.textContent = `(${count} selected)`;
  els.btnDeleteSelected.disabled = count === 0;
  
  if (filteredHistoryRecords.length > 0 && selectedTimestamps.size === filteredHistoryRecords.length) {
    els.selectAllRows.checked = true;
  } else {
    els.selectAllRows.checked = false;
  }
}

// ============================================================================
// 10. EXCEL / CSV EXPORT
// ============================================================================
function exportHistoryToCSV() {
  const recordsToExport = filteredHistoryRecords.length > 0 ? filteredHistoryRecords : rawHistoryRecords;
  if (!recordsToExport || recordsToExport.length === 0) {
    showToast("No telemetry records available to export.", "warning");
    return;
  }
  
  // CSV Header
  const headers = [
    "Index",
    "Record ID (Timestamp)",
    "ISO Date/Time",
    "Local Date",
    "Local Time",
    "Machinery Surface Temp (C)",
    "Ambient Temp (C)",
    "Thermal Differential Delta-T (C)",
    "Environmental Humidity (%)",
    "Optical Radiation Voltage (V)",
    "Optical Flux Index (0-1000)",
    "Thermal Alert Status"
  ];
  
  const csvRows = [headers.join(",")];
  
  recordsToExport.forEach((rec, idx) => {
    const d = new Date(rec.timestamp);
    const row = [
      idx + 1,
      `"${rec.id}"`,
      `"${d.toISOString()}"`,
      `"${d.toLocaleDateString()}"`,
      `"${d.toLocaleTimeString()}"`,
      rec.machineryTemp.toFixed(2),
      rec.ambientTemp.toFixed(2),
      rec.deltaTemp.toFixed(2),
      rec.envHumidity.toFixed(1),
      rec.opticalVoltage.toFixed(3),
      Math.round(rec.opticalRadiation),
      `"${rec.alertLevel}"`
    ];
    csvRows.push(row.join(","));
  });
  
  // Add UTF-8 BOM for Microsoft Excel compatibility
  const csvString = "\uFEFF" + csvRows.join("\r\n");
  const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement("a");
  const dateStr = new Date().toISOString().slice(0, 10);
  link.setAttribute("href", url);
  link.setAttribute("download", `ThermoTrace_Telemetry_${activeSettings.deviceId}_${dateStr}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  
  showToast(`Exported ${recordsToExport.length} telemetry records to CSV/Excel!`, "success");
}

// ============================================================================
// 11. SELECTIVE DELETE & STORAGE PRUNING (FREE UP CLOUD SPACE)
// ============================================================================
function promptDeleteSelected() {
  if (selectedTimestamps.size === 0) return;
  pendingDeleteTimestamps = Array.from(selectedTimestamps);
  els.deleteModalMsg.textContent = `Are you sure you want to permanently delete ${pendingDeleteTimestamps.length} selected record(s) from Firebase Realtime Database? This will permanently free up cloud storage.`;
  els.deleteModal.classList.remove("hidden");
}

function promptPruneOld() {
  const sevenDaysAgo = Date.now() - (7 * 24 * 3600 * 1000);
  const oldRecords = rawHistoryRecords.filter(r => r.timestamp < sevenDaysAgo);
  
  if (oldRecords.length === 0) {
    showToast("No records older than 7 days found.", "info");
    return;
  }
  
  pendingDeleteTimestamps = oldRecords.map(r => r.id);
  els.deleteModalMsg.textContent = `Found ${pendingDeleteTimestamps.length} telemetry log(s) older than 7 days. Permanently delete them from Firebase to free up cloud quota?`;
  els.deleteModal.classList.remove("hidden");
}

async function executeCloudDeletion() {
  if (!db || pendingDeleteTimestamps.length === 0) {
    els.deleteModal.classList.add("hidden");
    return;
  }
  
  const deviceId = activeSettings.deviceId || "converter_01";
  showToast(`Deleting ${pendingDeleteTimestamps.length} records from Firebase...`, "info");
  
  try {
    const deletePromises = pendingDeleteTimestamps.map((key) => {
      // Delete from ThermoTrace node
      const nodeRef = ref(db, `ThermoTrace/${deviceId}/history/${key}`);
      return remove(nodeRef).catch(() => {});
    });
    
    await Promise.all(deletePromises);
    
    // Clear selection
    selectedTimestamps.clear();
    pendingDeleteTimestamps = [];
    els.deleteModal.classList.add("hidden");
    
    showToast("Selected cloud records successfully deleted!", "success");
  } catch (error) {
    console.error("Deletion error:", error);
    showToast("Cloud deletion error: " + error.message, "error");
    els.deleteModal.classList.add("hidden");
  }
}

// ============================================================================
// 12. DEVICE WATCHDOG & CONNECTION HELPERS
// ============================================================================
function evaluateDevicePresence() {
  if (!lastReceivedTimestamp) {
    setDeviceStatusUI(false, "Waiting for initial sensor payload");
    return;
  }
  const diffMs = Date.now() - lastReceivedTimestamp;
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
  if (!isOnline && els.thermalAlertText.textContent.includes("NORMAL")) {
    els.refractoryRiskDesc.textContent = description;
  }
}

function updateConnectionStatus(state, message) {
  els.streamIndicator.className = `status-pill status-${state}`;
  els.streamIndicatorText.textContent = message;
}

function updateSyncTime() {
  els.displayLastSync.textContent = new Date().toLocaleTimeString();
}

function formatTimeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 2) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

// Periodic 1-second watchdog ticker
setInterval(() => {
  evaluateDevicePresence();
  if (lastReceivedTimestamp > 0) {
    const d = new Date(lastReceivedTimestamp);
    els.lastReceivedTime.textContent = `${d.toLocaleDateString()} ${d.toLocaleTimeString()} (${formatTimeAgo(lastReceivedTimestamp)})`;
  }
}, 1000);

// ============================================================================
// 13. MANUAL REFRESH & CONNECTION TEST
// ============================================================================
async function manualFetchData() {
  if (!db) return;
  showToast("Fetching latest cloud data...", "info");
  const deviceId = activeSettings.deviceId || "converter_01";
  
  try {
    const [latestSnap, historySnap] = await Promise.all([
      get(ref(db, `ThermoTrace/${deviceId}/latest`)),
      get(ref(db, `ThermoTrace/${deviceId}/history`))
    ]);
    
    updateSyncTime();
    if (latestSnap.exists()) renderLatestData(latestSnap.val());
    if (historySnap.exists()) parseAndSetHistory(historySnap.val());
    showToast("Data refreshed from cloud successfully!", "success");
  } catch (err) {
    showToast("Refresh error: " + err.message, "error");
  }
}

// ============================================================================
// 14. EVENT LISTENERS
// ============================================================================

// Refresh button
els.btnRefresh.addEventListener("click", async () => {
  els.btnRefresh.disabled = true;
  await manualFetchData();
  setTimeout(() => { els.btnRefresh.disabled = false; }, 600);
});

// Live toggle
els.btnToggleLive.addEventListener("click", () => {
  isLiveMonitoring = !isLiveMonitoring;
  if (isLiveMonitoring) {
    els.btnToggleLive.classList.add("active");
    els.btnLiveText.textContent = "Live Stream: ON";
    updateConnectionStatus("connected", "Live Streaming");
    startRealtimeListeners();
    showToast("Real-time telemetry resumed", "info");
  } else {
    els.btnToggleLive.classList.remove("active");
    els.btnLiveText.textContent = "Live Stream: OFF";
    updateConnectionStatus("disconnected", "Paused (Manual Only)");
    stopRealtimeListeners();
    showToast("Real-time telemetry paused", "info");
  }
});

// Ping test
els.btnTestConnection.addEventListener("click", async () => {
  if (!db) return;
  const start = performance.now();
  els.btnTestConnection.disabled = true;
  try {
    await get(ref(db, `ThermoTrace/${activeSettings.deviceId}/latest`));
    const latency = Math.round(performance.now() - start);
    showToast(`Cloud Ping Success! Latency: ${latency}ms`, "success");
  } catch (e) {
    showToast(`Ping failed: ${e.message}`, "error");
  } finally {
    els.btnTestConnection.disabled = false;
  }
});

// Excel Export
els.btnExportCsv.addEventListener("click", exportHistoryToCSV);

// Filter changes
els.filterTime.addEventListener("change", applyHistoryFilters);
els.filterAlert.addEventListener("change", applyHistoryFilters);

// Select all rows
els.selectAllRows.addEventListener("change", (e) => {
  if (e.target.checked) {
    filteredHistoryRecords.forEach(r => selectedTimestamps.add(r.id));
  } else {
    selectedTimestamps.clear();
  }
  renderHistoryTable(filteredHistoryRecords);
});

// Delete actions
els.btnDeleteSelected.addEventListener("click", promptDeleteSelected);
els.btnPruneOld.addEventListener("click", promptPruneOld);
els.btnCancelDelete.addEventListener("click", () => els.deleteModal.classList.add("hidden"));
els.btnCloseDeleteModal.addEventListener("click", () => els.deleteModal.classList.add("hidden"));
els.btnConfirmDelete.addEventListener("click", executeCloudDeletion);

// Settings modal
els.btnOpenSettings.addEventListener("click", () => {
  els.cfgApiKey.value = activeConfig.apiKey || "";
  els.cfgDbUrl.value = activeConfig.databaseURL || "";
  els.cfgProjId.value = activeConfig.projectId || "";
  els.cfgDeviceId.value = activeSettings.deviceId || "converter_01";
  els.configModal.classList.remove("hidden");
});
els.btnCloseModal.addEventListener("click", () => els.configModal.classList.add("hidden"));
els.btnResetConfig.addEventListener("click", () => {
  if (confirm("Reset configuration to default project?")) {
    localStorage.removeItem("thermotrace_firebase_config");
    localStorage.removeItem("thermotrace_settings");
    loadStoredSettings();
    els.configModal.classList.add("hidden");
    initFirebase();
  }
});
els.configForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const updatedCfg = {
    ...activeConfig,
    apiKey: els.cfgApiKey.value.trim(),
    databaseURL: els.cfgDbUrl.value.trim(),
    projectId: els.cfgProjId.value.trim()
  };
  const updatedSet = {
    ...activeSettings,
    deviceId: els.cfgDeviceId.value.trim()
  };
  saveSettings(updatedCfg, updatedSet);
  els.configModal.classList.add("hidden");
  showToast("Settings saved. Reconnecting...", "info");
  initFirebase();
});

// ============================================================================
// 15. BOOTSTRAP
// ============================================================================
window.addEventListener("DOMContentLoaded", () => {
  loadStoredSettings();
  initFirebase();
});

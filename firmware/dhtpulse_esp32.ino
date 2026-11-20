/**
 * ============================================================================
 * Project: DHTPulse
 * Tagline: Real-Time IoT Monitoring & Connectivity Lab
 * File:    dhtpulse_esp32.ino
 * Target:  ESP32 DevKit / ESP32-WROOM-32
 * Sensor:  DHT11 Temperature & Humidity Sensor
 * Purpose: Reliable, non-blocking telemetry streaming to Firebase RTDB
 * ============================================================================
 * 
 * SENSOR WIRING:
 * ----------------------------------------------------------------------------
 * DHT11 Sensor Pin   | ESP32 GPIO Pin
 * -------------------|--------------------------------------------------------
 * VCC                | 3.3V (or 5V for module boards with built-in regulator)
 * GND                | GND
 * DATA               | GPIO 4 (Configurable below via DHTPIN)
 * ----------------------------------------------------------------------------
 * 
 * REQUIRED ARDUINO LIBRARIES:
 * 1. "DHT sensor library" by Adafruit (v1.4.6 or later)
 * 2. "Adafruit Unified Sensor" by Adafruit (v1.1.14 or later)
 * 3. "Firebase Arduino Client Library for ESP8266 and ESP32" by Mobizt (v4.4.14 or later)
 * 
 * INSTALLATION:
 * In Arduino IDE -> Tools -> Manage Libraries... Search and install the above.
 * ============================================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <time.h>
#include <DHT.h>
#include <Firebase_ESP_Client.h>

// Provide runtime token and RTDB helper functions
#include <addons/TokenHelper.h>
#include <addons/RTDBHelper.h>

// ============================================================================
// 1. HARDWARE CONFIGURATION
// ============================================================================
#define DHTPIN  4        // Digital GPIO pin connected to DHT11 DATA line
#define DHTTYPE DHT11    // DHT 11 sensor model

DHT dht(DHTPIN, DHTTYPE);

// ============================================================================
// 2. WI-FI CONFIGURATION
// ============================================================================
// Configured local 2.4 GHz Wi-Fi credentials
#define WIFI_SSID     "Oppo A77s"
#define WIFI_PASSWORD "9080061674"

// ============================================================================
// 3. FIREBASE CONFIGURATION
// ============================================================================
// Configured from dhtpulse-lab Firebase project settings
#define API_KEY       "AIzaSyDlFs_h1Lg1MqrioOw40r00nz_Le6oFCPg"
#define DATABASE_URL  "https://dhtpulse-lab-default-rtdb.asia-southeast1.firebasedatabase.app/"

/**
 * AUTHENTICATION SETTINGS:
 * Option A (Default): Anonymous Authentication (Enable in Firebase Console -> Authentication)
 * Option B: Dedicated Test User (Email/Password)
 *   Set USE_EMAIL_AUTH to true and provide user credentials.
 */
#define USE_EMAIL_AUTH false
#define USER_EMAIL     "dhtpulse-device@test.com"
#define USER_PASSWORD  "dhtpulseSecurePass123"

// Device Identifier in Firebase Realtime Database
const char* DEVICE_ID = "device_01";

// ============================================================================
// 4. TIMING & NON-BLOCKING SCHEDULING
// ============================================================================
const unsigned long UPLOAD_INTERVAL_MS = 2000;  // 2 seconds sample & upload interval
const unsigned long WIFI_RETRY_INTERVAL_MS = 5000; // 5 seconds Wi-Fi retry check

unsigned long lastUploadTime = 0;
unsigned long lastWifiRetryTime = 0;
bool wifiWasConnected = false;
bool firebaseReady = false;

// NTP Server Configuration for UTC Timestamps
const char* NTP_SERVER_1 = "pool.ntp.org";
const char* NTP_SERVER_2 = "time.nist.gov";
const long  GMT_OFFSET_SEC = 0;          // UTC offset in seconds
const int   DAYLIGHT_OFFSET_SEC = 0;     // Daylight savings offset

// Firebase objects
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

// ============================================================================
// HELPER: Obtain Current Epoch Timestamp in Milliseconds
// ============================================================================
unsigned long long getEpochTimestampMs() {
  struct timeval tv;
  if (gettimeofday(&tv, NULL) == 0 && tv.tv_sec > 1672531199) {
    // Valid time synchronized (after 2023-01-01)
    return ((unsigned long long)tv.tv_sec * 1000ULL) + ((unsigned long long)tv.tv_usec / 1000ULL);
  }
  // Fallback: system uptime in ms if NTP sync is still settling
  return (unsigned long long)millis();
}

// ============================================================================
// HELPER: Initialize and Connect to Wi-Fi
// ============================================================================
void initWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  
  Serial.println("[ INIT ] Connecting to Wi-Fi: " + String(WIFI_SSID));
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  // Wait up to 10 seconds for initial connection without blocking permanently
  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 10000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  
  if (WiFi.status() == WL_CONNECTED) {
    wifiWasConnected = true;
    Serial.println("[ OK ] Wi-Fi Connected!");
    Serial.print("[ INFO ] IP Address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("[ WARN ] Wi-Fi connection timed out. Will continue retrying in background.");
  }
}

// ============================================================================
// HELPER: Check Wi-Fi Health & Reconnect (Non-Blocking)
// ============================================================================
void monitorWiFiConnection() {
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiWasConnected) {
      Serial.println("\n[ WARN ] Wi-Fi connection lost! Attempting auto-reconnect...");
      wifiWasConnected = false;
      firebaseReady = false;
    }
    
    // Periodically re-trigger connect if disconnected
    if (millis() - lastWifiRetryTime >= WIFI_RETRY_INTERVAL_MS) {
      lastWifiRetryTime = millis();
      WiFi.reconnect();
    }
  } else {
    if (!wifiWasConnected) {
      Serial.println("\n[ OK ] Wi-Fi Reconnected!");
      Serial.print("[ INFO ] IP Address: ");
      Serial.println(WiFi.localIP());
      wifiWasConnected = true;
      // Re-trigger NTP time sync
      configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER_1, NTP_SERVER_2);
    }
  }
}

// ============================================================================
// HELPER: Initialize Firebase Client
// ============================================================================
void initFirebase() {
  Serial.println("[ INIT ] Initializing Firebase RTDB Client...");
  
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  
  if (USE_EMAIL_AUTH) {
    Serial.println("[ AUTH ] Using Email/Password Authentication...");
    auth.user.email = USER_EMAIL;
    auth.user.password = USER_PASSWORD;
  } else {
    // Anonymous Authentication
    Serial.println("[ AUTH ] Using Anonymous Authentication mode...");
    if (Firebase.signUp(&config, &auth, "", "")) {
      Serial.println("[ AUTH ] Anonymous Sign-Up Successful.");
    } else {
      Serial.print("[ AUTH ] Sign-Up notice: ");
      Serial.println(config.signer.signupError.message.c_str());
    }
  }
  
  // Assign token status callback
  config.token_status_callback = tokenStatusCallback;
  
  // Enable auto-reconnect on socket drops
  Firebase.reconnectWiFi(true);
  fbdo.setResponseSize(1024);
  
  Firebase.begin(&config, &auth);
  Serial.println("[ OK ] Firebase Client Configured.");
}

// ============================================================================
// ARDUINO SETUP
// ============================================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  
  Serial.println();
  Serial.println("==================================================");
  Serial.println("         DHTPulse — IoT Firmware v1.0             ");
  Serial.println("  Real-Time ESP32 + DHT11 + Firebase RTDB         ");
  Serial.println("==================================================");
  
  // 1. Initialize DHT11 sensor
  dht.begin();
  Serial.println("[ INIT ] DHT11 Sensor Initialized on GPIO " + String(DHTPIN));
  
  // 2. Initialize Wi-Fi
  initWiFi();
  
  // 3. Initialize SNTP for accurate millisecond timestamps
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER_1, NTP_SERVER_2);
  Serial.println("[ INIT ] NTP Time Client Configured.");
  
  // 4. Initialize Firebase Client
  initFirebase();
}

// ============================================================================
// ARDUINO MAIN LOOP
// ============================================================================
void loop() {
  // 1. Non-blocking Wi-Fi health check
  monitorWiFiConnection();
  
  // Check if Firebase is ready and authenticated
  bool isFirebaseReady = Firebase.ready();
  
  // 2. Non-blocking upload scheduler (Every 2 seconds)
  unsigned long currentMillis = millis();
  if (currentMillis - lastUploadTime >= UPLOAD_INTERVAL_MS) {
    lastUploadTime = currentMillis;
    
    // Print banner header
    Serial.println();
    Serial.println("================================");
    Serial.println("          DHTPulse DEVICE       ");
    Serial.println("================================");
    
    // Print Connection Statuses
    bool wifiConnected = (WiFi.status() == WL_CONNECTED);
    Serial.print("WiFi Status: ");
    Serial.println(wifiConnected ? "CONNECTED" : "DISCONNECTED");
    
    Serial.print("Firebase Status: ");
    Serial.println(isFirebaseReady ? "CONNECTED" : "CONNECTING / WAITING");
    Serial.println();
    
    // Read sensor values
    float humidity = dht.readHumidity();
    float temperature = dht.readTemperature(); // Celsius
    
    // Sensor validation: check for NaN and physical range limits
    if (isnan(humidity) || isnan(temperature) || humidity < 0.0 || humidity > 100.0 || temperature < -40.0 || temperature > 80.0) {
      Serial.println("[ ERROR ] SENSOR READ FAILED");
      Serial.println("Reason: Invalid reading from DHT11 on GPIO " + String(DHTPIN));
      Serial.println("================================");
      return;
    }
    
    // Print sensor readings
    Serial.print("Temperature: ");
    Serial.print(temperature, 1);
    Serial.println(" C");
    
    Serial.print("Humidity: ");
    Serial.print(humidity, 0);
    Serial.println(" %");
    Serial.println();
    
    // Verify Network & Firebase before uploading
    if (!wifiConnected) {
      Serial.println("[ FAILED ] FIREBASE UPLOAD FAILED");
      Serial.println("Reason: Wi-Fi connection unavailable");
      Serial.println();
      Serial.println("Retrying...");
      Serial.println("================================");
      return;
    }
    
    if (!isFirebaseReady) {
      Serial.println("[ FAILED ] FIREBASE UPLOAD FAILED");
      Serial.println("Reason: Firebase authentication/handshake in progress");
      Serial.println();
      Serial.println("Retrying...");
      Serial.println("================================");
      return;
    }
    
    Serial.println("Uploading to Firebase...");
    
    // Obtain high-resolution epoch timestamp (ms)
    unsigned long long timestampMs = getEpochTimestampMs();
    
    // Base RTDB path for this device
    String basePath = "/DHTPulse/" + String(DEVICE_ID);
    String latestPath = basePath + "/latest";
    String historyPath = basePath + "/history/" + String(timestampMs);
    
    // Construct JSON payload for `latest` reading
    FirebaseJson jsonLatest;
    jsonLatest.set("temperature", temperature);
    jsonLatest.set("humidity", humidity);
    jsonLatest.set("timestamp", (double)timestampMs);
    jsonLatest.set("status", "online");
    
    // Construct JSON payload for `history` entry
    FirebaseJson jsonHistory;
    jsonHistory.set("temperature", temperature);
    jsonHistory.set("humidity", humidity);
    jsonHistory.set("timestamp", (double)timestampMs);
    
    // Execute uploads
    bool uploadSuccess = false;
    
    // 1. Update latest node
    if (Firebase.RTDB.setJSON(&fbdo, latestPath.c_str(), &jsonLatest)) {
      // 2. Append history record (unique timestamp key prevents overwriting past data)
      if (Firebase.RTDB.setJSON(&fbdo, historyPath.c_str(), &jsonHistory)) {
        uploadSuccess = true;
      } else {
        Serial.print("[ WARN ] History append notice: ");
        Serial.println(fbdo.errorReason());
        // If latest succeeded, we still consider core telemetry received
        uploadSuccess = true;
      }
    }
    
    if (uploadSuccess) {
      Serial.println("[ SUCCESS ] DATA SENT");
      Serial.println("[ SUCCESS ] FIREBASE RECEIVED");
      Serial.println();
      Serial.println("Next upload in 2 seconds...");
      Serial.println("================================");
    } else {
      Serial.println("[ FAILED ] FIREBASE UPLOAD FAILED");
      Serial.print("Reason: ");
      Serial.println(fbdo.errorReason());
      Serial.println();
      Serial.println("Retrying...");
      Serial.println("================================");
    }
  }
}

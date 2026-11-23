/**
 * ============================================================================
 * Project: ThermoTrace — Industrial Thermal & Optical Monitoring
 * Target:  ESP32 DevKit / ESP32-WROOM-32
 * Sensors:
 *   1. MLX90614  - Non-Contact Infrared Pyrometer (Object & Ambient Temp)
 *   2. BPW34     - Silicon PIN Photodiode (Incident Optical Radiation)
 *   3. DHT11     - Environmental Reference (Ambient Temp & Relative Humidity)
 * Purpose: Continuous non-contact thermal monitoring for foundry converters,
 *          machinery heat trend analysis, and refractory degradation detection.
 * ============================================================================
 * 
 * HARDWARE WIRING:
 * ----------------------------------------------------------------------------
 * 1. MLX90614 Infrared Sensor (I2C Bus):
 *    - VIN  -> 3.3V (or 5V if module has 5V onboard regulator)
 *    - GND  -> GND
 *    - SCL  -> GPIO 22 (ESP32 Hardware I2C Clock)
 *    - SDA  -> GPIO 21 (ESP32 Hardware I2C Data)
 * 
 * 2. BPW34 Photodiode (Photoconductive Circuit):
 *    - Anode (Positive / longer pin) -> 3.3V
 *    - Cathode (Negative / marked notch) -> Connected to:
 *        a) 100 kΩ resistor to GND (Pull-down)
 *        b) ESP32 Analog Pin GPIO 34 (ADC1 Channel - safe with Wi-Fi!)
 *    [IMPORTANT NOTE ON ESP32 ADC]:
 *    Always use ADC1 pins (GPIO 32, 33, 34, 35, 36, 39) for analog sensing.
 *    ADC2 pins (GPIO 25, 26, 27) cannot be read while Wi-Fi is transmitting!
 * 
 * 3. DHT11 Environmental Reference Sensor:
 *    - VCC  -> 3.3V
 *    - GND  -> GND
 *    - DATA -> GPIO 4
 * ============================================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <time.h>
#include <Adafruit_MLX90614.h>
#include <DHT.h>
#include <Firebase_ESP_Client.h>

#include <addons/TokenHelper.h>
#include <addons/RTDBHelper.h>

// ============================================================================
// 1. PIN & HARDWARE CONFIGURATION
// ============================================================================
// I2C for MLX90614
#define I2C_SDA_PIN   21
#define I2C_SCL_PIN   22

// BPW34 Photodiode Analog Input (ADC1)
#define BPW34_PIN     34

// DHT11 Pin
#define DHTPIN        4
#define DHTTYPE       DHT11

// Hardware Instances
Adafruit_MLX90614 mlx = Adafruit_MLX90614();
DHT dht(DHTPIN, DHTTYPE);

// ============================================================================
// 2. WI-FI & FIREBASE CREDENTIALS
// ============================================================================
#define WIFI_SSID     "Oppo A77s"
#define WIFI_PASSWORD "9080061674"

#define API_KEY       "AIzaSyDlFs_h1Lg1MqrioOw40r00nz_Le6oFCPg"
#define DATABASE_URL  "https://dhtpulse-lab-default-rtdb.asia-southeast1.firebasedatabase.app"

// Device Identifier in Firebase Realtime Database
const char* DEVICE_ID = "converter_01";

// Non-blocking timings
const unsigned long SAMPLE_INTERVAL_MS = 2000;      // 2 seconds sample interval
const unsigned long WIFI_RETRY_INTERVAL_MS = 5000;   // 5 seconds Wi-Fi retry
unsigned long lastSampleTime = 0;
unsigned long lastWifiRetryTime = 0;
bool wifiWasConnected = false;
bool mlxInitialized = false;

// NTP Server Configuration for UTC Timestamps
const char* NTP_SERVER_1 = "pool.ntp.org";
const char* NTP_SERVER_2 = "time.nist.gov";

// Firebase objects
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

// ============================================================================
// HELPER: Accurate UTC Millisecond Timestamp via SNTP
// ============================================================================
unsigned long long getEpochTimestampMs() {
  struct timeval tv;
  if (gettimeofday(&tv, NULL) == 0 && tv.tv_sec > 1672531199) {
    return ((unsigned long long)tv.tv_sec * 1000ULL) + ((unsigned long long)tv.tv_usec / 1000ULL);
  }
  return (unsigned long long)millis();
}

// ============================================================================
// HELPER: Classify Thermal Hazard State
// ============================================================================
String classifyThermalAlert(float objTemp, float deltaTemp) {
  if (objTemp >= 500.0 || deltaTemp >= 400.0) {
    return "CRITICAL";
  } else if (objTemp >= 300.0 || deltaTemp >= 200.0) {
    return "WARNING";
  } else if (objTemp >= 120.0 || deltaTemp >= 80.0) {
    return "ELEVATED";
  }
  return "NORMAL";
}

// ============================================================================
// HELPER: Initialize Wi-Fi
// ============================================================================
void initWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  
  Serial.println("[ INIT ] Connecting to Wi-Fi: " + String(WIFI_SSID));
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 10000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  
  if (WiFi.status() == WL_CONNECTED) {
    wifiWasConnected = true;
    Serial.println("[ OK ] Wi-Fi Connected! IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("[ WARN ] Wi-Fi connection timed out. Retrying in background.");
  }
}

void monitorWiFiConnection() {
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiWasConnected) {
      Serial.println("\n[ WARN ] Wi-Fi connection lost! Auto-reconnecting...");
      wifiWasConnected = false;
    }
    if (millis() - lastWifiRetryTime >= WIFI_RETRY_INTERVAL_MS) {
      lastWifiRetryTime = millis();
      WiFi.reconnect();
    }
  } else {
    if (!wifiWasConnected) {
      Serial.println("\n[ OK ] Wi-Fi Restored! IP: " + WiFi.localIP().toString());
      wifiWasConnected = true;
      configTime(0, 0, NTP_SERVER_1, NTP_SERVER_2);
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
  
  // Anonymous Sign-Up (Token generation)
  Serial.println("[ AUTH ] Requesting Anonymous Auth Token...");
  if (Firebase.signUp(&config, &auth, "", "")) {
    Serial.println("[ OK ] Anonymous Authentication Ready.");
  } else {
    Serial.print("[ WARN ] Auth notice: ");
    Serial.println(config.signer.signupError.message.c_str());
  }
  
  config.token_status_callback = tokenStatusCallback;
  Firebase.reconnectWiFi(true);
  fbdo.setResponseSize(2048);
  
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
  Serial.println("        ThermoTrace — IoT Firmware v2.0           ");
  Serial.println("  Non-Contact Foundry Converter Thermal Monitor   ");
  Serial.println("  MLX90614 (IR) + BPW34 (Optic) + DHT11 (Ambient) ");
  Serial.println("==================================================");
  
  // 1. Initialize I2C Bus & MLX90614
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  if (mlx.begin()) {
    mlxInitialized = true;
    Serial.println("[ OK ] MLX90614 Infrared Pyrometer Initialized on I2C.");
  } else {
    Serial.println("[ WARN ] MLX90614 not detected on I2C bus! Check wiring (SDA=21, SCL=22).");
  }
  
  // 2. Configure BPW34 Photodiode Analog Input (ADC1)
  pinMode(BPW34_PIN, INPUT);
  analogReadResolution(12); // 12-bit ADC (0 - 4095)
  Serial.println("[ OK ] BPW34 Photodiode Configured on Analog GPIO " + String(BPW34_PIN));
  
  // 3. Initialize DHT11 Reference Sensor
  dht.begin();
  Serial.println("[ OK ] DHT11 Environmental Reference Sensor Initialized on GPIO " + String(DHTPIN));
  
  // 4. Initialize Wi-Fi
  initWiFi();
  
  // 5. Initialize SNTP for UTC Time
  configTime(0, 0, NTP_SERVER_1, NTP_SERVER_2);
  Serial.println("[ OK ] SNTP Real-Time Clock Configured.");
  
  // 6. Initialize Firebase
  initFirebase();
}

// ============================================================================
// MAIN LOOP
// ============================================================================
void loop() {
  monitorWiFiConnection();
  
  bool isFirebaseReady = Firebase.ready();
  unsigned long currentMillis = millis();
  
  if (currentMillis - lastSampleTime >= SAMPLE_INTERVAL_MS) {
    lastSampleTime = currentMillis;
    
    Serial.println();
    Serial.println("==================================================");
    Serial.println("             ThermoTrace TELEMETRY                ");
    Serial.println("==================================================");
    
    bool wifiConnected = (WiFi.status() == WL_CONNECTED);
    Serial.println("WiFi: " + String(wifiConnected ? "CONNECTED" : "DISCONNECTED") + 
                   " | Firebase: " + String(isFirebaseReady ? "CONNECTED" : "WAITING"));
    
    // --- 1. Read MLX90614 Infrared Sensor ---
    float machineryTemp = 0.0;
    float mlxAmbientTemp = 0.0;
    bool mlxValid = false;
    
    if (mlxInitialized) {
      machineryTemp = mlx.readObjectTempC();
      mlxAmbientTemp = mlx.readAmbientTempC();
      if (!isnan(machineryTemp) && !isnan(mlxAmbientTemp) && machineryTemp > -70.0 && machineryTemp < 1050.0) {
        mlxValid = true;
      }
    } else {
      // Re-attempt I2C detection if previously disconnected
      if (mlx.begin()) {
        mlxInitialized = true;
      }
    }
    
    // Fallback if sensor disconnected during demo testing
    if (!mlxValid) {
      machineryTemp = 0.0;
      mlxAmbientTemp = 0.0;
      Serial.println("[ WARN ] MLX90614 Read Failed. Check physical wiring.");
    }
    
    // --- 2. Read BPW34 Photodiode (ADC1) ---
    int rawOpticalAdc = analogRead(BPW34_PIN);
    float opticalVoltage = (rawOpticalAdc / 4095.0) * 3.3;
    // Optical radiation intensity index (0 - 1000 arbitrary optical flux unit)
    float opticalRadiation = (rawOpticalAdc / 4095.0) * 1000.0;
    
    // --- 3. Read DHT11 Environmental Reference Sensor ---
    float envHumidity = dht.readHumidity();
    float envTemp = dht.readTemperature();
    
    if (isnan(envHumidity) || isnan(envTemp)) {
      envHumidity = 0.0;
      envTemp = mlxValid ? mlxAmbientTemp : 25.0; // Graceful fallback
      Serial.println("[ WARN ] DHT11 Read Notice: Using reference fallback.");
    }
    
    // --- 4. Compute Thermal Differential & Refractory State ---
    float referenceAmbient = (envTemp > 0.0) ? envTemp : mlxAmbientTemp;
    float deltaTemp = machineryTemp - referenceAmbient;
    if (deltaTemp < 0.0) deltaTemp = 0.0;
    
    String alertLevel = classifyThermalAlert(machineryTemp, deltaTemp);
    
    // Serial Monitor Output
    Serial.print("Machinery Surface Temp (MLX): ");
    Serial.print(machineryTemp, 1);
    Serial.println(" °C");
    
    Serial.print("Ambient Temperature:          ");
    Serial.print(referenceAmbient, 1);
    Serial.println(" °C");
    
    Serial.print("Thermal Differential (ΔT):     ");
    Serial.print(deltaTemp, 1);
    Serial.println(" °C");
    
    Serial.print("Environmental Humidity (DHT): ");
    Serial.print(envHumidity, 0);
    Serial.println(" %");
    
    Serial.print("Optical Radiation (BPW34):    ");
    Serial.print(opticalVoltage, 2);
    Serial.print(" V (Index: ");
    Serial.print(opticalRadiation, 0);
    Serial.println(")");
    
    Serial.print("Converter Thermal Status:     [ ");
    Serial.print(alertLevel);
    Serial.println(" ]");
    Serial.println();
    
    // Check network readiness
    if (!wifiConnected || !isFirebaseReady) {
      Serial.println("[ FAILED ] Cannot upload: Network / Firebase handshake in progress.");
      return;
    }
    
    Serial.println("Uploading telemetry to Firebase...");
    unsigned long long timestampMs = getEpochTimestampMs();
    
    // Node paths
    String basePath = "/ThermoTrace/" + String(DEVICE_ID);
    String latestPath = basePath + "/latest";
    String historyPath = basePath + "/history/" + String(timestampMs);
    
    // Build JSON for Latest Node
    FirebaseJson jsonLatest;
    jsonLatest.set("machineryTemp", machineryTemp);
    jsonLatest.set("ambientTemp", referenceAmbient);
    jsonLatest.set("envHumidity", envHumidity);
    jsonLatest.set("opticalRadiation", opticalRadiation);
    jsonLatest.set("opticalVoltage", opticalVoltage);
    jsonLatest.set("deltaTemp", deltaTemp);
    jsonLatest.set("alertLevel", alertLevel);
    jsonLatest.set("timestamp", (double)timestampMs);
    jsonLatest.set("status", "online");
    
    // Also mirror to legacy keys for compatibility
    jsonLatest.set("temperature", machineryTemp);
    jsonLatest.set("humidity", envHumidity);
    
    // Build JSON for History Node
    FirebaseJson jsonHistory;
    jsonHistory.set("machineryTemp", machineryTemp);
    jsonHistory.set("ambientTemp", referenceAmbient);
    jsonHistory.set("envHumidity", envHumidity);
    jsonHistory.set("opticalRadiation", opticalRadiation);
    jsonHistory.set("opticalVoltage", opticalVoltage);
    jsonHistory.set("deltaTemp", deltaTemp);
    jsonHistory.set("alertLevel", alertLevel);
    jsonHistory.set("timestamp", (double)timestampMs);
    
    // Execute Writes
    if (Firebase.RTDB.setJSON(&fbdo, latestPath.c_str(), &jsonLatest)) {
      if (Firebase.RTDB.setJSON(&fbdo, historyPath.c_str(), &jsonHistory)) {
        Serial.println("[ SUCCESS ] DATA SENT & STORED IN CLOUD HISTORICAL LEDGER");
      } else {
        Serial.println("[ SUCCESS ] Latest updated, history notice: " + fbdo.errorReason());
      }
      Serial.println("Next upload in 2 seconds...");
      Serial.println("==================================================");
    } else {
      Serial.println("[ FAILED ] FIREBASE UPLOAD FAILED");
      Serial.println("Reason: " + fbdo.errorReason());
    }
  }
}

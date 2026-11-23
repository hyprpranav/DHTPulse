/**
 * ============================================================================
 * ThermoTrace — Hardware Sensor Diagnostic & Verification Tool
 * Target: ESP32 Dev Module
 * Purpose: Tests MLX90614, BPW34, and DHT11 without Wi-Fi/Cloud dependencies.
 * ============================================================================
 * 
 * PINOUT:
 *   - MLX90614:  VIN -> 3.3V, GND -> GND, SDA -> GPIO 21, SCL -> GPIO 22
 *   - BPW34:     Anode (+) -> 3.3V, Cathode (-) -> GPIO 34 + 100k pull-down to GND
 *   - DHT11:     VCC -> 3.3V, GND -> GND, DATA -> GPIO 4
 * ============================================================================
 */

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_MLX90614.h>
#include <DHT.h>

#define I2C_SDA_PIN   21
#define I2C_SCL_PIN   22
#define BPW34_PIN     34
#define DHTPIN        4
#define DHTTYPE       DHT11

Adafruit_MLX90614 mlx = Adafruit_MLX90614();
DHT dht(DHTPIN, DHTTYPE);

bool mlxReady = false;

void scanI2C() {
  Serial.println("[ I2C ] Scanning I2C bus for devices...");
  byte count = 0;
  for (byte i = 1; i < 127; i++) {
    Wire.beginTransmission(i);
    if (Wire.endTransmission() == 0) {
      Serial.print("[ I2C ] Device found at address 0x");
      if (i < 16) Serial.print("0");
      Serial.print(i, HEX);
      if (i == 0x5A) Serial.print(" (MLX90614 Factory Default Address!)");
      Serial.println();
      count++;
    }
  }
  if (count == 0) {
    Serial.println("[ I2C ] No I2C devices found! Check MLX90614 SDA=21, SCL=22, VIN=3.3V, GND=GND.");
  }
}

void setup() {
  Serial.begin(115200);
  delay(1500);

  Serial.println();
  Serial.println("==================================================");
  Serial.println("      ThermoTrace — SENSOR DIAGNOSTIC TEST        ");
  Serial.println("==================================================");

  // 1. Initialize I2C and scan
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  scanI2C();

  if (mlx.begin()) {
    mlxReady = true;
    Serial.println("[ OK ] MLX90614 Pyrometer Ready!");
  } else {
    Serial.println("[ FAIL ] MLX90614 Init Failed. Check wiring!");
  }

  // 2. Configure BPW34 Photodiode
  pinMode(BPW34_PIN, INPUT);
  analogReadResolution(12);
  Serial.println("[ OK ] BPW34 Photodiode Ready on GPIO 34");

  // 3. Initialize DHT11
  dht.begin();
  Serial.println("[ OK ] DHT11 Initialized on GPIO 4");

  Serial.println("==================================================");
  Serial.println("Starting continuous live readings (every 1s)...");
  Serial.println();
}

void loop() {
  delay(1000);

  // --- Read MLX90614 ---
  float mlxObject = 0.0;
  float mlxAmbient = 0.0;
  if (mlxReady) {
    mlxObject = mlx.readObjectTempC();
    mlxAmbient = mlx.readAmbientTempC();
  } else {
    // Attempt re-init if hot-plugged
    if (mlx.begin()) mlxReady = true;
  }

  // --- Read BPW34 Photodiode ---
  int rawADC = analogRead(BPW34_PIN);
  float voltage = (rawADC / 4095.0) * 3.3;
  int fluxIndex = (rawADC * 1000) / 4095;

  // --- Read DHT11 ---
  float dhtHumidity = dht.readHumidity();
  float dhtTemp = dht.readTemperature();

  // Print Formatted Output
  Serial.println("--------------------------------------------------");
  if (mlxReady && !isnan(mlxObject)) {
    Serial.print("1. MLX90614 Machinery Temp:  ");
    Serial.print(mlxObject, 1);
    Serial.print(" °C  (Sensor Ambient: ");
    Serial.print(mlxAmbient, 1);
    Serial.println(" °C)");
  } else {
    Serial.println("1. MLX90614 Machinery Temp:  [ SENSOR NOT DETECTED ]");
  }

  Serial.print("2. BPW34 Optical Radiation:  ");
  Serial.print(voltage, 2);
  Serial.print(" V  (Raw ADC: ");
  Serial.print(rawADC);
  Serial.print(" / 4095, Flux Index: ");
  Serial.print(fluxIndex);
  Serial.println(")");

  if (!isnan(dhtTemp) && !isnan(dhtHumidity)) {
    Serial.print("3. DHT11 Ambient Ref:        ");
    Serial.print(dhtTemp, 1);
    Serial.print(" °C | Humidity: ");
    Serial.print(dhtHumidity, 0);
    Serial.println(" %");
  } else {
    Serial.println("3. DHT11 Ambient Ref:        [ SENSOR READ ERROR - Check GPIO 4 ]");
  }
}

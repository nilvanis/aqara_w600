// Standalone Aqara WT-A03E / W600 advanced external converter.

const {Zcl} = require("zigbee-herdsman");
const tz = require("zigbee-herdsman-converters/converters/toZigbee");
const exposes = require("zigbee-herdsman-converters/lib/exposes");
const lumi = require("zigbee-herdsman-converters/lib/lumi");
const m = require("zigbee-herdsman-converters/lib/modernExtend");
const globalStore = require("zigbee-herdsman-converters/lib/store");
const {logger} = require("zigbee-herdsman-converters/lib/logger");

const NS = "zhc:aqara_w600";

const manufacturerCode = lumi.manufacturerCode;

const CLUSTER_LUMI = "manuSpecificLumi";
const CLUSTER_THERMOSTAT = "hvacThermostat";

const ATTR_SYSTEM_MODE = 0x0271;
const ATTR_WINDOW_DETECTION = 0x0273;
const ATTR_ABNORMAL_NOTIFICATION = 0x0274;
const ATTR_CHILD_LOCK = 0x0277;
const ATTR_ANTI_FREEZE = 0x0279;
const ATTR_CALIBRATE = 0x0270;
const ATTR_CALIBRATED = 0x027b;
const ATTR_SCHEDULE = 0x027d;
const ATTR_SENSOR_SOURCE = 0x0280;
const ATTR_SENSOR_BINDING = 0xfff2;
const ATTR_PRESET = 0x0311;
const ATTR_PRESET_TEMPERATURE_TABLE = 0x0317;
const ATTR_TEMP_SETPOINT_HOLD_DURATION = 0x0024;
const ATTR_DISPLAY_FLIP = 0x0330;
const ATTR_POSITION = 0x0360;
const ATTR_HEARTBEAT = 0x00f7;

const PRESET_TABLE_STORE_KEY = "w600PresetTemperatureTable";
const MANUAL_CUSTOM_PRESET_STORE_KEY = "w600ManualCustomPreset";
const EXTERNAL_SENSOR_IEEE_STORE_KEY = "w600ExternalSensorIeee";
const WINDOW_DETECTION_ENABLED_STORE_KEY = "w600WindowDetectionEnabled";
const WINDOW_SENSOR_IEEE_STORE_KEY = "w600WindowSensorIeee";
const WINDOW_SENSOR_MODE_STORE_KEY = "w600WindowSensorMode";
const WINDOW_SENSOR_STATE_STORE_KEY = "w600WindowSensorState";
const WINDOW_SENSOR_ARMING_IN_PROGRESS_STORE_KEY = "w600WindowSensorArmingInProgress";
const WINDOW_SENSOR_ARMING_PROGRESS_SIGNAL_COUNTER_STORE_KEY = "w600WindowSensorArmingProgressSignalCounter";
const WINDOW_SENSOR_ACTIVATION_COMPLETE_SIGNAL_COUNTER_STORE_KEY = "w600WindowSensorActivationCompleteSignalCounter";
const WEEKLY_SCHEDULE_DRAFT_STORE_KEY = "w600WeeklyScheduleDraft";
const WEEKLY_SCHEDULE_OTA_STAGE_STORE_KEY = "w600WeeklyScheduleOtaStage";
const WEEKLY_SCHEDULE_UPLOAD_STATE_STORE_KEY = "w600WeeklyScheduleUploadState";
const SENSOR_BINDING_COUNTER_STORE_KEY = "w600SensorBindingCounter";
const SENSOR_BINDING_REFRESH_PENDING_STORE_KEY = "w600SensorBindingRefreshPending";
const SENSOR_BINDING_REFRESH_LAST_ATTEMPT_AT_STORE_KEY = "w600SensorBindingRefreshLastAttemptAt";

const W600_WINDOW_SENSOR_OPEN_RETRY_DELAY_MS = 900;
const W600_WINDOW_SENSOR_OPEN_RETRY_JITTER_MS = 250;
const W600_WINDOW_SENSOR_TRANSITION_JITTER_MS = 150;
const W600_WINDOW_SENSOR_STEADY_AVAILABILITY_INTERVAL_MS = 180000;
const W600_WINDOW_SENSOR_STEADY_STATE_INTERVAL_MS = 600000;
const W600_WINDOW_SENSOR_STEADY_JITTER_MS = 10000;
const W600_WINDOW_SENSOR_SETUP_WRITE_SPACING_MS = 20;
const W600_WINDOW_SENSOR_SETUP_PRE_METADATA_DELAY_MS = 1000;
const W600_WINDOW_SENSOR_SETUP_CONFIRMATION_TIMEOUT_MS = 1000;
const W600_WINDOW_SENSOR_SETUP_CONFIRMATION_POLL_MS = 50;
const W600_SENSOR_BINDING_REFRESH_DELAY_MS = 4000;
const W600_SENSOR_BINDING_REFRESH_COOLDOWN_MS = 60000;

const WINDOW_SENSOR_STATE_KEEPALIVE_TIMERS = new Map();
const WEEKLY_SCHEDULE_UPLOAD_TIMEOUTS = new Map();

const PRESET_BY_ID = {
    1: "home",
    2: "away",
    3: "sleep",
    5: "vacation",
    6: "wind_down",
    255: "none",
};

const PRESET_ID_BY_NAME = {
    home: 1,
    away: 2,
    sleep: 3,
    vacation: 5,
    wind_down: 6,
};

const PRESET_ORDER = ["home", "away", "sleep", "vacation", "wind_down"];

const PRESET_TEMPERATURE_DEFINITIONS = [
    {preset: "home", property: "preset_home_temperature", label: "Home temperature", description: "Home preset temperature"},
    {preset: "away", property: "preset_away_temperature", label: "Away temperature", description: "Away preset temperature"},
    {preset: "sleep", property: "preset_sleep_temperature", label: "Sleep temperature", description: "Sleep preset temperature"},
    {preset: "vacation", property: "preset_vacation_temperature", label: "Vacation temperature", description: "Vacation preset temperature"},
    {preset: "wind_down", property: "preset_wind_down_temperature", label: "Wind-down temperature", description: "Wind-down preset temperature"},
];

const PRESET_NAME_BY_PROPERTY = Object.fromEntries(PRESET_TEMPERATURE_DEFINITIONS.map((definition) => [definition.property, definition.preset]));
const PROPERTY_BY_PRESET_NAME = Object.fromEntries(PRESET_TEMPERATURE_DEFINITIONS.map((definition) => [definition.preset, definition.property]));

const SENSOR_SOURCE_BY_VALUE = {
    0: "internal",
    1: "external",
};

const WINDOW_DETECTION_MODE_BY_VALUE = {
    temperature_difference: 0,
    external_sensor: 1,
};

function normalizeEnumKey(value) {
    return typeof value === "string"
        ? value
              .trim()
              .toLowerCase()
              .replace(/[\s-]+/g, "_")
        : undefined;
}

function parseEnumName(value, lookup, key) {
    const normalized = normalizeEnumKey(value);

    if (normalized != null && Object.hasOwn(lookup, normalized)) {
        return normalized;
    }

    throw new Error(`${key} must be one of: ${Object.keys(lookup).join(", ")}`);
}

function parseHalfDegreeTemperature(value, key, min, max) {
    const numeric = Number(value);

    if (!Number.isFinite(numeric)) {
        throw new Error(`${key} must be a number`);
    }

    if (numeric < min || numeric > max) {
        throw new Error(`${key} must be between ${min} and ${max}`);
    }

    const scaled = Math.round(numeric * 100);

    if (scaled % 50 !== 0) {
        throw new Error(`${key} must use 0.5 C steps`);
    }

    return scaled;
}

function parseExternalTemperatureInput(value, key) {
    const numeric = Number(value);

    if (!Number.isFinite(numeric)) {
        throw new Error(`${key} must be a number`);
    }

    if (numeric < -40 || numeric > 125) {
        throw new Error(`${key} must be between -40 and 125`);
    }

    return Math.round(numeric * 100);
}

function parseWindowSensorState(value, key) {
    if (value === true || value === 1) {
        return "open";
    }

    if (value === false || value === 0) {
        return "closed";
    }

    if (typeof value === "string") {
        const normalized = normalizeEnumKey(value);

        if (normalized === "open" || normalized === "opened") {
            return "open";
        }

        if (normalized === "closed" || normalized === "close") {
            return "closed";
        }
    }

    throw new Error(`${key} must be one of: open, closed`);
}

function getW600AqaraStyleZigbeeTime() {
    const oneJanuary2000 = new Date("January 01, 2000 00:00:00 UTC+00:00").getTime();
    const secondsUtc = Math.round((Date.now() - oneJanuary2000) / 1000);
    return secondsUtc - new Date().getTimezoneOffset() * 60;
}

function decodeW600AqaraStyleZigbeeTime(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
        return undefined;
    }

    const oneJanuary2000 = new Date("January 01, 2000 00:00:00 UTC+00:00").getTime();
    const date = new Date(oneJanuary2000 + seconds * 1000);
    const pad = (value) => value.toString().padStart(2, "0");

    return (
        `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
        `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
    );
}

function w600AqaraTimeResponse() {
    return {
        onEvent: [
            (event) => {
                if (event.type !== "start" || event.data.device.customReadResponse) {
                    return;
                }

                event.data.device.customReadResponse = (frame, endpoint) => {
                    if (!frame.isCluster("genTime")) {
                        return false;
                    }

                    const time = getW600AqaraStyleZigbeeTime();
                    const payload = {
                        time,
                        timeZone: 0,
                        dstShift: 0,
                    };

                    endpoint.readResponse("genTime", frame.header.transactionSequenceNumber, payload).catch((error) => {
                        logger.warning(`W600 custom Aqara-style time response failed for '${event.data.device.ieeeAddr}': ${error}`, NS);
                    });
                    return true;
                };
            },
        ],
        isModernExtend: true,
    };
}

function decodeW600Heartbeat(buffer) {
    if (!Buffer.isBuffer(buffer)) {
        return undefined;
    }

    const heartbeat = {};
    let offset = 0;

    while (offset + 2 <= buffer.length) {
        const key = buffer.readUInt8(offset);
        const type = buffer.readUInt8(offset + 1);
        offset += 2;

        switch (type) {
            case Zcl.DataType.BOOLEAN:
            case Zcl.DataType.UINT8:
            case Zcl.DataType.ENUM8:
            case Zcl.DataType.INT8:
                if (offset + 1 > buffer.length) {
                    return heartbeat;
                }

                heartbeat[key] = type === Zcl.DataType.INT8 ? buffer.readInt8(offset) : buffer.readUInt8(offset);
                offset += 1;
                break;
            case Zcl.DataType.UINT16:
            case Zcl.DataType.ENUM16:
                if (offset + 2 > buffer.length) {
                    return heartbeat;
                }

                heartbeat[key] = buffer.readUInt16LE(offset);
                offset += 2;
                break;
            case Zcl.DataType.INT16:
                if (offset + 2 > buffer.length) {
                    return heartbeat;
                }

                heartbeat[key] = buffer.readInt16LE(offset);
                offset += 2;
                break;
            case Zcl.DataType.UINT32:
                if (offset + 4 > buffer.length) {
                    return heartbeat;
                }

                heartbeat[key] = buffer.readUInt32LE(offset);
                offset += 4;
                break;
            case Zcl.DataType.OCTET_STR: {
                if (offset + 1 > buffer.length) {
                    return heartbeat;
                }

                const length = buffer.readUInt8(offset);
                offset += 1;

                if (offset + length > buffer.length) {
                    return heartbeat;
                }

                heartbeat[key] = buffer.subarray(offset, offset + length);
                offset += length;
                break;
            }
            default:
                logger.debug(`Unsupported W600 heartbeat type 0x${type.toString(16)} for sub-key 0x${key.toString(16)}`, NS);
                return heartbeat;
        }
    }

    return heartbeat;
}

function decodeW600Heartbeat9c(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
        return undefined;
    }

    const isEmptyPayload = buffer.subarray(0, 8).every((byte) => byte === 0x00);
    const lastErrorStatusUpdate = isEmptyPayload ? undefined : decodeW600AqaraStyleZigbeeTime(buffer.readUInt32LE(0));
    const errorStatusBytecode = buffer.subarray(4, 8).toString("hex");
    const windowOpenStatus = buffer[4];
    const windowOpen = windowOpenStatus === 0x00 ? false : windowOpenStatus === 0x0d || windowOpenStatus === 0x0e ? true : undefined;
    const valveAlarm =
        windowOpenStatus === 0x10 ? true : windowOpenStatus === 0x00 || windowOpenStatus === 0x0d || windowOpenStatus === 0x0e ? false : undefined;

    return {
        errorStatusBytecode,
        lastErrorStatusUpdate,
        valveAlarm,
        windowOpen,
    };
}

function normalizeIeeeAddress(value, key) {
    if (typeof value !== "string") {
        throw new Error(`${key} must be a string`);
    }

    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/^0x/, "")
        .replace(/[:\-\s]+/g, "");

    if (!/^[0-9a-f]{16}$/.test(normalized)) {
        throw new Error(`${key} must be a 64-bit IEEE address, for example 0x00158d0008301710`);
    }

    return `0x${normalized}`;
}

function ieeeAddressToBuffer(value, key) {
    return Buffer.from(normalizeIeeeAddress(value, key).slice(2), "hex");
}

function bufferToIeeeAddress(value) {
    if (!Buffer.isBuffer(value) || value.length !== 8) {
        throw new Error("Expected 8-byte IEEE address buffer");
    }

    return `0x${value.toString("hex")}`;
}

function getDeviceStoreKey(deviceOrEntity) {
    if (typeof deviceOrEntity === "string") {
        return deviceOrEntity;
    }

    if (deviceOrEntity?.ieeeAddr) {
        return deviceOrEntity.ieeeAddr;
    }

    if (deviceOrEntity?.deviceIeeeAddress) {
        return deviceOrEntity.deviceIeeeAddress;
    }

    throw new Error("Unable to derive device store key");
}

function getDeviceIeeeAddress(deviceOrEntity, meta) {
    const ieeeAddress = deviceOrEntity?.deviceIeeeAddress ?? deviceOrEntity?.ieeeAddr ?? meta?.device?.ieeeAddr;

    if (typeof ieeeAddress !== "string") {
        throw new Error("Unable to derive device IEEE address");
    }

    return normalizeIeeeAddress(ieeeAddress, "device_ieee");
}

function getCachedExternalSensorIeee(entity, meta) {
    const storeKey = getDeviceStoreKey(entity);
    const cached = globalStore.getValue(storeKey, EXTERNAL_SENSOR_IEEE_STORE_KEY);

    if (typeof cached === "string") {
        return normalizeIeeeAddress(cached, "external_sensor_ieee");
    }

    const stateValue = meta.state?.external_sensor_ieee;
    return typeof stateValue === "string" && stateValue.trim() !== "" ? normalizeIeeeAddress(stateValue, "external_sensor_ieee") : undefined;
}

function getCachedWindowSensorIeee(entity, meta) {
    const storeKey = getDeviceStoreKey(entity);
    const cached = globalStore.getValue(storeKey, WINDOW_SENSOR_IEEE_STORE_KEY);

    if (typeof cached === "string") {
        return normalizeIeeeAddress(cached, "window_sensor_ieee");
    }

    const stateValue = meta.state?.window_sensor_ieee;
    return typeof stateValue === "string" && stateValue.trim() !== "" ? normalizeIeeeAddress(stateValue, "window_sensor_ieee") : undefined;
}

function getCachedWindowDetectionMode(entity, meta) {
    const storeKey = getDeviceStoreKey(entity);
    const cached = globalStore.getValue(storeKey, WINDOW_SENSOR_MODE_STORE_KEY);

    if (typeof cached === "string") {
        return parseEnumName(cached, WINDOW_DETECTION_MODE_BY_VALUE, "window_detection_mode");
    }

    const stateValue = meta.state?.window_detection_mode;
    return typeof stateValue === "string" ? parseEnumName(stateValue, WINDOW_DETECTION_MODE_BY_VALUE, "window_detection_mode") : undefined;
}

function getCachedWindowDetectionEnabled(entity, meta) {
    const storeKey = getDeviceStoreKey(entity);
    const cached = parseW600BinaryEnabled(globalStore.getValue(storeKey, WINDOW_DETECTION_ENABLED_STORE_KEY));

    if (cached != null) {
        return cached;
    }

    return parseW600BinaryEnabled(meta.state?.window_detection);
}

function getCachedWindowSensorState(entity, meta) {
    const storeKey = getDeviceStoreKey(entity);
    const cached = globalStore.getValue(storeKey, WINDOW_SENSOR_STATE_STORE_KEY);

    if (typeof cached === "string") {
        if (cached.trim() !== "") {
            return parseWindowSensorState(cached, "window_sensor_state");
        }
    }

    const stateValue = meta.state?.window_sensor_state;

    if (typeof stateValue === "string" && stateValue.trim() !== "") {
        return parseWindowSensorState(stateValue, "window_sensor_state");
    }

    return "closed";
}

async function safeRead(endpoint, cluster, attributes, options = undefined) {
    try {
        await endpoint.read(cluster, attributes, options);
    } catch (error) {
        const ieeeAddress = endpoint.deviceIeeeAddress ?? endpoint.device?.ieeeAddr ?? "unknown";
        const details = error instanceof Error ? error.message : String(error);
        logger.debug(`Safe read failed for ${ieeeAddress} on ${cluster} [${attributes.join(", ")}]: ${details}`, NS);
    }
}

function scheduleW600SensorBindingRefresh(deviceOrEntity, reason, delayMs = W600_SENSOR_BINDING_REFRESH_DELAY_MS) {
    const device =
        typeof deviceOrEntity?.getEndpoint === "function"
            ? deviceOrEntity
            : typeof deviceOrEntity?.device?.getEndpoint === "function"
              ? deviceOrEntity.device
              : undefined;

    if (!device) {
        return false;
    }

    const deviceKey = getDeviceStoreKey(device);
    const pending = globalStore.getValue(deviceKey, SENSOR_BINDING_REFRESH_PENDING_STORE_KEY, false) === true;

    if (pending) {
        return false;
    }

    const lastAttemptAt = globalStore.getValue(deviceKey, SENSOR_BINDING_REFRESH_LAST_ATTEMPT_AT_STORE_KEY, 0);

    if (typeof lastAttemptAt === "number" && Date.now() - lastAttemptAt < W600_SENSOR_BINDING_REFRESH_COOLDOWN_MS) {
        return false;
    }

    globalStore.putValue(deviceKey, SENSOR_BINDING_REFRESH_PENDING_STORE_KEY, true);

    const delay = Math.max(100, delayMs);
    const endpoint = device.getEndpoint(1);

    setTimeout(() => {
        globalStore.putValue(deviceKey, SENSOR_BINDING_REFRESH_PENDING_STORE_KEY, false);
        globalStore.putValue(deviceKey, SENSOR_BINDING_REFRESH_LAST_ATTEMPT_AT_STORE_KEY, Date.now());
        logger.debug(`Refreshing sensor binding after ${reason}`, NS);
        void safeRead(endpoint, CLUSTER_LUMI, [ATTR_SENSOR_BINDING], {manufacturerCode});
    }, delay);

    return true;
}

function readLumiAttribute(entity, attribute) {
    return entity.read(CLUSTER_LUMI, [attribute], {manufacturerCode});
}

function writeLumiAttribute(entity, attribute, value, type = Zcl.DataType.UINT8, options = undefined) {
    return entity.write(
        CLUSTER_LUMI,
        {
            [attribute]: {value, type},
        },
        {...(options ?? {}), manufacturerCode},
    );
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeW600SensorBindingAttribute(entity, payload) {
    return writeLumiAttribute(entity, ATTR_SENSOR_BINDING, payload, Zcl.DataType.OCTET_STR, {disableDefaultResponse: false});
}

// Schedule the first setup writes as a tight burst so the TRV sees an Aqara-like
// early state-machine round instead of a slower, fully serialized sequence.
async function writeW600SensorBindingBurst(entity, payloads, spacingMs = W600_WINDOW_SENSOR_SETUP_WRITE_SPACING_MS) {
    const writes = [];

    for (let index = 0; index < payloads.length; index++) {
        writes.push(writeW600SensorBindingAttribute(entity, payloads[index]));

        if (spacingMs > 0 && index < payloads.length - 1) {
            await wait(spacingMs);
        }
    }

    await Promise.all(writes);
}

function getW600WindowSensorSignalCounter(deviceOrEntity, storeKey) {
    return globalStore.getValue(getDeviceStoreKey(deviceOrEntity), storeKey, 0);
}

function markW600WindowSensorSignal(deviceOrEntity, storeKey) {
    const deviceKey = getDeviceStoreKey(deviceOrEntity);
    const counter = getW600WindowSensorSignalCounter(deviceKey, storeKey);
    globalStore.putValue(deviceKey, storeKey, (counter + 1) & 0xffff);
}

async function waitForW600WindowSensorSignal(entity, storeKey, previousCounter, timeoutMs = W600_WINDOW_SENSOR_SETUP_CONFIRMATION_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (getW600WindowSensorSignalCounter(entity, storeKey) !== previousCounter) {
            return true;
        }

        await wait(W600_WINDOW_SENSOR_SETUP_CONFIRMATION_POLL_MS);
    }

    return getW600WindowSensorSignalCounter(entity, storeKey) !== previousCounter;
}

function getW600WindowSensorArmingProgressSignalCounter(deviceOrEntity) {
    return getW600WindowSensorSignalCounter(deviceOrEntity, WINDOW_SENSOR_ARMING_PROGRESS_SIGNAL_COUNTER_STORE_KEY);
}

function markW600WindowSensorArmingProgressSignal(deviceOrEntity) {
    markW600WindowSensorSignal(deviceOrEntity, WINDOW_SENSOR_ARMING_PROGRESS_SIGNAL_COUNTER_STORE_KEY);
}

function waitForW600WindowSensorArmingProgressSignal(entity, previousCounter, timeoutMs = W600_WINDOW_SENSOR_SETUP_CONFIRMATION_TIMEOUT_MS) {
    return waitForW600WindowSensorSignal(entity, WINDOW_SENSOR_ARMING_PROGRESS_SIGNAL_COUNTER_STORE_KEY, previousCounter, timeoutMs);
}

function getW600WindowSensorActivationCompleteSignalCounter(deviceOrEntity) {
    return getW600WindowSensorSignalCounter(deviceOrEntity, WINDOW_SENSOR_ACTIVATION_COMPLETE_SIGNAL_COUNTER_STORE_KEY);
}

function markW600WindowSensorActivationCompleteSignal(deviceOrEntity) {
    markW600WindowSensorSignal(deviceOrEntity, WINDOW_SENSOR_ACTIVATION_COMPLETE_SIGNAL_COUNTER_STORE_KEY);
}

function waitForW600WindowSensorActivationCompleteSignal(entity, previousCounter, timeoutMs = W600_WINDOW_SENSOR_SETUP_CONFIRMATION_TIMEOUT_MS) {
    return waitForW600WindowSensorSignal(entity, WINDOW_SENSOR_ACTIVATION_COMPLETE_SIGNAL_COUNTER_STORE_KEY, previousCounter, timeoutMs);
}

function isW600WindowSensorArmingInProgress(deviceOrEntity) {
    return globalStore.getValue(getDeviceStoreKey(deviceOrEntity), WINDOW_SENSOR_ARMING_IN_PROGRESS_STORE_KEY, false) === true;
}

function setW600WindowSensorArmingInProgress(deviceOrEntity, armingInProgress) {
    globalStore.putValue(getDeviceStoreKey(deviceOrEntity), WINDOW_SENSOR_ARMING_IN_PROGRESS_STORE_KEY, armingInProgress === true);
}

function cacheW600WindowSensorIeee(deviceOrEntity, sensorIeeeAddress) {
    globalStore.putValue(getDeviceStoreKey(deviceOrEntity), WINDOW_SENSOR_IEEE_STORE_KEY, sensorIeeeAddress);
}

function cacheW600WindowSensorMode(deviceOrEntity, windowDetectionMode) {
    globalStore.putValue(getDeviceStoreKey(deviceOrEntity), WINDOW_SENSOR_MODE_STORE_KEY, windowDetectionMode);
}

function cacheW600WindowSensorState(deviceOrEntity, windowSensorState) {
    globalStore.putValue(getDeviceStoreKey(deviceOrEntity), WINDOW_SENSOR_STATE_STORE_KEY, windowSensorState);
}

function cacheW600ObservedWindowSensor(deviceOrEntity, sensorIeeeAddress) {
    cacheW600WindowSensorIeee(deviceOrEntity, sensorIeeeAddress);
}

function cacheW600ExternalWindowSensor(deviceOrEntity, sensorIeeeAddress, windowSensorState = undefined) {
    cacheW600ObservedWindowSensor(deviceOrEntity, sensorIeeeAddress);

    if (windowSensorState != null) {
        cacheW600WindowSensorState(deviceOrEntity, windowSensorState);
    }

    cacheW600WindowSensorMode(deviceOrEntity, "external_sensor");
}

function applyW600ObservedWindowSensorState(result, sensorIeeeAddress) {
    result.window_sensor_ieee = sensorIeeeAddress;
}

function applyW600ExternalWindowSensorState(result, sensorIeeeAddress, windowSensorState = undefined) {
    result.window_detection_mode = "external_sensor";
    applyW600ObservedWindowSensorState(result, sensorIeeeAddress);

    if (windowSensorState != null) {
        result.window_sensor_state = windowSensorState;
    }
}

function getW600WindowSensorTimerJitterMs(deviceKey, phase, maxJitterMs) {
    if (maxJitterMs <= 0) {
        return 0;
    }

    const source = `${String(deviceKey)}:${String(phase)}`;
    let hash = 0;

    for (let index = 0; index < source.length; index++) {
        hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
    }

    return (hash % (maxJitterMs * 2 + 1)) - maxJitterMs;
}

function getW600WindowSensorTimerDelayMs(deviceKey, phase, baseDelayMs, maxJitterMs = 0) {
    return Math.max(100, baseDelayMs + getW600WindowSensorTimerJitterMs(deviceKey, phase, maxJitterMs));
}

function cancelW600WindowSensorStateKeepalive(deviceOrEntity) {
    const deviceKey = getDeviceStoreKey(deviceOrEntity);
    const timers = WINDOW_SENSOR_STATE_KEEPALIVE_TIMERS.get(deviceKey);

    if (!timers) {
        return;
    }

    for (const timeout of timers.timeouts) {
        clearTimeout(timeout);
    }

    for (const interval of timers.intervals) {
        clearInterval(interval);
    }

    WINDOW_SENSOR_STATE_KEEPALIVE_TIMERS.delete(deviceKey);
}

function startW600WindowSensorStateKeepalive(entity, sensorIeeeAddress, windowSensorState) {
    const deviceKey = getDeviceStoreKey(entity);
    cancelW600WindowSensorStateKeepalive(deviceKey);

    const sendPayload = (type) => {
        const payload =
            type === "availability"
                ? buildW600WindowSensorAvailabilityPayload(entity, sensorIeeeAddress)
                : buildW600WindowSensorStatePayload(entity, sensorIeeeAddress, type);

        void writeLumiAttribute(entity, ATTR_SENSOR_BINDING, payload, Zcl.DataType.OCTET_STR).catch((error) => {
            const current = WINDOW_SENSOR_STATE_KEEPALIVE_TIMERS.get(deviceKey);

            if (current !== timers) {
                return;
            }

            const details = error instanceof Error ? error.message : String(error);
            logger.debug(`Window ${windowSensorState} keepalive ${type} write failed for ${deviceKey}: ${details}`, NS);
        });
    };

    const timers = {
        timeouts: [],
        intervals: [],
    };

    const scheduleTimeout = (phase, type, baseDelayMs, maxJitterMs = 0) => {
        const timeout = setTimeout(
            () => {
                if (WINDOW_SENSOR_STATE_KEEPALIVE_TIMERS.get(deviceKey) !== timers) {
                    return;
                }

                sendPayload(type);
            },
            getW600WindowSensorTimerDelayMs(deviceKey, phase, baseDelayMs, maxJitterMs),
        );

        timers.timeouts.push(timeout);
    };

    const scheduleInterval = (phase, type, baseDelayMs) => {
        const interval = setInterval(
            () => {
                if (WINDOW_SENSOR_STATE_KEEPALIVE_TIMERS.get(deviceKey) !== timers) {
                    return;
                }

                sendPayload(type);
            },
            getW600WindowSensorTimerDelayMs(deviceKey, phase, baseDelayMs, W600_WINDOW_SENSOR_STEADY_JITTER_MS),
        );

        timers.intervals.push(interval);
    };

    if (windowSensorState === "closed") {
        scheduleTimeout("closed_bootstrap_availability_1", "availability", 1000, W600_WINDOW_SENSOR_TRANSITION_JITTER_MS);
        scheduleTimeout("closed_bootstrap_state_1", "closed", 2000, W600_WINDOW_SENSOR_TRANSITION_JITTER_MS);
        scheduleTimeout("closed_bootstrap_availability_2", "availability", 3000, W600_WINDOW_SENSOR_TRANSITION_JITTER_MS);
        scheduleTimeout("closed_bootstrap_state_2", "closed", 4000, W600_WINDOW_SENSOR_TRANSITION_JITTER_MS);
        scheduleTimeout("closed_bootstrap_availability_3", "availability", 5000, W600_WINDOW_SENSOR_TRANSITION_JITTER_MS);
        scheduleTimeout("closed_tail_availability_1", "availability", 15000, W600_WINDOW_SENSOR_TRANSITION_JITTER_MS);
        scheduleTimeout("closed_tail_availability_2", "availability", 30000, W600_WINDOW_SENSOR_TRANSITION_JITTER_MS);
        scheduleTimeout("closed_tail_state", "closed", 45000, W600_WINDOW_SENSOR_TRANSITION_JITTER_MS);
    } else if (windowSensorState === "open") {
        scheduleTimeout("open_retry", "open", W600_WINDOW_SENSOR_OPEN_RETRY_DELAY_MS, W600_WINDOW_SENSOR_OPEN_RETRY_JITTER_MS);
    } else {
        return;
    }

    scheduleInterval(`${windowSensorState}_steady_availability`, "availability", W600_WINDOW_SENSOR_STEADY_AVAILABILITY_INTERVAL_MS);
    scheduleInterval(`${windowSensorState}_steady_state`, windowSensorState, W600_WINDOW_SENSOR_STEADY_STATE_INTERVAL_MS);

    WINDOW_SENSOR_STATE_KEEPALIVE_TIMERS.set(deviceKey, timers);
}

async function writeW600WindowSensorStateUpdate(entity, sensorIeeeAddress, windowSensorState, options = {}) {
    const includeAvailability = options.includeAvailability === true;
    const stateWriteCount = options.stateWriteCount ?? 1;
    const restartStateKeepalive = options.restartStateKeepalive === true;

    cancelW600WindowSensorStateKeepalive(entity);

    const payloads = [];

    if (includeAvailability) {
        payloads.push(buildW600WindowSensorAvailabilityPayload(entity, sensorIeeeAddress));
    }

    for (let index = 0; index < stateWriteCount; index++) {
        payloads.push(buildW600WindowSensorStatePayload(entity, sensorIeeeAddress, windowSensorState));
    }

    await writeW600SensorBindingBurst(entity, payloads);

    if (restartStateKeepalive) {
        startW600WindowSensorStateKeepalive(entity, sensorIeeeAddress, windowSensorState);
    }
}

function findClimateExpose(extend) {
    return extend.exposes.find((expose) => typeof expose !== "function" && "type" in expose && expose.type === "climate");
}

function findExpose(extend, name) {
    return extend.exposes.find((expose) => typeof expose !== "function" && "name" in expose && expose.name === name);
}

function findClimateFeature(climateExpose, name) {
    return climateExpose?.features.find((feature) => typeof feature !== "function" && "name" in feature && feature.name === name);
}

function replaceToZigbeeConverter(extend, key, converter) {
    const index = extend.toZigbee.findIndex((candidate) => candidate.key?.includes(key));

    if (index === -1) {
        extend.toZigbee.push(converter);
    } else {
        extend.toZigbee[index] = converter;
    }
}

function withSafeLumiRead(extend, attributes) {
    extend.configure = [
        ...(extend.configure ?? []),
        async (device) => {
            const endpoint = device.getEndpoint(1);
            await safeRead(endpoint, CLUSTER_LUMI, attributes, {manufacturerCode});
        },
    ];

    return extend;
}

function lumiBinary(args) {
    return withSafeLumiRead(
        m.binary({
            cluster: CLUSTER_LUMI,
            zigbeeCommandOptions: {manufacturerCode},
            ...args,
        }),
        [typeof args.attribute === "string" ? args.attribute : args.attribute.ID],
    );
}

function lumiNumeric(args) {
    return withSafeLumiRead(
        m.numeric({
            cluster: CLUSTER_LUMI,
            zigbeeCommandOptions: {manufacturerCode},
            ...args,
        }),
        [typeof args.attribute === "string" ? args.attribute : args.attribute.ID],
    );
}

function lumiEnumLookup(args) {
    const extend = m.enumLookup({
        cluster: CLUSTER_LUMI,
        zigbeeCommandOptions: {manufacturerCode},
        ...args,
    });

    if (args.access !== "SET") {
        return withSafeLumiRead(extend, [typeof args.attribute === "string" ? args.attribute : args.attribute.ID]);
    }

    return extend;
}

function decodePresetTemperatureTable(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 1) {
        return undefined;
    }

    const entryCount = buffer.readUInt8(0);
    const table = {};

    for (let index = 0; index < entryCount; index++) {
        const offset = 1 + index * 5;

        if (offset + 5 > buffer.length) {
            break;
        }

        const presetId = buffer.readUInt8(offset);
        const presetName = PRESET_BY_ID[presetId];

        if (!presetName) {
            continue;
        }

        table[presetName] = buffer.readUInt16LE(offset + 3);
    }

    return table;
}

function encodePresetTemperatureTable(table) {
    const buffer = Buffer.alloc(1 + PRESET_ORDER.length * 5);

    buffer.writeUInt8(PRESET_ORDER.length, 0);

    PRESET_ORDER.forEach((presetName, index) => {
        const centiDegrees = table[presetName];

        if (!Number.isInteger(centiDegrees)) {
            throw new Error(`Missing cached value for ${presetName} preset temperature`);
        }

        const offset = 1 + index * 5;
        buffer.writeUInt8(PRESET_ID_BY_NAME[presetName], offset);
        buffer.writeUInt8(0, offset + 1);
        buffer.writeUInt8(0, offset + 2);
        buffer.writeUInt16LE(centiDegrees, offset + 3);
    });

    return buffer;
}

function getCachedPresetTemperatureTable(entity, meta) {
    const storeKey = getDeviceStoreKey(entity);
    const cached = globalStore.getValue(storeKey, PRESET_TABLE_STORE_KEY);

    if (cached) {
        return {...cached};
    }

    const table = {};

    for (const {preset, property} of PRESET_TEMPERATURE_DEFINITIONS) {
        const stateValue = meta.state?.[property];

        if (typeof stateValue !== "number" || !Number.isFinite(stateValue)) {
            return undefined;
        }

        table[preset] = Math.round(stateValue * 100);
    }

    return table;
}

function getPresetTemperatureFromState(meta, presetName) {
    const property = PROPERTY_BY_PRESET_NAME[presetName];
    const value = meta.state?.[property];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function inferManualCustomPreset(meta, deviceKey, hold, setpoint, presetName) {
    if (hold !== true || !presetName || !Object.hasOwn(PROPERTY_BY_PRESET_NAME, presetName) || typeof setpoint !== "number") {
        return false;
    }

    const presetTemperature = getPresetTemperatureFromState(meta, presetName);

    if (typeof presetTemperature !== "number") {
        return globalStore.getValue(deviceKey, MANUAL_CUSTOM_PRESET_STORE_KEY, false);
    }

    return Math.abs(setpoint - presetTemperature) > 0.001;
}

const W600_SENSOR_BINDING_MARKER = Buffer.from([0x00, 0x01, 0x00, 0x55]);
const W600_EXTERNAL_TEMP_SENSOR_DESCRIPTOR = Buffer.from([
    0x15, 0x0a, 0x01, 0x00, 0x00, 0x01, 0x06, 0xe6, 0xb8, 0xa9, 0xe5, 0xba, 0xa6, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, 0x07, 0x65,
]);
const W600_WINDOW_SENSOR_STATE_CHANNEL = 0x16;
const W600_WINDOW_SENSOR_AVAILABILITY_CHANNEL = 0x18;
const W600_WINDOW_SENSOR_STATE_MARKER = Buffer.from([0x03, 0x01, 0x00, 0x55]);
const W600_WINDOW_SENSOR_STATE_DESCRIPTOR = Buffer.from([
    0x29, 0x0a, 0x01, 0x09, 0xe9, 0x97, 0xa8, 0xe7, 0xaa, 0x97, 0xe7, 0x8a, 0xb6, 0x09, 0xe9, 0x97, 0xa8, 0xe7, 0xaa, 0x97, 0xe7, 0x8a, 0xb6, 0x09,
    0xe9, 0x97, 0xa8, 0xe7,
]);
const W600_WINDOW_SENSOR_AVAILABILITY_MARKER = Buffer.from([0x08, 0x00, 0x07, 0xfd]);
const W600_WINDOW_SENSOR_AVAILABILITY_DESCRIPTOR = Buffer.from([
    0x15, 0x0a, 0x01, 0x09, 0xe8, 0xae, 0xbe, 0xe5, 0xa4, 0x87, 0xe5, 0x9c, 0xa8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x67,
]);
const W600_WINDOW_SENSOR_METADATA_PAYLOAD = Buffer.from([0xaa, 0x97, 0xe7, 0x8a, 0xb6, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x0e, 0x67]);

function getNextSensorBindingCounter(entity) {
    const storeKey = getDeviceStoreKey(entity);
    const counter = globalStore.getValue(storeKey, SENSOR_BINDING_COUNTER_STORE_KEY, 0x12);
    globalStore.putValue(storeKey, SENSOR_BINDING_COUNTER_STORE_KEY, (counter + 1) & 0xff);
    return counter;
}

function reserveSensorBindingCounters(entity, count) {
    const storeKey = getDeviceStoreKey(entity);
    const counter = globalStore.getValue(storeKey, SENSOR_BINDING_COUNTER_STORE_KEY, 0x12);
    globalStore.putValue(storeKey, SENSOR_BINDING_COUNTER_STORE_KEY, (counter + count) & 0xff);
    return counter;
}

function buildW600SensorPayload(entity, action, payload, options = undefined) {
    const counter = options?.counter ?? getNextSensorBindingCounter(entity);
    const header = Buffer.from([0xaa, 0x71, payload.length + 3, 0x44, counter]);
    const checksum = (0x200 - header.reduce((sum, byte) => sum + byte, 0)) & 0xff;

    return Buffer.concat([header, Buffer.from([checksum, action, Zcl.DataType.OCTET_STR, payload.length]), payload]);
}

function buildW600WrappedSensorPayload(entity, action, subtype, payload, options = undefined) {
    const counter = options?.counter ?? getNextSensorBindingCounter(entity);
    const header = Buffer.from([0xaa, 0x71, payload.length, 0x46, counter, action, subtype]);
    const checksum = (0x200 - header.reduce((sum, byte) => sum + byte, 0)) & 0xff;

    return Buffer.concat([header, Buffer.from([checksum]), payload]);
}

function getTimestampBuffer() {
    const timestamp = Buffer.alloc(4);
    timestamp.writeUInt32BE(Math.floor(Date.now() / 1000));
    return timestamp;
}

function buildW600ExternalTempSensorBindPayload(entity, sensorIeeeAddress, meta) {
    const deviceBuffer = ieeeAddressToBuffer(getDeviceIeeeAddress(entity, meta), "device_ieee");
    const sensorBuffer = ieeeAddressToBuffer(sensorIeeeAddress, "external_sensor_ieee");
    const payload = Buffer.concat([
        getTimestampBuffer(),
        Buffer.from([0x14]),
        deviceBuffer,
        sensorBuffer,
        W600_SENSOR_BINDING_MARKER,
        W600_EXTERNAL_TEMP_SENSOR_DESCRIPTOR,
    ]);

    return buildW600SensorPayload(entity, 0x02, payload);
}

function buildW600WindowSensorStateBindPayload(entity, sensorIeeeAddress, meta, options = undefined) {
    const deviceBuffer = ieeeAddressToBuffer(getDeviceIeeeAddress(entity, meta), "device_ieee");
    const sensorBuffer = ieeeAddressToBuffer(sensorIeeeAddress, "window_sensor_ieee");
    const payload = Buffer.concat([
        Buffer.from([0x02, Zcl.DataType.OCTET_STR, 0x43]),
        getTimestampBuffer(),
        Buffer.from([W600_WINDOW_SENSOR_STATE_CHANNEL]),
        deviceBuffer,
        sensorBuffer,
        W600_WINDOW_SENSOR_STATE_MARKER,
        W600_WINDOW_SENSOR_STATE_DESCRIPTOR,
    ]);

    return buildW600WrappedSensorPayload(entity, 0x02, 0x01, payload, options);
}

function buildW600WindowSensorAvailabilityBindPayload(entity, sensorIeeeAddress, meta, options = undefined) {
    const deviceBuffer = ieeeAddressToBuffer(getDeviceIeeeAddress(entity, meta), "device_ieee");
    const sensorBuffer = ieeeAddressToBuffer(sensorIeeeAddress, "window_sensor_ieee");
    const payload = Buffer.concat([
        getTimestampBuffer(),
        Buffer.from([W600_WINDOW_SENSOR_AVAILABILITY_CHANNEL]),
        deviceBuffer,
        sensorBuffer,
        W600_WINDOW_SENSOR_AVAILABILITY_MARKER,
        W600_WINDOW_SENSOR_AVAILABILITY_DESCRIPTOR,
    ]);

    return buildW600SensorPayload(entity, 0x02, payload, options);
}

function buildW600WindowSensorMetadataPayload(entity, options = undefined) {
    return buildW600WrappedSensorPayload(entity, 0x02, 0x02, W600_WINDOW_SENSOR_METADATA_PAYLOAD, options);
}

function buildW600ExternalTempSensorUnbindPayload(entity, meta) {
    const deviceBuffer = ieeeAddressToBuffer(getDeviceIeeeAddress(entity, meta), "device_ieee");
    const payload = Buffer.concat([getTimestampBuffer(), Buffer.from([0x14]), deviceBuffer, Buffer.alloc(12)]);

    return buildW600SensorPayload(entity, 0x04, payload);
}

function buildW600WindowSensorUnbindPayload(entity, meta, channel) {
    const deviceBuffer = ieeeAddressToBuffer(getDeviceIeeeAddress(entity, meta), "device_ieee");
    const payload = Buffer.concat([getTimestampBuffer(), Buffer.from([channel]), deviceBuffer, Buffer.alloc(12)]);

    return buildW600SensorPayload(entity, 0x04, payload);
}

function buildW600ExternalTemperaturePayload(entity, sensorIeeeAddress, centiDegrees) {
    const sensorBuffer = ieeeAddressToBuffer(sensorIeeeAddress, "external_sensor_ieee");
    const temperatureBuffer = Buffer.alloc(4);
    temperatureBuffer.writeFloatBE(centiDegrees);

    return buildW600SensorPayload(entity, 0x05, Buffer.concat([sensorBuffer, W600_SENSOR_BINDING_MARKER, temperatureBuffer]));
}

function buildW600WindowSensorStatePayload(entity, sensorIeeeAddress, state, options = undefined) {
    const sensorBuffer = ieeeAddressToBuffer(sensorIeeeAddress, "window_sensor_ieee");
    const stateBuffer = Buffer.alloc(4);
    stateBuffer.writeUInt32BE(state === "open" ? 1 : 0);

    return buildW600SensorPayload(entity, 0x05, Buffer.concat([sensorBuffer, W600_WINDOW_SENSOR_STATE_MARKER, stateBuffer]), options);
}

function buildW600WindowSensorAvailabilityPayload(entity, sensorIeeeAddress, online = true, options = undefined) {
    const sensorBuffer = ieeeAddressToBuffer(sensorIeeeAddress, "window_sensor_ieee");
    const stateBuffer = Buffer.alloc(4);
    stateBuffer.writeUInt32BE(online ? 1 : 0);

    return buildW600SensorPayload(entity, 0x05, Buffer.concat([sensorBuffer, W600_WINDOW_SENSOR_AVAILABILITY_MARKER, stateBuffer]), options);
}

function decodeW600ExternalTempSensorBinding(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 21 || buffer[0] !== 0xaa || buffer[1] !== 0x71) {
        return undefined;
    }

    const action = buffer[6];
    const payload = buffer.subarray(9);

    if (action !== 0x06 || payload.length < 12) {
        return undefined;
    }

    const sensorIeeeAddress = payload.subarray(0, 8);
    const marker = payload.subarray(8, 12);

    if (!marker.equals(W600_SENSOR_BINDING_MARKER)) {
        return undefined;
    }

    return {sensorIeeeAddress: bufferToIeeeAddress(sensorIeeeAddress)};
}

function decodeW600WindowSensorBinding(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 21 || buffer[0] !== 0xaa || buffer[1] !== 0x71 || buffer[6] !== 0x06) {
        return undefined;
    }

    const payload = buffer.subarray(9);

    if (payload.length < 12) {
        return undefined;
    }

    const sensorIeeeAddress = payload.subarray(0, 8);
    const marker = payload.subarray(8, 12);

    if (marker.equals(W600_WINDOW_SENSOR_STATE_MARKER)) {
        return {sensorIeeeAddress: bufferToIeeeAddress(sensorIeeeAddress), bindingType: "state"};
    }

    if (marker.equals(W600_WINDOW_SENSOR_AVAILABILITY_MARKER)) {
        return {sensorIeeeAddress: bufferToIeeeAddress(sensorIeeeAddress), bindingType: "availability"};
    }

    return undefined;
}

function decodeW600WindowSensorValueReport(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 25 || buffer[0] !== 0xaa || buffer[1] !== 0x71 || buffer[6] !== 0x05) {
        return undefined;
    }

    const payload = buffer.subarray(9);

    if (payload.length !== 16) {
        return undefined;
    }

    const sensorIeeeAddress = bufferToIeeeAddress(payload.subarray(0, 8));
    const marker = payload.subarray(8, 12);
    const value = payload.readUInt32BE(12);

    if (marker.equals(W600_WINDOW_SENSOR_STATE_MARKER) && (value === 0 || value === 1)) {
        return {
            sensorIeeeAddress,
            reportType: "state",
            windowSensorState: value === 1 ? "open" : "closed",
        };
    }

    if (marker.equals(W600_WINDOW_SENSOR_AVAILABILITY_MARKER) && (value === 0 || value === 1)) {
        return {
            sensorIeeeAddress,
            reportType: "availability",
        };
    }

    return undefined;
}

function decodeW600WindowSensorAcknowledgement(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 19 || buffer[0] !== 0xaa || buffer[1] !== 0x71 || buffer[6] !== 0x05) {
        return undefined;
    }

    const payload = buffer.subarray(9);

    if (payload.length !== 10 || payload[0] !== 0x00) {
        return undefined;
    }

    return {
        sensorIeeeAddress: bufferToIeeeAddress(payload.subarray(1, 9)),
    };
}

function decodeW600WindowSensorActivationAcknowledgement(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 9 || buffer[0] !== 0xaa || buffer[1] !== 0x71 || buffer[3] !== 0xc6) {
        return undefined;
    }

    if (buffer[5] !== 0x02) {
        return undefined;
    }

    if (buffer[6] === 0x01) {
        return {stage: "bind_ack"};
    }

    if (buffer[6] === 0x02) {
        return {stage: "activation_complete"};
    }

    return undefined;
}

async function setW600WindowSensorModeExternal(entity, sensorIeeeAddress, windowSensorState, meta) {
    cancelW600WindowSensorStateKeepalive(entity);

    const deviceKey = getDeviceStoreKey(entity);
    const baselineProgressSignalCounter = getW600WindowSensorArmingProgressSignalCounter(deviceKey);
    const baselineActivationCompleteSignalCounter = getW600WindowSensorActivationCompleteSignalCounter(deviceKey);
    setW600WindowSensorArmingInProgress(deviceKey, true);

    try {
        // Match the newest Aqara firmware profile (0.0.0_2745) exactly.
        const counterBase = reserveSensorBindingCounters(entity, 5);
        const stateBindPayload = buildW600WindowSensorStateBindPayload(entity, sensorIeeeAddress, meta, {counter: counterBase});
        const availabilityBindPayload = buildW600WindowSensorAvailabilityBindPayload(entity, sensorIeeeAddress, meta, {
            counter: (counterBase + 1) & 0xff,
        });
        const metadataPayload = buildW600WindowSensorMetadataPayload(entity, {counter: counterBase});
        const closedPayload = buildW600WindowSensorStatePayload(entity, sensorIeeeAddress, "closed", {
            counter: (counterBase + 2) & 0xff,
        });
        const initialPresencePayload = buildW600WindowSensorAvailabilityPayload(entity, sensorIeeeAddress, true, {
            counter: (counterBase + 3) & 0xff,
        });
        const completionPresencePayload = buildW600WindowSensorAvailabilityPayload(entity, sensorIeeeAddress, true, {
            counter: (counterBase + 4) & 0xff,
        });
        const initialSetupBurst = [stateBindPayload, availabilityBindPayload, closedPayload, initialPresencePayload];
        const completionBurst = [
            metadataPayload,
            metadataPayload,
            availabilityBindPayload,
            metadataPayload,
            completionPresencePayload,
            metadataPayload,
        ];

        await writeW600SensorBindingBurst(entity, initialSetupBurst);

        await wait(W600_WINDOW_SENSOR_SETUP_PRE_METADATA_DELAY_MS);
        await writeW600SensorBindingBurst(entity, completionBurst);

        const progressConfirmed = await waitForW600WindowSensorArmingProgressSignal(entity, baselineProgressSignalCounter);

        if (!progressConfirmed) {
            throw new Error("Window sensor arming timed out before progress confirmation");
        }

        const activationConfirmed = await waitForW600WindowSensorActivationCompleteSignal(entity, baselineActivationCompleteSignalCounter);

        if (!activationConfirmed) {
            throw new Error("Window sensor arming timed out before subtype-02 activation confirmation");
        }

        await writeW600WindowSensorStateUpdate(entity, sensorIeeeAddress, windowSensorState, {
            includeAvailability: windowSensorState === "closed",
            stateWriteCount: 1,
            restartStateKeepalive: true,
        });

        cacheW600ExternalWindowSensor(deviceKey, sensorIeeeAddress, windowSensorState);
    } finally {
        setW600WindowSensorArmingInProgress(deviceKey, false);
    }
}

async function setW600WindowSensorModeTemperatureDifference(entity, meta) {
    cancelW600WindowSensorStateKeepalive(entity);
    await writeLumiAttribute(
        entity,
        ATTR_SENSOR_BINDING,
        buildW600WindowSensorUnbindPayload(entity, meta, W600_WINDOW_SENSOR_STATE_CHANNEL),
        Zcl.DataType.OCTET_STR,
    );
    await writeLumiAttribute(
        entity,
        ATTR_SENSOR_BINDING,
        buildW600WindowSensorUnbindPayload(entity, meta, W600_WINDOW_SENSOR_AVAILABILITY_CHANNEL),
        Zcl.DataType.OCTET_STR,
    );
    cacheW600WindowSensorMode(entity, "temperature_difference");
    setW600WindowSensorArmingInProgress(entity, false);
}

function getRequestedWindowDetectionMode(entity, meta) {
    if (meta.message?.window_detection_mode != null) {
        return parseEnumName(meta.message.window_detection_mode, WINDOW_DETECTION_MODE_BY_VALUE, "window_detection_mode");
    }

    return getCachedWindowDetectionMode(entity, meta) ?? "temperature_difference";
}

function getRequestedWindowSensorIeee(entity, meta) {
    if (meta.message?.window_sensor_ieee != null) {
        return normalizeIeeeAddress(meta.message.window_sensor_ieee, "window_sensor_ieee");
    }

    return getCachedWindowSensorIeee(entity, meta);
}

function getRequestedWindowSensorState(entity, meta, defaultValue = "closed") {
    if (meta.message?.window_sensor_state != null) {
        return parseWindowSensorState(meta.message.window_sensor_state, "window_sensor_state");
    }

    return getCachedWindowSensorState(entity, meta) ?? defaultValue;
}

function buildWindowDetectionState(windowDetectionEnabled, windowDetectionMode, windowSensorIeee, windowSensorState) {
    const state = {
        window_detection: windowDetectionEnabled ? "ON" : "OFF",
        window_detection_mode: windowDetectionMode,
        window_sensor_ieee: windowSensorIeee ?? "",
        window_sensor_state: windowSensorState ?? "closed",
    };

    return state;
}

async function fallbackToTemperatureDifferenceWindowDetection(entity, meta) {
    await setW600WindowSensorModeTemperatureDifference(entity, meta);
    return {
        windowDetectionMode: "temperature_difference",
        windowSensorIeee: getRequestedWindowSensorIeee(entity, meta),
        windowSensorState: getRequestedWindowSensorState(entity, meta),
    };
}

async function armW600WindowDetectionMode(entity, requestedMode, meta) {
    const requestedWindowSensorIeee = getRequestedWindowSensorIeee(entity, meta);
    const requestedWindowSensorState = getRequestedWindowSensorState(entity, meta);
    const initialWindowSensorState = requestedWindowSensorState ?? "closed";

    if (requestedMode !== "external_sensor") {
        await setW600WindowSensorModeTemperatureDifference(entity, meta);
        return {
            windowDetectionMode: "temperature_difference",
            windowSensorIeee: requestedWindowSensorIeee,
            windowSensorState: requestedWindowSensorState,
        };
    }

    if (!requestedWindowSensorIeee) {
        logger.warning(
            "External window sensor mode requested for " +
                getDeviceStoreKey(entity) +
                " without window_sensor_ieee; reverting to temperature_difference",
            NS,
        );
        return fallbackToTemperatureDifferenceWindowDetection(entity, meta);
    }

    try {
        await setW600WindowSensorModeExternal(entity, requestedWindowSensorIeee, initialWindowSensorState, meta);
        return {
            windowDetectionMode: "external_sensor",
            windowSensorIeee: requestedWindowSensorIeee,
            windowSensorState: initialWindowSensorState,
        };
    } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        logger.error(
            `Failed to activate external window sensor mode for ${getDeviceStoreKey(entity)}; reverting to temperature_difference: ${details}`,
            NS,
        );

        try {
            const fallback = await fallbackToTemperatureDifferenceWindowDetection(entity, meta);
            await safeRead(entity, CLUSTER_LUMI, [ATTR_WINDOW_DETECTION], {manufacturerCode});
            return fallback;
        } catch (fallbackError) {
            const fallbackDetails = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            throw new Error(
                "Failed to arm external window detection and fallback to temperature_difference: " +
                    details +
                    "; fallback failed: " +
                    fallbackDetails,
            );
        }
    }
}

function w600WindowDetection() {
    return {
        exposes: [
            e
                .binary("window_detection", ea.ALL, "ON", "OFF")
                .withCategory("config")
                .withDescription(
                    "Enable or disable window detection. When turned on, the thermostat arms the currently selected detection mode. " +
                        "If external mode is selected without a configured IEEE address, it falls back to temperature_difference.",
                ),
        ],
        fromZigbee: [
            {
                cluster: CLUSTER_LUMI,
                type: ["attributeReport", "readResponse"],
                convert: (model, msg, publish, options, meta) => {
                    if (msg.data[ATTR_WINDOW_DETECTION] === undefined) {
                        return undefined;
                    }

                    const enabled = msg.data[ATTR_WINDOW_DETECTION] === 1;
                    const deviceKey = getDeviceStoreKey(meta.device);
                    globalStore.putValue(deviceKey, WINDOW_DETECTION_ENABLED_STORE_KEY, enabled);

                    if (!enabled) {
                        cancelW600WindowSensorStateKeepalive(meta.device);
                    }

                    return {window_detection: enabled ? "ON" : "OFF"};
                },
            },
        ],
        toZigbee: [
            {
                key: ["window_detection"],
                convertSet: async (entity, key, value, meta) => {
                    const enabled = parseRequiredW600BinaryEnabled(value, key);
                    const deviceKey = getDeviceStoreKey(entity);

                    if (!enabled) {
                        await writeLumiAttribute(entity, ATTR_WINDOW_DETECTION, 0);
                        cancelW600WindowSensorStateKeepalive(entity);
                        globalStore.putValue(deviceKey, WINDOW_DETECTION_ENABLED_STORE_KEY, false);

                        if (meta.message?.window_detection_mode != null) {
                            cacheW600WindowSensorMode(
                                deviceKey,
                                parseEnumName(meta.message.window_detection_mode, WINDOW_DETECTION_MODE_BY_VALUE, "window_detection_mode"),
                            );
                        }

                        if (meta.message?.window_sensor_ieee != null) {
                            cacheW600WindowSensorIeee(deviceKey, normalizeIeeeAddress(meta.message.window_sensor_ieee, "window_sensor_ieee"));
                        }

                        if (meta.message?.window_sensor_state != null) {
                            cacheW600WindowSensorState(deviceKey, parseWindowSensorState(meta.message.window_sensor_state, "window_sensor_state"));
                        }

                        return {
                            state: buildWindowDetectionState(
                                false,
                                getRequestedWindowDetectionMode(entity, meta),
                                getRequestedWindowSensorIeee(entity, meta),
                                getRequestedWindowSensorState(entity, meta),
                            ),
                        };
                    }

                    await writeLumiAttribute(entity, ATTR_WINDOW_DETECTION, 1);
                    globalStore.putValue(deviceKey, WINDOW_DETECTION_ENABLED_STORE_KEY, true);

                    const arming = await armW600WindowDetectionMode(entity, getRequestedWindowDetectionMode(entity, meta), meta);
                    return {
                        state: buildWindowDetectionState(true, arming.windowDetectionMode, arming.windowSensorIeee, arming.windowSensorState),
                    };
                },
                convertGet: async (entity) => {
                    await readLumiAttribute(entity, ATTR_WINDOW_DETECTION);
                },
            },
        ],
        configure: [
            async (device) => {
                const endpoint = device.getEndpoint(1);
                await safeRead(endpoint, CLUSTER_LUMI, [ATTR_WINDOW_DETECTION], {manufacturerCode});
            },
        ],
        isModernExtend: true,
    };
}

const W600_WEEKLY_SCHEDULE_DAY_DEFINITIONS = [
    {name: "sunday", label: "Sunday", mask: 0x01, property: "weekly_schedule_sunday"},
    {name: "monday", label: "Monday", mask: 0x02, property: "weekly_schedule_monday"},
    {name: "tuesday", label: "Tuesday", mask: 0x04, property: "weekly_schedule_tuesday"},
    {name: "wednesday", label: "Wednesday", mask: 0x08, property: "weekly_schedule_wednesday"},
    {name: "thursday", label: "Thursday", mask: 0x10, property: "weekly_schedule_thursday"},
    {name: "friday", label: "Friday", mask: 0x20, property: "weekly_schedule_friday"},
    {name: "saturday", label: "Saturday", mask: 0x40, property: "weekly_schedule_saturday"},
];

const W600_WEEKLY_SCHEDULE_DAY_PROPERTIES = W600_WEEKLY_SCHEDULE_DAY_DEFINITIONS.map(({property}) => property);

const W600_WEEKLY_SCHEDULE_HEADER_STRING = "ROUTERX-ENCRYPTEDO00";
const W600_WEEKLY_SCHEDULE_IMAGE_TYPE = 0x1400;
const W600_WEEKLY_SCHEDULE_FILE_VERSION = 0x00000100;
const W600_WEEKLY_SCHEDULE_STACK_VERSION = 0x0002;
const W600_WEEKLY_SCHEDULE_IMAGE_NOTIFY_QUERY_JITTER = 48;
const W600_WEEKLY_SCHEDULE_OTA_STAGE_TTL_MS = 5 * 60 * 1000;
const W600_WEEKLY_SCHEDULE_UPLOAD_STATUSES = ["idle", "staged", "in_progress", "success", "failed"];

function createEmptyW600WeeklyScheduleDraft() {
    return Object.fromEntries(W600_WEEKLY_SCHEDULE_DAY_DEFINITIONS.map(({property}) => [property, ""]));
}

function buildW600WeeklyScheduleStatePayload(draft) {
    return Object.fromEntries(W600_WEEKLY_SCHEDULE_DAY_DEFINITIONS.map(({property}) => [property, draft[property] === "" ? null : draft[property]]));
}

function buildW600WeeklyScheduleUploadStatePayload(uploadState) {
    return {
        schedule_upload_status: uploadState.status,
    };
}

function getW600WeeklyScheduleUploadStatePayload(deviceOrEntity) {
    const uploadState = normalizeW600WeeklyScheduleUploadState(
        globalStore.getValue(getDeviceStoreKey(deviceOrEntity), WEEKLY_SCHEDULE_UPLOAD_STATE_STORE_KEY),
    );
    return buildW600WeeklyScheduleUploadStatePayload(uploadState);
}

function normalizeW600WeeklyScheduleUploadState(uploadState) {
    const normalizedStatus =
        typeof uploadState?.status === "string" && W600_WEEKLY_SCHEDULE_UPLOAD_STATUSES.includes(uploadState.status) ? uploadState.status : "idle";

    return {
        status: normalizedStatus,
        error: typeof uploadState?.error === "string" ? uploadState.error : "",
        operation: typeof uploadState?.operation === "string" ? uploadState.operation : "save_schedule",
        recordCount: Number.isInteger(uploadState?.recordCount) && uploadState.recordCount >= 0 ? uploadState.recordCount : 0,
        uploadId: typeof uploadState?.uploadId === "string" ? uploadState.uploadId : undefined,
        updatedAt: typeof uploadState?.updatedAt === "number" ? uploadState.updatedAt : 0,
    };
}

function updateW600WeeklyScheduleUploadState(deviceOrEntity, partialState, publish) {
    const storeKey = getDeviceStoreKey(deviceOrEntity);
    const currentState = normalizeW600WeeklyScheduleUploadState(globalStore.getValue(storeKey, WEEKLY_SCHEDULE_UPLOAD_STATE_STORE_KEY));
    const nextState = normalizeW600WeeklyScheduleUploadState({
        ...currentState,
        ...partialState,
        updatedAt: Date.now(),
    });

    globalStore.putValue(storeKey, WEEKLY_SCHEDULE_UPLOAD_STATE_STORE_KEY, nextState);

    const payload = buildW600WeeklyScheduleUploadStatePayload(nextState);

    if (typeof publish === "function") {
        publish(payload);
    }

    return {state: payload, uploadState: nextState};
}

function clearW600WeeklyScheduleUploadTimeout(deviceOrEntity) {
    const storeKey = getDeviceStoreKey(deviceOrEntity);
    const timeout = WEEKLY_SCHEDULE_UPLOAD_TIMEOUTS.get(storeKey);

    if (timeout != null) {
        clearTimeout(timeout);
        WEEKLY_SCHEDULE_UPLOAD_TIMEOUTS.delete(storeKey);
    }
}

function describeW600WeeklyScheduleOperation(operation) {
    return operation === "clear_schedule" ? "clear schedule upload" : "save schedule upload";
}

function failW600WeeklyScheduleUpload(deviceOrEntity, error, publish) {
    const storeKey = getDeviceStoreKey(deviceOrEntity);
    const uploadState = normalizeW600WeeklyScheduleUploadState(globalStore.getValue(storeKey, WEEKLY_SCHEDULE_UPLOAD_STATE_STORE_KEY));
    const message = typeof error === "string" && error.trim() !== "" ? error : "Unknown weekly schedule upload failure";

    clearW600WeeklyScheduleUploadTimeout(storeKey);
    globalStore.clearValue(storeKey, WEEKLY_SCHEDULE_OTA_STAGE_STORE_KEY);
    logger.warning(`W600 ${describeW600WeeklyScheduleOperation(uploadState.operation)} failed for ${storeKey}: ${message}`, NS);
    return updateW600WeeklyScheduleUploadState(storeKey, {status: "failed", error: message}, publish);
}

function armW600WeeklyScheduleUploadTimeout(deviceOrEntity, uploadId, publish) {
    const storeKey = getDeviceStoreKey(deviceOrEntity);

    clearW600WeeklyScheduleUploadTimeout(storeKey);

    const timeout = setTimeout(() => {
        const stage = globalStore.getValue(storeKey, WEEKLY_SCHEDULE_OTA_STAGE_STORE_KEY);

        if (!stage || stage.uploadId !== uploadId) {
            return;
        }

        failW600WeeklyScheduleUpload(storeKey, "Timed out waiting for the device to finish the weekly schedule OTA transfer", publish);
    }, W600_WEEKLY_SCHEDULE_OTA_STAGE_TTL_MS);

    timeout.unref?.();
    WEEKLY_SCHEDULE_UPLOAD_TIMEOUTS.set(storeKey, timeout);
}

function updateW600WeeklyScheduleOtaStage(deviceOrEntity, partialStage) {
    const storeKey = getDeviceStoreKey(deviceOrEntity);
    const stage = globalStore.getValue(storeKey, WEEKLY_SCHEDULE_OTA_STAGE_STORE_KEY);

    if (!stage || !Buffer.isBuffer(stage.image)) {
        return undefined;
    }

    const nextStage = {
        ...stage,
        ...partialStage,
        lastActivityAt: Date.now(),
    };

    globalStore.putValue(storeKey, WEEKLY_SCHEDULE_OTA_STAGE_STORE_KEY, nextStage);
    return nextStage;
}

function markW600WeeklyScheduleUploadStarted(deviceOrEntity, publish) {
    const storeKey = getDeviceStoreKey(deviceOrEntity);
    const currentState = normalizeW600WeeklyScheduleUploadState(globalStore.getValue(storeKey, WEEKLY_SCHEDULE_UPLOAD_STATE_STORE_KEY));
    const stage = updateW600WeeklyScheduleOtaStage(storeKey, {});

    if (!stage) {
        return undefined;
    }

    const shouldPublish = currentState.status !== "in_progress" || currentState.uploadId !== stage.uploadId || currentState.error !== "";

    if (shouldPublish) {
        logger.info(
            `W600 ${describeW600WeeklyScheduleOperation(stage.operation)} started for ${storeKey}; image size ${stage.image.length} bytes`,
            NS,
        );
    }

    armW600WeeklyScheduleUploadTimeout(storeKey, stage.uploadId, publish);
    return updateW600WeeklyScheduleUploadState(
        storeKey,
        {
            status: "in_progress",
            error: "",
            operation: stage.operation,
            recordCount: stage.recordCount,
            uploadId: stage.uploadId,
        },
        shouldPublish ? publish : undefined,
    );
}

function noteW600WeeklyScheduleUploadBlock(deviceOrEntity, publish) {
    const stage = updateW600WeeklyScheduleOtaStage(deviceOrEntity, {});

    if (!stage) {
        return undefined;
    }

    armW600WeeklyScheduleUploadTimeout(deviceOrEntity, stage.uploadId, publish);
    return stage;
}

function completeW600WeeklyScheduleUpload(deviceOrEntity, publish) {
    const storeKey = getDeviceStoreKey(deviceOrEntity);
    const stage = globalStore.getValue(storeKey, WEEKLY_SCHEDULE_OTA_STAGE_STORE_KEY);
    const operation = typeof stage?.operation === "string" ? stage.operation : "save_schedule";

    clearW600WeeklyScheduleUploadTimeout(storeKey);
    globalStore.clearValue(storeKey, WEEKLY_SCHEDULE_OTA_STAGE_STORE_KEY);
    logger.info(`W600 ${describeW600WeeklyScheduleOperation(operation)} completed for ${storeKey}`, NS);
    return updateW600WeeklyScheduleUploadState(storeKey, {status: "success", error: "", operation}, publish);
}

function ensureNoActiveW600WeeklyScheduleUpload(deviceOrEntity) {
    const stage = getActiveW600WeeklyScheduleOtaStage(deviceOrEntity);

    if (!stage) {
        return;
    }

    const uploadState = normalizeW600WeeklyScheduleUploadState(
        globalStore.getValue(getDeviceStoreKey(deviceOrEntity), WEEKLY_SCHEDULE_UPLOAD_STATE_STORE_KEY),
    );
    throw new Error(
        `A weekly schedule upload is already active (${uploadState.status}) for ${describeW600WeeklyScheduleOperation(stage.operation)}. ` +
            "Wait for it to finish before starting another save or clear.",
    );
}

function getCachedW600WeeklyScheduleDraft(entity, meta) {
    const draft = createEmptyW600WeeklyScheduleDraft();
    const storeKey = getDeviceStoreKey(entity);
    const cached = globalStore.getValue(storeKey, WEEKLY_SCHEDULE_DRAFT_STORE_KEY);

    for (const {property} of W600_WEEKLY_SCHEDULE_DAY_DEFINITIONS) {
        if (typeof cached?.[property] === "string") {
            draft[property] = cached[property];
        } else if (typeof meta.state?.[property] === "string") {
            draft[property] = meta.state[property];
        }
    }

    return draft;
}

function seedW600WeeklyScheduleDraftState(deviceOrEntity, state) {
    const draft = getCachedW600WeeklyScheduleDraft(deviceOrEntity, {state});
    Object.assign(state, buildW600WeeklyScheduleStatePayload(draft));
}

function parseW600ScheduleTriggerValue(value, key) {
    if (value === true || value === 1) {
        return;
    }

    if (typeof value === "string") {
        const normalized = normalizeEnumKey(value);

        if (["trigger", "press", "pressed", "start", "save", "clear", "true", "1"].includes(normalized)) {
            return;
        }
    }

    throw new Error(`${key} must be one of: trigger, press, start`);
}

function formatW600ScheduleTime(totalMinutes) {
    const hours = Math.floor(totalMinutes / 60)
        .toString()
        .padStart(2, "0");
    const minutes = (totalMinutes % 60).toString().padStart(2, "0");
    return `${hours}:${minutes}`;
}

function formatW600ScheduleDayTransitions(transitions) {
    return transitions.map(({minutes, preset}) => `${formatW600ScheduleTime(minutes)}/${preset}`).join(", ");
}

function parseW600ScheduleDayTransitions(value, key) {
    if (typeof value !== "string") {
        throw new Error(`${key} must be a string`);
    }

    const compact = value.replace(/\s+/g, "");

    if (compact === "") {
        return [];
    }

    const parts = compact.split(",");

    if (parts.some((part) => part.length === 0)) {
        throw new Error(`${key} must use comma-delimited entries in the format HH:MM/preset`);
    }

    const transitions = [];
    const seenMinutes = new Set();

    for (const part of parts) {
        const match = part.match(/^([0-9]|[01]\d|2[0-3]):([0-5]\d)\/(.+)$/);

        if (!match) {
            throw new Error(`${key} entries must use the format H:MM/preset or HH:MM/preset, for example 08:00/home`);
        }

        const minutes = Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10);

        if (seenMinutes.has(minutes)) {
            throw new Error(`${key} cannot contain multiple entries for ${formatW600ScheduleTime(minutes)}`);
        }

        seenMinutes.add(minutes);
        transitions.push({minutes, preset: parseEnumName(match[3], PRESET_ID_BY_NAME, key)});
    }

    transitions.sort((left, right) => left.minutes - right.minutes);
    return transitions;
}

function normalizeW600WeeklyScheduleDraft(draft) {
    const normalizedDraft = createEmptyW600WeeklyScheduleDraft();
    const records = [];

    for (const {mask, property} of W600_WEEKLY_SCHEDULE_DAY_DEFINITIONS) {
        const transitions = parseW600ScheduleDayTransitions(draft[property] ?? "", property);
        normalizedDraft[property] = formatW600ScheduleDayTransitions(transitions);

        for (const transition of transitions) {
            records.push({dayMask: mask, minutes: transition.minutes, presetId: PRESET_ID_BY_NAME[transition.preset]});
        }
    }

    records.sort((left, right) => left.dayMask - right.dayMask || left.minutes - right.minutes || left.presetId - right.presetId);
    return {draft: normalizedDraft, records};
}

function encodeW600WeeklyScheduleSch2(records) {
    if (records.length > 0xff) {
        throw new Error("Weekly schedule contains too many entries");
    }

    const buffer = Buffer.alloc(5 + records.length * 12);
    buffer.write("SCH2", 0, "ascii");
    buffer.writeUInt8(records.length, 4);

    records.forEach((record, index) => {
        const offset = 5 + index * 12;
        buffer.writeUInt8(record.dayMask, offset);
        buffer.writeUInt16LE(record.minutes, offset + 1);
        buffer.writeUInt8(0x01, offset + 3);
        buffer.writeUInt8(record.presetId, offset + 4);
    });

    return buffer;
}

function buildW600WeeklyScheduleCrc32Table() {
    const table = new Uint32Array(256);

    for (let index = 0; index < 256; index++) {
        let value = index;

        for (let bit = 0; bit < 8; bit++) {
            value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
        }

        table[index] = value >>> 0;
    }

    return table;
}

const W600_WEEKLY_SCHEDULE_CRC32_TABLE = buildW600WeeklyScheduleCrc32Table();

function computeW600WeeklyScheduleCrc32(buffer) {
    let crc = 0xffffffff;

    for (const value of buffer) {
        crc = W600_WEEKLY_SCHEDULE_CRC32_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
}

function buildW600WeeklyScheduleSubelement(sch2Payload) {
    const subelement = Buffer.alloc(35 + sch2Payload.length);
    subelement.writeUInt32LE(0x014f, 0);
    subelement.writeUInt32LE(sch2Payload.length + 21, 4);
    subelement.writeUInt8(0x01, 22);
    subelement.writeUInt8(0x04, 23);
    subelement.writeUInt8(0x01, 24);
    subelement.writeUInt8(0x04, 34);
    sch2Payload.copy(subelement, 35);
    subelement.writeUInt32LE(computeW600WeeklyScheduleCrc32(subelement), 10);
    return subelement;
}

function buildW600WeeklyScheduleImage(records) {
    const sch2Payload = encodeW600WeeklyScheduleSch2(records);
    const subelement = buildW600WeeklyScheduleSubelement(sch2Payload);
    const header = Buffer.alloc(56);
    const headerString = Buffer.alloc(32);

    headerString.write(W600_WEEKLY_SCHEDULE_HEADER_STRING, 0, "ascii");
    header.writeUInt32LE(0x0beef11e, 0);
    header.writeUInt16LE(0x0100, 4);
    header.writeUInt16LE(56, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(manufacturerCode, 10);
    header.writeUInt16LE(W600_WEEKLY_SCHEDULE_IMAGE_TYPE, 12);
    header.writeUInt32LE(W600_WEEKLY_SCHEDULE_FILE_VERSION, 14);
    header.writeUInt16LE(W600_WEEKLY_SCHEDULE_STACK_VERSION, 18);
    headerString.copy(header, 20);

    const subelementHeader = Buffer.alloc(6);
    subelementHeader.writeUInt16LE(0xf006, 0);
    subelementHeader.writeUInt32LE(subelement.length, 2);

    const image = Buffer.concat([header, subelementHeader, subelement]);
    image.writeUInt32LE(image.length, 52);
    return image;
}

function getActiveW600WeeklyScheduleOtaStage(deviceOrEntity) {
    const storeKey = getDeviceStoreKey(deviceOrEntity);
    const stage = globalStore.getValue(storeKey, WEEKLY_SCHEDULE_OTA_STAGE_STORE_KEY);

    if (!stage || !Buffer.isBuffer(stage.image) || typeof stage.createdAt !== "number") {
        return undefined;
    }

    const lastActivityAt = typeof stage.lastActivityAt === "number" ? stage.lastActivityAt : stage.createdAt;

    if (Date.now() - lastActivityAt > W600_WEEKLY_SCHEDULE_OTA_STAGE_TTL_MS) {
        failW600WeeklyScheduleUpload(storeKey, "Weekly schedule OTA stage expired before the transfer completed");
        return undefined;
    }

    return stage;
}

function stageW600WeeklyScheduleUpload(entity, draft, image, operation, recordCount, publish) {
    const storeKey = getDeviceStoreKey(entity);
    const uploadId = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;

    globalStore.putValue(storeKey, WEEKLY_SCHEDULE_DRAFT_STORE_KEY, draft);
    globalStore.putValue(storeKey, WEEKLY_SCHEDULE_OTA_STAGE_STORE_KEY, {
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        image,
        operation,
        recordCount,
        uploadId,
    });
    armW600WeeklyScheduleUploadTimeout(storeKey, uploadId, publish);
    return updateW600WeeklyScheduleUploadState(storeKey, {status: "staged", error: "", operation, recordCount, uploadId});
}

function getNumericOtaRequestField(data, key) {
    const value = data?.[key];

    if (value == null) {
        return undefined;
    }

    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
}

function matchesW600WeeklyScheduleOtaRequest(data, requireFileVersion = false) {
    if (
        getNumericOtaRequestField(data, "manufacturerCode") !== manufacturerCode ||
        getNumericOtaRequestField(data, "imageType") !== W600_WEEKLY_SCHEDULE_IMAGE_TYPE
    ) {
        return false;
    }

    return !requireFileVersion || getNumericOtaRequestField(data, "fileVersion") === W600_WEEKLY_SCHEDULE_FILE_VERSION;
}

const e = exposes.presets;
const ea = exposes.access;

function parseW600ScheduleEnabled(value) {
    if (value === 1 || value === true) {
        return true;
    }

    if (value === 0 || value === false) {
        return false;
    }

    if (typeof value === "string") {
        const normalized = value.toLowerCase();

        if (normalized === "on") {
            return true;
        }

        if (normalized === "off") {
            return false;
        }
    }

    return undefined;
}

function parseW600BinaryEnabled(value) {
    if (value === 1 || value === true) {
        return true;
    }

    if (value === 0 || value === false) {
        return false;
    }

    if (typeof value === "string") {
        const normalized = value.toLowerCase();

        if (normalized === "on") {
            return true;
        }

        if (normalized === "off") {
            return false;
        }
    }

    return undefined;
}

function parseRequiredW600BinaryEnabled(value, key) {
    const enabled = parseW600BinaryEnabled(value);

    if (enabled == null) {
        throw new Error(`${key} must be one of: ON, OFF`);
    }

    return enabled;
}

function deriveW600SystemMode({heatingEnabled, scheduleEnabled, hold}) {
    if (heatingEnabled === false) {
        return "off";
    }

    if (heatingEnabled === true && scheduleEnabled === true && hold === false) {
        return "auto";
    }

    if (heatingEnabled === true) {
        return "heat";
    }

    return undefined;
}

function w600Thermostat() {
    const extend = m.thermostat({
        localTemperature: {values: {description: "Current temperature measured by the internal or external sensor"}},
        setpoints: {
            values: {occupiedHeatingSetpoint: {min: 5, max: 30, step: 0.5}},
        },
        localTemperatureCalibration: {values: {min: -5, max: 5, step: 0.1}},
        temperatureSetpointHold: true,
        temperatureSetpointHoldDuration: true,
    });

    const climateExpose = findClimateExpose(extend);
    climateExpose?.withSystemMode(["off", "heat", "auto"], ea.STATE_SET, "AUTO follows the weekly schedule, HEAT is manual override");
    climateExpose?.withPreset(PRESET_ORDER, "Selected preset scene");
    findClimateFeature(climateExpose, "local_temperature_calibration")?.withLabel("Temperature offset");
    findExpose(extend, "temperature_setpoint_hold")
        ?.withLabel("Manual Override")
        .withCategory("config")
        .withDescription("When true and AUTO mode is active, the current occupied heating setpoint is held based on 'Manual Override Duration'");
    findExpose(extend, "temperature_setpoint_hold_duration")
        ?.withLabel("Manual Override Duration")
        .withUnit("min")
        .withCategory("config")
        .withDescription("Duration in minutes for the current manual override. 0 means until next schedule event, 65535 means indefinitely.");

    replaceToZigbeeConverter(extend, "occupied_heating_setpoint", {
        key: ["occupied_heating_setpoint"],
        options: tz.thermostat_occupied_heating_setpoint.options,
        convertSet: async (entity, key, value, meta) => {
            const result = await tz.thermostat_occupied_heating_setpoint.convertSet(entity, key, value, meta);
            await entity.write(CLUSTER_THERMOSTAT, {tempSetpointHold: 1});
            globalStore.putValue(getDeviceStoreKey(entity), MANUAL_CUSTOM_PRESET_STORE_KEY, true);
            return {state: {...(result?.state ?? {}), temperature_setpoint_hold: true, preset: "none", system_mode: "heat"}};
        },
        convertGet: tz.thermostat_occupied_heating_setpoint.convertGet,
    });

    replaceToZigbeeConverter(extend, "temperature_setpoint_hold", {
        key: ["temperature_setpoint_hold"],
        convertSet: async (entity, key, value, meta) => {
            const hold = value === true || value === 1 || value === "true";
            await entity.write(CLUSTER_THERMOSTAT, {tempSetpointHold: hold ? 1 : 0});
            const heatingEnabled = meta.state?.system_mode !== "off";
            const scheduleEnabled = parseW600ScheduleEnabled(meta.state?.schedule);

            if (!hold) {
                globalStore.putValue(getDeviceStoreKey(entity), MANUAL_CUSTOM_PRESET_STORE_KEY, false);
                const systemMode = deriveW600SystemMode({heatingEnabled, scheduleEnabled, hold: false});
                return {state: {temperature_setpoint_hold: false, ...(systemMode ? {system_mode: systemMode} : {})}};
            }

            if (meta.state?.preset === "none") {
                globalStore.putValue(getDeviceStoreKey(entity), MANUAL_CUSTOM_PRESET_STORE_KEY, true);
                return {state: {temperature_setpoint_hold: true, preset: "none", system_mode: "heat"}};
            }

            return {state: {temperature_setpoint_hold: true, system_mode: "heat"}};
        },
        convertGet: async (entity) => {
            await entity.read(CLUSTER_THERMOSTAT, ["tempSetpointHold"]);
        },
    });

    replaceToZigbeeConverter(extend, "temperature_setpoint_hold_duration", {
        key: ["temperature_setpoint_hold_duration"],
        convertSet: async (entity, key, value) => {
            const duration = Number(value);

            if (!Number.isInteger(duration) || duration < 0 || duration > 65535) {
                throw new Error(`${key} must be an integer between 0 and 65535`);
            }

            await entity.write(
                CLUSTER_THERMOSTAT,
                {[ATTR_TEMP_SETPOINT_HOLD_DURATION]: {value: duration, type: Zcl.DataType.UINT16}},
                {writeUndiv: true},
            );
            return {state: {temperature_setpoint_hold_duration: duration}};
        },
        convertGet: async (entity) => {
            await entity.read(CLUSTER_THERMOSTAT, ["tempSetpointHoldDuration"]);
        },
    });

    extend.fromZigbee.push({
        cluster: CLUSTER_THERMOSTAT,
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const deviceKey = getDeviceStoreKey(meta.device);
            const result = {};
            const heatingEnabled = meta.state?.system_mode !== "off";
            const scheduleEnabled = parseW600ScheduleEnabled(meta.state?.schedule);

            if (msg.data.tempSetpointHold === 0) {
                globalStore.putValue(deviceKey, MANUAL_CUSTOM_PRESET_STORE_KEY, false);
            }

            const hold = msg.data.tempSetpointHold !== undefined ? msg.data.tempSetpointHold === 1 : meta.state?.temperature_setpoint_hold;
            const setpoint =
                typeof msg.data.occupiedHeatingSetpoint === "number" ? msg.data.occupiedHeatingSetpoint / 100 : meta.state?.occupied_heating_setpoint;
            const presetName = meta.state?.preset;
            const manualCustomActive =
                globalStore.getValue(deviceKey, MANUAL_CUSTOM_PRESET_STORE_KEY, false) ||
                inferManualCustomPreset(meta, deviceKey, hold, setpoint, presetName);

            if (manualCustomActive && hold === true) {
                globalStore.putValue(deviceKey, MANUAL_CUSTOM_PRESET_STORE_KEY, true);
                result.preset = "none";
            }

            if (msg.data.tempSetpointHold !== undefined) {
                const systemMode = deriveW600SystemMode({heatingEnabled, scheduleEnabled, hold});

                if (systemMode) {
                    result.system_mode = systemMode;
                }
            }

            return Object.keys(result).length > 0 ? result : undefined;
        },
    });

    extend.fromZigbee.push({
        cluster: CLUSTER_LUMI,
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const result = {};
            const deviceKey = getDeviceStoreKey(meta.device);
            const hold =
                typeof meta.state?.temperature_setpoint_hold === "boolean"
                    ? meta.state.temperature_setpoint_hold
                    : meta.state?.temperature_setpoint_hold === 1 || meta.state?.temperature_setpoint_hold === "true";
            const heatingEnabled = msg.data[ATTR_SYSTEM_MODE] !== undefined ? msg.data[ATTR_SYSTEM_MODE] === 1 : meta.state?.system_mode !== "off";
            const scheduleEnabled =
                msg.data[ATTR_SCHEDULE] !== undefined ? msg.data[ATTR_SCHEDULE] === 1 : parseW600ScheduleEnabled(meta.state?.schedule);

            if (msg.data[ATTR_SYSTEM_MODE] !== undefined || msg.data[ATTR_SCHEDULE] !== undefined) {
                const systemMode = deriveW600SystemMode({heatingEnabled, scheduleEnabled, hold});

                if (systemMode) {
                    result.system_mode = systemMode;
                }
            }

            if (Object.hasOwn(SENSOR_SOURCE_BY_VALUE, msg.data[ATTR_SENSOR_SOURCE])) {
                result.sensor_source = SENSOR_SOURCE_BY_VALUE[msg.data[ATTR_SENSOR_SOURCE]];
            }

            if (Object.hasOwn(PRESET_BY_ID, msg.data[ATTR_PRESET])) {
                if (msg.data[ATTR_PRESET] === 255 && hold === true) {
                    globalStore.putValue(deviceKey, MANUAL_CUSTOM_PRESET_STORE_KEY, true);
                }

                if (globalStore.getValue(deviceKey, MANUAL_CUSTOM_PRESET_STORE_KEY, false) && hold === true) {
                    result.preset = "none";
                } else {
                    result.preset = PRESET_BY_ID[msg.data[ATTR_PRESET]];
                }
            }

            return Object.keys(result).length > 0 ? result : undefined;
        },
    });

    extend.toZigbee.push(
        {
            key: ["system_mode"],
            convertSet: async (entity, key, value) => {
                const normalized = parseEnumName(value, {off: 0, heat: 1, auto: 2}, key);
                const deviceKey = getDeviceStoreKey(entity);

                if (normalized === "off") {
                    await writeLumiAttribute(entity, ATTR_SYSTEM_MODE, 0);
                    return {state: {system_mode: "off"}};
                }

                await writeLumiAttribute(entity, ATTR_SYSTEM_MODE, 1);

                if (normalized === "auto") {
                    await writeLumiAttribute(entity, ATTR_SCHEDULE, 1);
                    await entity.write(CLUSTER_THERMOSTAT, {tempSetpointHold: 0});
                    globalStore.putValue(deviceKey, MANUAL_CUSTOM_PRESET_STORE_KEY, false);
                    return {state: {system_mode: "auto", schedule: "ON", temperature_setpoint_hold: false}};
                }

                await entity.write(CLUSTER_THERMOSTAT, {tempSetpointHold: 1});
                return {state: {system_mode: "heat", temperature_setpoint_hold: true}};
            },
            convertGet: async (entity) => {
                await readLumiAttribute(entity, ATTR_SYSTEM_MODE);
                await readLumiAttribute(entity, ATTR_SCHEDULE);
                await entity.read(CLUSTER_THERMOSTAT, ["tempSetpointHold"]);
            },
        },
        {
            key: ["preset"],
            convertSet: async (entity, key, value) => {
                const normalized = parseEnumName(value, {none: 0, ...PRESET_ID_BY_NAME}, key);
                const deviceKey = getDeviceStoreKey(entity);

                if (normalized === "none") {
                    await entity.write(CLUSTER_THERMOSTAT, {tempSetpointHold: 1});
                    globalStore.putValue(deviceKey, MANUAL_CUSTOM_PRESET_STORE_KEY, true);
                    return {state: {temperature_setpoint_hold: true, preset: "none", system_mode: "heat"}};
                }

                await entity.write(CLUSTER_THERMOSTAT, {tempSetpointHold: 1});
                await writeLumiAttribute(entity, ATTR_PRESET, PRESET_ID_BY_NAME[normalized]);
                globalStore.putValue(deviceKey, MANUAL_CUSTOM_PRESET_STORE_KEY, false);

                return {state: {preset: normalized, temperature_setpoint_hold: true, system_mode: "heat"}};
            },
            convertGet: async (entity) => {
                await readLumiAttribute(entity, ATTR_PRESET);
            },
        },
    );

    extend.configure.push(async (device) => {
        const endpoint = device.getEndpoint(1);
        await safeRead(endpoint, CLUSTER_LUMI, [ATTR_SYSTEM_MODE, ATTR_SCHEDULE, ATTR_SENSOR_SOURCE, ATTR_PRESET], {manufacturerCode});
        await safeRead(endpoint, CLUSTER_THERMOSTAT, ["tempSetpointHold"]);
    });

    return extend;
}

function w600ExternalTempSensor() {
    return {
        exposes: [
            e
                .enum("sensor_source", ea.ALL, ["internal", "external"])
                .withLabel("Temperature source")
                .withDescription("Choose whether the thermostat uses its internal sensor or data provided via 'External Sensor Temperature'")
                .withCategory("config"),
            e
                .text("external_sensor_ieee", ea.ALL)
                .withLabel("External Temperature Sensor IEEE Address")
                .withDescription(
                    "Valid IEEE address required when sensor_source is external. Not needed to be a real address. Must be set before switching sensor_source to external.",
                )
                .withCategory("config"),
            e
                .external_temperature_input()
                .withLabel("External Sensor Temperature")
                .withValueStep(0.01)
                .withDescription("Manual external temperature forwarded to the W600 for the currently selected external sensor")
                .withCategory("config"),
        ],
        fromZigbee: [
            {
                cluster: CLUSTER_LUMI,
                type: ["attributeReport", "readResponse"],
                convert: (model, msg, publish, options, meta) => {
                    const result = {};
                    const cachedExternalSensorIeee = getCachedExternalSensorIeee(meta.device, meta);
                    const binding = decodeW600ExternalTempSensorBinding(msg.data[ATTR_SENSOR_BINDING]);

                    if (msg.data[ATTR_SENSOR_SOURCE] === 0) {
                        result.external_sensor_ieee = cachedExternalSensorIeee ?? "";
                    }

                    if (binding) {
                        globalStore.putValue(getDeviceStoreKey(meta.device), EXTERNAL_SENSOR_IEEE_STORE_KEY, binding.sensorIeeeAddress);
                        result.external_sensor_ieee = binding.sensorIeeeAddress;
                    } else if (msg.data[ATTR_SENSOR_SOURCE] === 1 && !cachedExternalSensorIeee) {
                        scheduleW600SensorBindingRefresh(meta.device, "external temperature source reported without binding payload");
                    }

                    return Object.keys(result).length > 0 ? result : undefined;
                },
            },
        ],
        toZigbee: [
            {
                key: ["sensor_source"],
                convertSet: async (entity, key, value, meta) => {
                    const normalized = parseEnumName(value, {internal: 0, external: 1}, key);

                    if (normalized === "external") {
                        const sensorIeeeAddress =
                            meta.message?.external_sensor_ieee != null
                                ? normalizeIeeeAddress(meta.message.external_sensor_ieee, "external_sensor_ieee")
                                : getCachedExternalSensorIeee(entity, meta);

                        if (!sensorIeeeAddress) {
                            throw new Error("external_sensor_ieee must be set before switching sensor_source to external");
                        }

                        await writeLumiAttribute(
                            entity,
                            ATTR_SENSOR_BINDING,
                            buildW600ExternalTempSensorBindPayload(entity, sensorIeeeAddress, meta),
                            Zcl.DataType.OCTET_STR,
                        );
                        await writeLumiAttribute(entity, ATTR_SENSOR_SOURCE, 1);
                        globalStore.putValue(getDeviceStoreKey(entity), EXTERNAL_SENSOR_IEEE_STORE_KEY, sensorIeeeAddress);

                        return {state: {sensor_source: "external", external_sensor_ieee: sensorIeeeAddress}};
                    }

                    await writeLumiAttribute(entity, ATTR_SENSOR_SOURCE, 0);
                    await writeLumiAttribute(
                        entity,
                        ATTR_SENSOR_BINDING,
                        buildW600ExternalTempSensorUnbindPayload(entity, meta),
                        Zcl.DataType.OCTET_STR,
                    );

                    const sensorIeeeAddress =
                        meta.message?.external_sensor_ieee != null
                            ? normalizeIeeeAddress(meta.message.external_sensor_ieee, "external_sensor_ieee")
                            : (getCachedExternalSensorIeee(entity, meta) ?? "");

                    if (sensorIeeeAddress !== "") {
                        globalStore.putValue(getDeviceStoreKey(entity), EXTERNAL_SENSOR_IEEE_STORE_KEY, sensorIeeeAddress);
                    }

                    return {state: {sensor_source: "internal", external_sensor_ieee: sensorIeeeAddress}};
                },
                convertGet: async (entity) => {
                    await readLumiAttribute(entity, ATTR_SENSOR_SOURCE);
                    await readLumiAttribute(entity, ATTR_SENSOR_BINDING);
                },
            },
            {
                key: ["external_sensor_ieee"],
                convertSet: async (entity, key, value, meta) => {
                    const sensorIeeeAddress = normalizeIeeeAddress(value, key);
                    globalStore.putValue(getDeviceStoreKey(entity), EXTERNAL_SENSOR_IEEE_STORE_KEY, sensorIeeeAddress);

                    if (meta.state?.sensor_source === "external" || meta.message?.sensor_source === "external") {
                        await writeLumiAttribute(
                            entity,
                            ATTR_SENSOR_BINDING,
                            buildW600ExternalTempSensorBindPayload(entity, sensorIeeeAddress, meta),
                            Zcl.DataType.OCTET_STR,
                        );
                    }

                    return {state: {external_sensor_ieee: sensorIeeeAddress}};
                },
                convertGet: async (entity) => {
                    await readLumiAttribute(entity, ATTR_SENSOR_BINDING);
                },
            },
            {
                key: ["external_temperature_input"],
                convertSet: async (entity, key, value, meta) => {
                    const requestedSensorSource = meta.message?.sensor_source;
                    const sensorSource = requestedSensorSource ?? meta.state?.sensor_source;
                    const shouldReassertExternalSource = sensorSource !== "external" && requestedSensorSource == null;

                    if (sensorSource !== "external" && !shouldReassertExternalSource) {
                        throw new Error("external_temperature_input can only be used when sensor_source is external");
                    }

                    const sensorIeeeAddress =
                        meta.message?.external_sensor_ieee != null
                            ? normalizeIeeeAddress(meta.message.external_sensor_ieee, "external_sensor_ieee")
                            : getCachedExternalSensorIeee(entity, meta);

                    if (!sensorIeeeAddress) {
                        throw new Error("external_sensor_ieee must be set before sending external_temperature_input");
                    }

                    if (shouldReassertExternalSource) {
                        await writeLumiAttribute(
                            entity,
                            ATTR_SENSOR_BINDING,
                            buildW600ExternalTempSensorBindPayload(entity, sensorIeeeAddress, meta),
                            Zcl.DataType.OCTET_STR,
                        );
                        await writeLumiAttribute(entity, ATTR_SENSOR_SOURCE, 1);
                        globalStore.putValue(getDeviceStoreKey(entity), EXTERNAL_SENSOR_IEEE_STORE_KEY, sensorIeeeAddress);
                    }

                    const centiDegrees = parseExternalTemperatureInput(value, key);
                    await writeLumiAttribute(
                        entity,
                        ATTR_SENSOR_BINDING,
                        buildW600ExternalTemperaturePayload(entity, sensorIeeeAddress, centiDegrees),
                        Zcl.DataType.OCTET_STR,
                    );

                    return {
                        state: {
                            external_temperature_input: centiDegrees / 100,
                            ...(shouldReassertExternalSource ? {sensor_source: "external", external_sensor_ieee: sensorIeeeAddress} : {}),
                        },
                    };
                },
            },
        ],
        configure: [
            async (device) => {
                const endpoint = device.getEndpoint(1);
                await safeRead(endpoint, CLUSTER_LUMI, [ATTR_SENSOR_BINDING], {manufacturerCode});
            },
        ],
        isModernExtend: true,
    };
}

function w600WindowSensor() {
    return {
        exposes: [
            e
                .enum("window_detection_mode", ea.ALL, ["temperature_difference", "external_sensor"])
                .withLabel("Window detection mode")
                .withDescription("Choose the window detection mode that will be armed the next time window_detection is turned ON")
                .withCategory("config"),
            e
                .text("window_sensor_ieee", ea.ALL)
                .withLabel("External Window Sensor IEEE Address")
                .withDescription(
                    "IEEE address used when window_detection_mode is external_sensor. If window_detection is enabled without an address, it falls back to temperature_difference.",
                )
                .withCategory("config"),
            e
                .enum("window_sensor_state", ea.ALL, ["closed", "open"])
                .withLabel("External Window Sensor State")
                .withDescription("Manual state forwarded to the W600 for the linked window sensor")
                .withCategory("config"),
        ],
        fromZigbee: [
            {
                cluster: CLUSTER_LUMI,
                type: ["attributeReport", "readResponse"],
                convert: (model, msg, publish, options, meta) => {
                    const result = {};
                    const deviceKey = getDeviceStoreKey(meta.device);
                    const cachedMode = getCachedWindowDetectionMode(meta.device, meta);
                    const cachedWindowSensorIeee = getCachedWindowSensorIeee(meta.device, meta);
                    const cachedWindowSensorState = getCachedWindowSensorState(meta.device, meta);
                    const armingInProgress = isW600WindowSensorArmingInProgress(meta.device);
                    const sensorBindingPayload = msg.data[ATTR_SENSOR_BINDING];
                    const binding = decodeW600WindowSensorBinding(sensorBindingPayload);
                    const valueReport = decodeW600WindowSensorValueReport(sensorBindingPayload);
                    const acknowledgement = decodeW600WindowSensorAcknowledgement(sensorBindingPayload);
                    const activationAcknowledgement = decodeW600WindowSensorActivationAcknowledgement(sensorBindingPayload);
                    const passiveExternalWindowSensorObservation = binding != null || valueReport != null || acknowledgement != null;
                    let externalModeConfirmed = cachedMode === "external_sensor" && !armingInProgress;
                    let observedWindowSensorIeee = cachedWindowSensorIeee;

                    const observeExternalWindowSensor = (sensorIeeeAddress) => {
                        observedWindowSensorIeee = sensorIeeeAddress;

                        cacheW600ObservedWindowSensor(deviceKey, sensorIeeeAddress);

                        if (externalModeConfirmed) {
                            applyW600ExternalWindowSensorState(result, sensorIeeeAddress, cachedWindowSensorState);
                        } else {
                            applyW600ObservedWindowSensorState(result, sensorIeeeAddress);
                        }
                    };

                    const confirmExternalWindowSensorMode = (sensorIeeeAddress = observedWindowSensorIeee) => {
                        if (!sensorIeeeAddress) {
                            return;
                        }

                        externalModeConfirmed = true;
                        cacheW600ExternalWindowSensor(deviceKey, sensorIeeeAddress, cachedWindowSensorState);
                        applyW600ExternalWindowSensorState(result, sensorIeeeAddress, cachedWindowSensorState);
                    };

                    if (binding) {
                        observeExternalWindowSensor(binding.sensorIeeeAddress);

                        if (binding.bindingType === "state") {
                            markW600WindowSensorArmingProgressSignal(deviceKey);
                        }
                    }

                    if (valueReport) {
                        observeExternalWindowSensor(valueReport.sensorIeeeAddress);

                        if (valueReport.reportType === "state") {
                            markW600WindowSensorArmingProgressSignal(deviceKey);
                        }
                    }

                    if (acknowledgement) {
                        observeExternalWindowSensor(acknowledgement.sensorIeeeAddress);
                    }

                    if (activationAcknowledgement?.stage === "bind_ack") {
                        markW600WindowSensorArmingProgressSignal(deviceKey);
                    }

                    if (activationAcknowledgement?.stage === "activation_complete") {
                        markW600WindowSensorArmingProgressSignal(deviceKey);
                        markW600WindowSensorActivationCompleteSignal(deviceKey);
                        confirmExternalWindowSensorMode();
                    }

                    if (
                        msg.data[ATTR_WINDOW_DETECTION] === 1 &&
                        !observedWindowSensorIeee &&
                        (cachedMode === "external_sensor" || sensorBindingPayload == null)
                    ) {
                        scheduleW600SensorBindingRefresh(meta.device, "window detection enabled without sensor binding payload");
                    }

                    // During a fresh Z2M interview the TRV can return only passive binding/acknowledgement payloads.
                    // Treat these as enough evidence that an external window sensor mode is configured so state self-heals
                    // even when the original binding was performed out-of-band.
                    if (
                        !externalModeConfirmed &&
                        !armingInProgress &&
                        cachedMode == null &&
                        passiveExternalWindowSensorObservation &&
                        observedWindowSensorIeee
                    ) {
                        confirmExternalWindowSensorMode(observedWindowSensorIeee);
                    }

                    if (result.window_detection_mode == null && msg.data[ATTR_WINDOW_DETECTION] !== undefined) {
                        globalStore.putValue(deviceKey, WINDOW_DETECTION_ENABLED_STORE_KEY, msg.data[ATTR_WINDOW_DETECTION] === 1);

                        if (cachedMode) {
                            result.window_detection_mode = cachedMode;
                        } else if (msg.data[ATTR_WINDOW_DETECTION] === 1) {
                            cacheW600WindowSensorMode(deviceKey, "temperature_difference");
                            result.window_detection_mode = "temperature_difference";
                        }
                    }

                    if (result.window_detection_mode === "external_sensor") {
                        result.window_sensor_ieee = result.window_sensor_ieee ?? cachedWindowSensorIeee ?? "";
                    }

                    if (result.window_detection_mode === "temperature_difference") {
                        result.window_sensor_ieee = cachedWindowSensorIeee ?? "";
                    }

                    if (result.window_sensor_state == null) {
                        result.window_sensor_state = cachedWindowSensorState;
                    }

                    return Object.keys(result).length > 0 ? result : undefined;
                },
            },
        ],
        toZigbee: [
            {
                key: ["window_detection_mode"],
                convertSet: async (entity, key, value, meta) => {
                    if (meta.message?.window_detection != null) {
                        return;
                    }

                    const normalized = parseEnumName(value, WINDOW_DETECTION_MODE_BY_VALUE, key);
                    const deviceKey = getDeviceStoreKey(entity);

                    if (getCachedWindowDetectionEnabled(entity, meta) !== true) {
                        cacheW600WindowSensorMode(deviceKey, normalized);
                        return {
                            state: buildWindowDetectionState(
                                false,
                                normalized,
                                getRequestedWindowSensorIeee(entity, meta),
                                getRequestedWindowSensorState(entity, meta),
                            ),
                        };
                    }

                    const arming = await armW600WindowDetectionMode(entity, normalized, meta);
                    return {
                        state: buildWindowDetectionState(true, arming.windowDetectionMode, arming.windowSensorIeee, arming.windowSensorState),
                    };
                },
                convertGet: async (entity) => {
                    await readLumiAttribute(entity, ATTR_SENSOR_BINDING);
                },
            },
            {
                key: ["window_sensor_ieee"],
                convertSet: async (entity, key, value, meta) => {
                    if (meta.message?.window_detection != null || meta.message?.window_detection_mode != null) {
                        return;
                    }

                    const sensorIeeeAddress = normalizeIeeeAddress(value, key);
                    cacheW600WindowSensorIeee(entity, sensorIeeeAddress);

                    if (getCachedWindowDetectionEnabled(entity, meta) !== true) {
                        return {state: {window_sensor_ieee: sensorIeeeAddress}};
                    }

                    if (getCachedWindowDetectionMode(entity, meta) === "external_sensor") {
                        const arming = await armW600WindowDetectionMode(entity, "external_sensor", meta);
                        return {
                            state: buildWindowDetectionState(true, arming.windowDetectionMode, arming.windowSensorIeee, arming.windowSensorState),
                        };
                    }

                    return {state: {window_sensor_ieee: sensorIeeeAddress}};
                },
                convertGet: async (entity) => {
                    await readLumiAttribute(entity, ATTR_SENSOR_BINDING);
                },
            },
            {
                key: ["window_sensor_state"],
                convertSet: async (entity, key, value, meta) => {
                    if (meta.message?.window_detection != null || meta.message?.window_detection_mode != null) {
                        return;
                    }

                    const windowSensorState = parseWindowSensorState(value, key);
                    const requestedMode =
                        meta.message?.window_detection_mode != null
                            ? parseEnumName(meta.message.window_detection_mode, WINDOW_DETECTION_MODE_BY_VALUE, "window_detection_mode")
                            : getCachedWindowDetectionMode(entity, meta);
                    const deviceKey = getDeviceStoreKey(entity);

                    if (requestedMode !== "external_sensor") {
                        cacheW600WindowSensorState(deviceKey, windowSensorState);
                        return {state: {window_sensor_state: windowSensorState}};
                    }

                    const sensorIeeeAddress =
                        meta.message?.window_sensor_ieee != null
                            ? normalizeIeeeAddress(meta.message.window_sensor_ieee, "window_sensor_ieee")
                            : getCachedWindowSensorIeee(entity, meta);

                    if (!sensorIeeeAddress) {
                        throw new Error("window_sensor_ieee must be set before sending window_sensor_state");
                    }

                    if (getCachedWindowDetectionEnabled(entity, meta) !== true) {
                        cacheW600WindowSensorState(deviceKey, windowSensorState);
                        return {state: {window_sensor_state: windowSensorState}};
                    }

                    await writeW600WindowSensorStateUpdate(entity, sensorIeeeAddress, windowSensorState, {
                        includeAvailability: windowSensorState === "closed",
                        stateWriteCount: 1,
                        restartStateKeepalive: true,
                    });

                    cacheW600WindowSensorState(deviceKey, windowSensorState);
                    return {state: {window_sensor_state: windowSensorState}};
                },
                convertGet: async (entity) => {
                    await readLumiAttribute(entity, ATTR_SENSOR_BINDING);
                },
            },
        ],
        configure: [
            async (device) => {
                const endpoint = device.getEndpoint(1);
                await safeRead(endpoint, CLUSTER_LUMI, [ATTR_SENSOR_BINDING], {manufacturerCode});
            },
        ],
        isModernExtend: true,
    };
}

function w600PresetTemperatureTable() {
    const exposes = PRESET_TEMPERATURE_DEFINITIONS.map(({property, label, description}) =>
        e
            .numeric(property, ea.ALL)
            .withLabel(label)
            .withValueMin(5)
            .withValueMax(30)
            .withValueStep(0.5)
            .withUnit("°C")
            .withDescription(description)
            .withCategory("config"),
    );

    const fromZigbee = [
        {
            cluster: CLUSTER_LUMI,
            type: ["attributeReport", "readResponse"],
            convert: (model, msg, publish, options, meta) => {
                const value = msg.data[ATTR_PRESET_TEMPERATURE_TABLE];

                if (!Buffer.isBuffer(value) || value.length === 0) {
                    return;
                }

                const table = decodePresetTemperatureTable(value);

                if (!table) {
                    return;
                }

                globalStore.putValue(getDeviceStoreKey(meta.device), PRESET_TABLE_STORE_KEY, table);
                const result = {};
                for (const [presetName, centiDegrees] of Object.entries(table)) {
                    result[PROPERTY_BY_PRESET_NAME[presetName]] = centiDegrees / 100;
                }

                return result;
            },
        },
    ];

    const toZigbee = [
        {
            key: PRESET_TEMPERATURE_DEFINITIONS.map(({property}) => property),
            convertSet: async (entity, key, value, meta) => {
                const presetName = PRESET_NAME_BY_PROPERTY[key];
                const table = getCachedPresetTemperatureTable(entity, meta);

                if (!table) {
                    throw new Error("Preset temperature table is unknown. Read the preset temperature properties first.");
                }

                table[presetName] = parseHalfDegreeTemperature(value, key, 5, 30);

                await writeLumiAttribute(entity, ATTR_PRESET_TEMPERATURE_TABLE, encodePresetTemperatureTable(table), Zcl.DataType.OCTET_STR);
                globalStore.putValue(getDeviceStoreKey(entity), PRESET_TABLE_STORE_KEY, table);

                return {state: {[key]: table[presetName] / 100}};
            },
            convertGet: async (entity) => {
                await readLumiAttribute(entity, ATTR_PRESET_TEMPERATURE_TABLE);
            },
        },
    ];

    const configure = [
        async (device) => {
            const endpoint = device.getEndpoint(1);
            await safeRead(endpoint, CLUSTER_LUMI, [ATTR_PRESET_TEMPERATURE_TABLE], {manufacturerCode});
        },
    ];

    return {exposes, fromZigbee, toZigbee, configure, isModernExtend: true};
}

function w600WeeklySchedule() {
    const dayDescription =
        "Staged weekly schedule for this day. Use comma-delimited entries in the format HH:MM/preset, for example '08:00/home, 19:00/vacation.' " +
        "Editing the text fields does not upload anything until Save schedule is triggered.";
    const uploadStatusDescription = "Current state of the custom OTA transfer used to upload the weekly schedule to the thermostat.";

    const onEvent = [
        (event) => {
            const shouldSeedDraft =
                event.type === "start" ||
                event.type === "deviceJoined" ||
                (event.type === "deviceInterview" && (event.data.status === "started" || event.data.status === "successful"));

            if (!shouldSeedDraft) {
                return;
            }

            seedW600WeeklyScheduleDraftState(event.data.device, event.data.state);

            const uploadState = normalizeW600WeeklyScheduleUploadState(
                globalStore.getValue(getDeviceStoreKey(event.data.device), WEEKLY_SCHEDULE_UPLOAD_STATE_STORE_KEY),
            );

            globalStore.putValue(getDeviceStoreKey(event.data.device), WEEKLY_SCHEDULE_UPLOAD_STATE_STORE_KEY, uploadState);
            event.data.state.schedule_upload_status = uploadState.status;

            if (event.type === "start") {
                const endpoint = event.data.device.getEndpoint(1);
                void safeRead(endpoint, CLUSTER_LUMI, [ATTR_SCHEDULE], {manufacturerCode});
            }
        },
    ];

    return {
        exposes: [
            ...W600_WEEKLY_SCHEDULE_DAY_DEFINITIONS.map(({label, property}) =>
                e.text(property, ea.STATE_SET).withLabel(`${label} schedule`).withDescription(dayDescription).withCategory("config"),
            ),
            e
                .enum("schedule_upload_status", ea.STATE, W600_WEEKLY_SCHEDULE_UPLOAD_STATUSES)
                .withLabel("Schedule upload status")
                .withDescription(uploadStatusDescription)
                .withCategory("diagnostic"),
            e
                .enum("save_schedule", ea.SET, ["trigger"])
                .withLabel("Save schedule")
                .withDescription("Upload the weekly schedule to the thermostat")
                .withCategory("config"),
            e
                .enum("clear_schedule", ea.SET, ["trigger"])
                .withLabel("Clear schedule")
                .withDescription("Clear all weekly schedule inputs and upload an empty schedule to the thermostat")
                .withCategory("config"),
        ],
        fromZigbee: [
            {
                cluster: CLUSTER_LUMI,
                type: ["attributeReport", "readResponse"],
                convert: (model, msg, publish, options, meta) => {
                    if (msg.data[ATTR_SCHEDULE] === undefined) {
                        return;
                    }

                    return getW600WeeklyScheduleUploadStatePayload(meta.device);
                },
            },
            {
                cluster: "genOta",
                type: ["commandQueryNextImageRequest"],
                convert: async (model, msg, publish, options, meta) => {
                    const stage = getActiveW600WeeklyScheduleOtaStage(meta.device);

                    if (!stage) {
                        return;
                    }

                    if (!matchesW600WeeklyScheduleOtaRequest(msg.data)) {
                        await msg.endpoint.commandResponse(
                            "genOta",
                            "queryNextImageResponse",
                            {status: Zcl.Status.NO_IMAGE_AVAILABLE},
                            undefined,
                            msg.meta.zclTransactionSequenceNumber,
                        );
                        return;
                    }

                    markW600WeeklyScheduleUploadStarted(meta.device, publish);
                    await msg.endpoint.commandResponse(
                        "genOta",
                        "queryNextImageResponse",
                        {
                            status: Zcl.Status.SUCCESS,
                            manufacturerCode,
                            imageType: W600_WEEKLY_SCHEDULE_IMAGE_TYPE,
                            fileVersion: W600_WEEKLY_SCHEDULE_FILE_VERSION,
                            imageSize: stage.image.length,
                        },
                        undefined,
                        msg.meta.zclTransactionSequenceNumber,
                    );
                },
            },
            {
                cluster: "genOta",
                type: ["commandImageBlockRequest"],
                convert: async (model, msg, publish, options, meta) => {
                    const stage = getActiveW600WeeklyScheduleOtaStage(meta.device);

                    if (!stage) {
                        return;
                    }

                    if (!matchesW600WeeklyScheduleOtaRequest(msg.data, true)) {
                        await msg.endpoint.commandResponse(
                            "genOta",
                            "imageBlockResponse",
                            {status: Zcl.Status.INVALID_IMAGE},
                            undefined,
                            msg.meta.zclTransactionSequenceNumber,
                        );
                        return;
                    }

                    markW600WeeklyScheduleUploadStarted(meta.device, publish);
                    const fileOffset = Number(msg.data.fileOffset);
                    const maximumDataSize = Number(msg.data.maximumDataSize);

                    if (
                        !Number.isInteger(fileOffset) ||
                        !Number.isInteger(maximumDataSize) ||
                        fileOffset < 0 ||
                        maximumDataSize <= 0 ||
                        fileOffset >= stage.image.length
                    ) {
                        failW600WeeklyScheduleUpload(
                            meta.device,
                            `Received invalid image block request (offset=${String(msg.data.fileOffset)}, maximumDataSize=${String(msg.data.maximumDataSize)})`,
                            publish,
                        );
                        await msg.endpoint.commandResponse(
                            "genOta",
                            "imageBlockResponse",
                            {status: Zcl.Status.ABORT},
                            undefined,
                            msg.meta.zclTransactionSequenceNumber,
                        );
                        return;
                    }

                    const chunk = stage.image.subarray(fileOffset, Math.min(stage.image.length, fileOffset + maximumDataSize));
                    noteW600WeeklyScheduleUploadBlock(meta.device, publish);
                    await msg.endpoint.commandResponse(
                        "genOta",
                        "imageBlockResponse",
                        {
                            status: Zcl.Status.SUCCESS,
                            manufacturerCode,
                            imageType: W600_WEEKLY_SCHEDULE_IMAGE_TYPE,
                            fileVersion: W600_WEEKLY_SCHEDULE_FILE_VERSION,
                            fileOffset,
                            dataSize: chunk.length,
                            data: chunk,
                        },
                        undefined,
                        msg.meta.zclTransactionSequenceNumber,
                    );
                },
            },
            {
                cluster: "genOta",
                type: ["commandUpgradeEndRequest"],
                convert: async (model, msg, publish, options, meta) => {
                    const stage = getActiveW600WeeklyScheduleOtaStage(meta.device);

                    if (!stage) {
                        return;
                    }

                    if (!matchesW600WeeklyScheduleOtaRequest(msg.data, true)) {
                        return;
                    }

                    const upgradeStatus = getNumericOtaRequestField(msg.data, "status");

                    if (upgradeStatus != null && upgradeStatus !== 0) {
                        failW600WeeklyScheduleUpload(meta.device, `Device ended the OTA transfer with status ${String(msg.data.status)}`, publish);
                        return;
                    }

                    await msg.endpoint.commandResponse(
                        "genOta",
                        "upgradeEndResponse",
                        {
                            manufacturerCode,
                            imageType: W600_WEEKLY_SCHEDULE_IMAGE_TYPE,
                            fileVersion: W600_WEEKLY_SCHEDULE_FILE_VERSION,
                            currentTime: 0,
                            upgradeTime: 0,
                        },
                        undefined,
                        msg.meta.zclTransactionSequenceNumber,
                    );
                    completeW600WeeklyScheduleUpload(meta.device, publish);
                },
            },
        ],
        toZigbee: [
            {
                key: W600_WEEKLY_SCHEDULE_DAY_PROPERTIES,
                convertSet: (entity, key, value, meta) => {
                    const draft = getCachedW600WeeklyScheduleDraft(entity, meta);
                    const transitions = parseW600ScheduleDayTransitions(value, key);
                    draft[key] = formatW600ScheduleDayTransitions(transitions);
                    globalStore.putValue(getDeviceStoreKey(entity), WEEKLY_SCHEDULE_DRAFT_STORE_KEY, draft);
                    return {state: {[key]: draft[key] === "" ? null : draft[key]}};
                },
            },
            {
                key: ["save_schedule"],
                convertSet: async (entity, key, value, meta) => {
                    parseW600ScheduleTriggerValue(value, key);
                    ensureNoActiveW600WeeklyScheduleUpload(entity);
                    const draft = getCachedW600WeeklyScheduleDraft(entity, meta);

                    for (const property of W600_WEEKLY_SCHEDULE_DAY_PROPERTIES) {
                        if (meta.message?.[property] !== undefined) {
                            draft[property] = meta.message[property];
                        }
                    }

                    const normalized = normalizeW600WeeklyScheduleDraft(draft);
                    const image = buildW600WeeklyScheduleImage(normalized.records);
                    const uploadState = stageW600WeeklyScheduleUpload(
                        entity,
                        normalized.draft,
                        image,
                        "save_schedule",
                        normalized.records.length,
                        meta.publish,
                    );

                    logger.info(
                        `Staged W600 save schedule upload for ${getDeviceStoreKey(entity)} with ${normalized.records.length} entries (${image.length} bytes)`,
                        NS,
                    );

                    try {
                        await entity.commandResponse(
                            "genOta",
                            "imageNotify",
                            {payloadType: 0, queryJitter: W600_WEEKLY_SCHEDULE_IMAGE_NOTIFY_QUERY_JITTER},
                            {sendPolicy: "immediate"},
                        );
                    } catch (error) {
                        const details = error?.message ?? String(error);
                        failW600WeeklyScheduleUpload(entity, `Failed to send imageNotify: ${details}`, meta.publish);
                        throw error;
                    }

                    return {state: {...buildW600WeeklyScheduleStatePayload(normalized.draft), ...uploadState.state}};
                },
            },
            {
                key: ["clear_schedule"],
                convertSet: async (entity, key, value, meta) => {
                    parseW600ScheduleTriggerValue(value, key);
                    ensureNoActiveW600WeeklyScheduleUpload(entity);
                    const draft = createEmptyW600WeeklyScheduleDraft();
                    const image = buildW600WeeklyScheduleImage([]);
                    const uploadState = stageW600WeeklyScheduleUpload(entity, draft, image, "clear_schedule", 0, meta.publish);

                    logger.info(`Staged W600 clear schedule upload for ${getDeviceStoreKey(entity)} (${image.length} bytes)`, NS);

                    try {
                        await entity.commandResponse(
                            "genOta",
                            "imageNotify",
                            {payloadType: 0, queryJitter: W600_WEEKLY_SCHEDULE_IMAGE_NOTIFY_QUERY_JITTER},
                            {sendPolicy: "immediate"},
                        );
                    } catch (error) {
                        const details = error?.message ?? String(error);
                        failW600WeeklyScheduleUpload(entity, `Failed to send imageNotify: ${details}`, meta.publish);
                        throw error;
                    }

                    return {state: {...buildW600WeeklyScheduleStatePayload(draft), ...uploadState.state}};
                },
            },
        ],
        onEvent,
        isModernExtend: true,
    };
}

function w600Identify() {
    return {
        exposes: [e.enum("identify", ea.SET, ["start"]).withDescription("Blink the device for identification").withCategory("config")],
        toZigbee: [
            {
                key: ["identify"],
                convertSet: async (entity, key, value) => {
                    parseEnumName(value, {start: 1}, key);
                    await entity.command("genIdentify", "identify", {identifytime: 1}, {});
                    return {state: {identify: "start"}};
                },
            },
        ],
        isModernExtend: true,
    };
}

function w600Heartbeat() {
    return {
        exposes: [
            e.battery().withDescription("Battery percentage"),
            e
                .battery_voltage()
                .withDescription("Heartbeat-derived battery voltage in millivolts from sub-key 0x17; zero samples are suppressed")
                .withCategory("diagnostic"),
            e
                .valve_alarm()
                .withDescription("Indicates heartbeat status bytecode `0x10xxxxxx`, currently associated with the TRV valve alarm condition"),
            e.window_open().withDescription("Indicates whether the W600 heartbeat reports an active window-open alarm"),
            e
                .text("last_error_status_update", ea.STATE)
                .withLabel("Last error status update")
                .withDescription(
                    "Local wall-clock timestamp decoded from heartbeat sub-key 0x9c bytes 0-3 using the Aqara-style seconds-since-2000 format",
                )
                .withCategory("diagnostic"),
            e
                .text("error_status_bytecode", ea.STATE)
                .withLabel("Error status bytecode")
                .withDescription("Raw lowercase hex from heartbeat sub-key 0x9c bytes 4-7")
                .withCategory("diagnostic"),
        ],
        fromZigbee: [
            {
                cluster: CLUSTER_LUMI,
                type: ["attributeReport", "readResponse"],
                convert: (model, msg, publish, options, meta) => {
                    const value = msg.data[ATTR_HEARTBEAT];

                    if (!Buffer.isBuffer(value)) {
                        return;
                    }

                    const heartbeat = decodeW600Heartbeat(value);
                    if (!heartbeat) {
                        return;
                    }

                    const result = {};

                    if (typeof heartbeat[0x0d] === "number" && Number.isFinite(heartbeat[0x0d])) {
                        meta.device.softwareBuildID = lumi.trv.decodeFirmwareVersionString(heartbeat[0x0d]);
                    }

                    if (typeof heartbeat[0x17] === "number" && Number.isFinite(heartbeat[0x17]) && heartbeat[0x17] > 0) {
                        result.voltage = heartbeat[0x17];
                    }

                    if (typeof heartbeat[0x18] === "number" && Number.isFinite(heartbeat[0x18])) {
                        result.battery = Math.max(0, Math.min(100, heartbeat[0x18]));
                    }

                    if (Buffer.isBuffer(heartbeat[0x9c])) {
                        const heartbeat9c = decodeW600Heartbeat9c(heartbeat[0x9c]);

                        if (heartbeat9c) {
                            result.error_status_bytecode = heartbeat9c.errorStatusBytecode;
                            result.last_error_status_update = heartbeat9c.lastErrorStatusUpdate;

                            if (typeof heartbeat9c.valveAlarm === "boolean") {
                                result.valve_alarm = heartbeat9c.valveAlarm;
                            }

                            if (typeof heartbeat9c.windowOpen === "boolean") {
                                result.window_open = heartbeat9c.windowOpen;
                            }
                        }
                    }

                    return Object.keys(result).length > 0 ? result : undefined;
                },
            },
        ],
        isModernExtend: true,
    };
}

module.exports = {
    zigbeeModel: ["lumi.airrtc.aeu005"],
    model: "WT-A03E",
    vendor: "Aqara",
    description: "Radiator Thermostat W600",
    extend: [
        lumi.lumiModernExtend.lumiZigbeeOTA(),
        w600AqaraTimeResponse(),
        w600Heartbeat(),
        w600Thermostat(),
        w600ExternalTempSensor(),
        w600WindowSensor(),
        lumiBinary({
            name: "temperature_control_abnormal_notification",
            valueOn: ["ON", 1],
            valueOff: ["OFF", 0],
            cluster: CLUSTER_LUMI,
            attribute: {ID: ATTR_ABNORMAL_NOTIFICATION, type: Zcl.DataType.UINT8},
            description: "Enable or disable notification about abnormal temperature control conditions, such as valve blockage or sensor failure",
            access: "ALL",
            entityCategory: "config",
        }),
        lumiBinary({
            name: "display_flip",
            valueOn: ["ON", 1],
            valueOff: ["OFF", 0],
            attribute: {ID: ATTR_DISPLAY_FLIP, type: Zcl.DataType.UINT8},
            description: "Flip the display orientation",
            access: "ALL",
            entityCategory: "config",
        }),
        w600WindowDetection(),
        lumiBinary({
            name: "child_lock",
            valueOn: ["LOCK", 1],
            valueOff: ["UNLOCK", 0],
            attribute: {ID: ATTR_CHILD_LOCK, type: Zcl.DataType.UINT8},
            description: "Lock or unlock the physical controls",
            access: "ALL",
            entityCategory: "config",
        }),
        lumiNumeric({
            name: "anti_freeze_temperature",
            attribute: {ID: ATTR_ANTI_FREEZE, type: Zcl.DataType.UINT32},
            description: "Frost Protection. Initiates heating if temperature drops below the setpoint to prevent freezing.",
            access: "ALL",
            unit: "°C",
            valueMin: 5,
            valueMax: 15,
            valueStep: 0.5,
            scale: 100,
            entityCategory: "config",
        }),
        lumiEnumLookup({
            name: "calibrate",
            lookup: {start: 1},
            attribute: {ID: ATTR_CALIBRATE, type: Zcl.DataType.UINT8},
            description: "Start valve calibration",
            access: "SET",
            label: "Calibrate",
            entityCategory: "config",
        }),
        lumiEnumLookup({
            name: "calibrated",
            lookup: {not_ready: 0, ready: 1, error: 2, in_progress: 3},
            attribute: {ID: ATTR_CALIBRATED, type: Zcl.DataType.UINT8},
            description: "Valve calibration state",
            label: "Calibration status",
            access: "STATE_GET",
        }),
        lumiBinary({
            name: "schedule",
            valueOn: ["ON", 1],
            valueOff: ["OFF", 0],
            attribute: {ID: ATTR_SCHEDULE, type: Zcl.DataType.UINT8},
            description: "Enable or disable using the stored weekly schedule",
            access: "ALL",
            label: "Weekly schedule",
            entityCategory: "config",
        }),
        lumiNumeric({
            name: "position",
            attribute: {ID: ATTR_POSITION, type: Zcl.DataType.SINGLE_PREC},
            description: "Valve opening percentage reported by the device",
            access: "STATE_GET",
            unit: "%",
            valueMin: 0,
            valueMax: 100,
            precision: 2,
            label: "Valve position",
        }),
        w600WeeklySchedule(),
        w600PresetTemperatureTable(),
        w600Identify(),
    ],
};

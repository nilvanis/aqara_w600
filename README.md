# Aqara W600 Z2M External Converter

A still work in progress Aqara W600 support implementation in zigbee2mqtt.
Repo is to share the current work status with broader audience for testing.
Last step will be a PR to the herdsman-converters repo for native Z2M support.

![Aqara W600 thermostat operations](img/thermostat_ops.gif)

## Implemented features

| Feature | Status | Description/notes |
| --- | --- | --- |
| Thermostat (climate) | Full | Full set of presets (`home`, `away`, `vacation`, `sleep`, `wind_down`).<br>Fully functional `Auto` mode - see **Schedule Management**.|
| Preset configuration | Full | Every preset temperature can be configured via dedicated entity |
| Schedule management | Full | Complete implementation of the scheduling system and its configuration.<br>Dedicated entities to set schedule for each day.<br>Manual override handling and its timeout configuration.<br>W600 specific time synchronization.|
| External Temperature Source | Full | Possibility to switch to external temp sensor readings. It is using an `input_number` entity to provide temperature readings. Requires Home Assistant automation, but you can use just anything as source. |
| Open Window Detection | Almost full | Ability to enable open window detection.<br>It is possible to choose the detection method: `temperature_difference` or `external sensor`. External sensor state requires Home Assistant automation to update `input_boolean` entity state.<br>External sensor support is fully implemented.<br>Temp difference indication works for sure if no other errors are signaled. Might not work if there are multiple error flags on the TRV - to be verified. |
| Battery status Indicator | Full | Shows current percentage of installed batteries. |
| Anti-Freeze Temperature | Full | Entity to configure the Anti-Freeze Temperature. |
| Temperature control abnormal notification | Partial | Two entities: one to enable/disable reporting temperature control problem. Second one is exposed as "problem" entity. The bit responsible for reporting the detected problem is **probably** identified, but as with the Open Window Detection using temp difference - it might not always work in case multiple problem flags adds up. To be verified. |
| Temperature Compensation | was already | Dedicated entity defining the desired delta. |
| Valve Calibration | was already | Status of the valve calibration. |
| Valve Position | was already | Percentage of the valve opening position. |
| Display Flip | was already | Flip display orientation. |
| Child Lock | was already | Disable physical control of the TRV. |
| Regular OTA | was already | Over the Air updates. |
| Identify | was already | Turns on display in the TRV. |

# MQTT Sensor Dashboard

Small local dashboard for MQTT sensor values.

## Credentials

Copy the template and fill in the broker details:

```bash
cp ../credentials/mqtt.template.json ../credentials/mqtt.json
chmod 600 ../credentials/mqtt.json
```

Supported URL examples:

- `mqtt://host:1883`
- `mqtts://host:8883`
- `tcp://host:1883`

The dashboard subscribes to `topics` from the credentials file. The default template
uses `#` for reconnaissance.

## Run

```bash
./run.sh
```

Default URL: <http://127.0.0.1:8776>

State is stored in `state/dashboard.json` and survives process restarts and reboots.

## Systemd

```bash
mkdir -p ~/.config/systemd/user
cp systemd/mqtt-sensor-dashboard.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now mqtt-sensor-dashboard.service
```

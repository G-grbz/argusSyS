<div align="center">
  <h1>ArgusSyS — lightweight system stats dashboard</h1>
</div>

<details>
  <summary><strong>📸 Screenshot</strong></summary>
  <br>

  <p align="center">
    <img src="https://github.com/user-attachments/assets/77b389c2-52a9-4e6a-a00c-56efa51d4330" width="100%">
  </p>

</details>

ArgusSyS is a small **Node.js** service that:

* serves a JSON stats endpoint at **`/stats`**
* serves a static web UI from **`/`**
* optionally runs and schedules **speed tests**
* stores a small **server-side history ring buffer** (shared by all clients)

> **GPU support:** the container image is intended for **NVIDIA GPUs** via `nvidia-smi`.
> If NVIDIA drivers / NVIDIA Container Toolkit are not available, the API will still run, but **GPU fields will be `null` / `n/a`**.

---

## Requirements

* Docker Engine + Docker Compose
* **(Optional, for GPU metrics)** NVIDIA GPU + NVIDIA drivers on the host
* **(Optional, for GPU metrics inside containers)** NVIDIA Container Toolkit (so Docker can pass GPUs through)

If you run without NVIDIA support, everything except the GPU section should still work.

---

## Quick start

### Install (from GitHub)

```bash
git clone https://github.com/G-grbz/argusSyS.git
cd argusSyS

docker compose up -d --build
```

### Open

* UI: `http://<host>:3012/`
* API: `http://<host>:3012/stats`
* Health: `http://<host>:3012/health`

---

## Docker Compose example

This is a **generic template**. By default it runs **without NVIDIA**.
If you want NVIDIA GPU metrics, **uncomment** the `gpus:` line and the `NVIDIA_*` environment variables.

```yaml
services:
  argussys:
    container_name: argussys
    build: .

    # If you need host-level visibility (e.g. /proc, /sys), you may enable these.
    # Remove them if you prefer a stricter container.
    privileged: true
    pid: host
    network_mode: host

    working_dir: /app
    command: ["node", "stats-api.js"]

    # NVIDIA (optional). If you have NVIDIA + NVIDIA Container Toolkit, uncomment these:
    # gpus: all

    environment:
      TZ: Europe/Istanbul
      PORT: "3012"

      # Comma-separated list of mountpoints the API should report (df).
      # IMPORTANT: if running in a container, each path here must be mounted into the container.
      DISK_PATHS: "/host"

      # UI
      UI_DIR: "/app/ui"
      UI_INDEX: "index.html"

      # NVIDIA runtime hints (optional)
      # NVIDIA_VISIBLE_DEVICES: "all"
      # NVIDIA_DRIVER_CAPABILITIES: "compute,utility,video"

      # Speedtest
      SPEEDTEST_TIMEOUT_MS: "120000"
      SPEEDTEST_INTERVAL_MIN: "0"          # 0 = disabled (manual only)
      SPEEDTEST_RUN_ON_START: "1"          # 1 = run once on startup
      SPEEDTEST_STATE_FILE: "/app/data/speedtest-state.json"

      # History
      HISTORY_MAX_MIN: "120"

    volumes:
      # Host visibility (optional)
      - /sys:/sys:ro
      - /:/host:ro

      # Persist app data
      - ./data:/app/data

      # Serve UI from repo
      - ./ui:/app/ui:ro

    restart: unless-stopped
```

### Notes

* `network_mode: host` makes the UI/API available on the host network without port mapping.
  If you prefer bridge networking, remove `network_mode: host` and add `ports: ["3012:3012"]`.
* If you disable `privileged` / `pid: host`, some host-level detection may be reduced.
* For `DISK_PATHS`, every listed path should be **mounted in the container**, otherwise the API may report it as “not mounted on host”.

---

## Environment variables

### Core

* `PORT` (default: `3012`) — HTTP server port
* `TZ` — timezone used for formatting (recommended)

### UI

* `UI_DIR` (default: `./ui`) — directory containing static UI files
* `UI_INDEX` (default: `index.html`) — index file name

### Disk reporting

* `DISK_PATHS` (default: `/`) — comma-separated mountpoints to report with `df` and I/O stats

### GPU

* `GPU_POLL_MS` (default: `1000`) — GPU polling period
* `GPU_TIMEOUT_MS` (default: `1000`) — timeout for `nvidia-smi` calls

> **NVIDIA-only:** GPU stats use `nvidia-smi`. On systems without NVIDIA, the GPU block will be missing / `null`.

### History (server-side ring buffer)

* `HISTORY_SAMPLE_MS` (default: `1000`) — sampling interval
* `HISTORY_MAX_MIN` (default: `120`) — maximum history window
* `HISTORY_DB_PATH` (default: `./data/history_state.json`) — persisted history file

### Speedtest

* `SPEEDTEST_TIMEOUT_MS` (default: `120000`) — per-run timeout
* `SPEEDTEST_INTERVAL_MIN` (default: `0`) — schedule interval in minutes (`0` disables scheduling)
* `SPEEDTEST_RUN_ON_START` (default: `0/1`) — run once on boot
* `SPEEDTEST_STATE_FILE` (default: `/app/data/speedtest-state.json`) — persisted state file

---

## API endpoints

* `GET /stats` — full stats payload (includes `system`, `cpu`, `mem`, `net`, `gpu`, `disks`, and `history`)
* `GET /health` — health check

### Speedtest

* `GET /stats/speedtest/last` — last speedtest snapshot
* `GET /stats/speedtest/run` — trigger a speedtest run
* `GET /stats/speedtest/config?interval=<minutes>` — set interval (minutes)
* `GET /stats/speedtest/history` — 24h speedtest history

---

## Troubleshooting

### GPU shows `n/a` / missing

* Confirm `nvidia-smi` works on the host.
* If you want GPU metrics inside Docker:

  * install NVIDIA Container Toolkit on the host
  * ensure your Compose file includes `gpus: all`
  * keep `NVIDIA_VISIBLE_DEVICES=all`

If you are **not** using NVIDIA, remove the `gpus:` line and the `NVIDIA_*` environment variables.

### Disks show “not mounted on host”

When running in a container, each path in `DISK_PATHS` must be a real mountpoint on the host **and** be mounted into the container at the same path.

---

## Development

Run locally:

```bash
npm install
node stats-api.js
```

Then open `http://localhost:3012/`.

---

## License

MIT

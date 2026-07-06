#!/usr/bin/env python3
"""Generates a mock sensors.json snapshot in the schema galaxy-final.html
expects. Stand-in for the future Icinga API poller: same output shape,
fake data source. Once the real poller exists it should call
build_snapshot()-equivalent logic sourced from the Icinga API instead of
random.choice(), and write the result with write_snapshot().

Schema:
{
  "hosts":   [ { "id": str, "group": str, "down": bool } ],
  "sensors": [ { "id": str, "host": str, "service": str,
                 "state": int,   # 0=OK, 1=WARNING, 2=CRITICAL, 3=UNKNOWN
                 "output": str, "offline": bool } ],
  "last_update": str  # ISO 8601 timestamp of when the file was written
}

sensors[].host must match a hosts[].id. sensors[].id should be stable
across polls (this generator uses "<host_id>!<service_slug>").
"""
import argparse
import json
import random
import re
from datetime import datetime

GROUP_NAMES = [
    "Web Frontend", "API Services", "Database Cluster", "Cache Layer",
    "Message Queue", "Load Balancers", "Storage Array", "Network Core",
    "Auth Services", "Batch Workers", "CI/CD Pipeline", "Edge / CDN",
]

SERVICE_NAMES = [
    "CPU Load", "Memory Usage", "Disk Usage", "Swap Usage", "Latency",
    "Process Count", "Queue Depth", "HTTP Check", "SSL Certificate", "Ping",
]

OUTPUT_PHRASES = {
    0: ["Check completed normally.", "All parameters within range.", "No issues detected."],
    1: ["Approaching threshold.", "Elevated but not critical.", "Degraded performance detected."],
    2: ["Threshold breached.", "Check failed.", "Immediate attention required."],
    3: ["No data returned.", "Check timed out.", "Plugin returned unexpected output."],
}


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def weighted_state() -> int:
    r = random.random()
    if r < 0.90:
        return 0
    if r < 0.96:
        return 1
    if r < 0.99:
        return 2
    return 3


def build_snapshot() -> dict:
    hosts = []
    sensors = []

    for group in GROUP_NAMES:
        host_count = random.randint(4, 10)
        for h in range(1, host_count + 1):
            host_id = f"{slug(group)}-{h:02d}"
            down = random.random() < 0.015
            hosts.append({"id": host_id, "group": group, "down": down})

            # Every host gets its own "Host" sensor representing overall reachability,
            # independent of whatever services it does or doesn't have.
            sensors.append({
                "id": f"{host_id}!host",
                "host": host_id,
                "service": "Host",
                "state": 2 if down else 0,
                "output": "Host is DOWN" if down else "Host is UP",
                "offline": down,
            })

            service_pool = random.sample(SERVICE_NAMES, random.randint(4, min(8, len(SERVICE_NAMES))))
            for service in service_pool:
                state = weighted_state()
                sensors.append({
                    "id": f"{host_id}!{slug(service)}",
                    "host": host_id,
                    "service": service,
                    "state": state,
                    "output": random.choice(OUTPUT_PHRASES[state]),
                    "offline": down,
                })

    return {"hosts": hosts, "sensors": sensors}


def write_snapshot(snapshot: dict, out_path: str) -> None:
    snapshot["last_update"] = datetime.now().astimezone().isoformat(timespec="seconds")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, indent=2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("out_path", nargs="?", default="sensors.json")
    parser.add_argument("--seed", type=int, default=None, help="Random seed for reproducible output")
    args = parser.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    snapshot = build_snapshot()
    write_snapshot(snapshot, args.out_path)
    print(f"Wrote {len(snapshot['hosts'])} hosts / {len(snapshot['sensors'])} sensors to {args.out_path}")

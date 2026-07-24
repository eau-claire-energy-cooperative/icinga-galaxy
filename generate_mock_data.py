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
                 "acknowledgement": int,  # 0=none, 1=acknowledged, 2=sticky
                 "output": str, "offline": bool } ],
  "last_update": str  # ISO 8601 timestamp of when the file was written
}

sensors[].host must match a hosts[].id. sensors[].id should be stable
across polls (this generator uses "<host_id>!<service_slug>").
"""
import argparse
import base64
import json
import os
import random
import re
from datetime import datetime

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

# AES-256-GCM with a PBKDF2-SHA256-derived key. These parameters are baked into
# the output envelope so galaxy.js (Web Crypto) can reproduce the key exactly.
PBKDF2_ITERATIONS = 200_000

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
                "acknowledgement": 1 if (down and random.random() < 0.4) else 0,
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
                    "acknowledgement": 1 if (state != 0 and random.random() < 0.4) else 0,
                    "output": random.choice(OUTPUT_PHRASES[state]),
                    "offline": down,
                })

    return {"hosts": hosts, "sensors": sensors}


def encrypt_snapshot(plaintext: bytes, passphrase: str) -> dict:
    """Return a JSON-serializable envelope galaxy.js can decrypt with the same
    passphrase. GCM appends its 16-byte auth tag to the ciphertext, which is
    exactly what Web Crypto's AES-GCM decrypt expects."""
    salt = os.urandom(16)
    iv = os.urandom(12)  # 96-bit nonce, the GCM standard
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt,
                     iterations=PBKDF2_ITERATIONS)
    key = kdf.derive(passphrase.encode("utf-8"))
    ciphertext = AESGCM(key).encrypt(iv, plaintext, None)

    def b64(b):
        return base64.b64encode(b).decode("ascii")

    return {
        "v": 1,
        "kdf": "PBKDF2-SHA256",
        "iter": PBKDF2_ITERATIONS,
        "salt": b64(salt),
        "iv": b64(iv),
        "ct": b64(ciphertext),
    }


def write_snapshot(snapshot: dict, out_path: str, key: str = None) -> None:
    snapshot["last_update"] = datetime.now().astimezone().isoformat(timespec="seconds")
    # write an encrypted envelope if a key is given, else plaintext JSON
    with open(out_path, "w", encoding="utf-8") as f:
        if key:
            plaintext = json.dumps(snapshot).encode("utf-8")
            json.dump(encrypt_snapshot(plaintext, key), f, indent=2)
        else:
            json.dump(snapshot, f, indent=2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("out_path", nargs="?", default="sensors.json")
    parser.add_argument("--seed", type=int, default=None, help="Random seed for reproducible output")
    parser.add_argument("--key", help="Passphrase to encrypt the snapshot (AES-256-GCM). If missing the "
                        "snapshot is written as plaintext JSON, galaxy.html decrypts it via ?/#key=... in the URL.")
    args = parser.parse_args()

    if args.seed is not None:
        random.seed(args.seed)

    snapshot = build_snapshot()
    write_snapshot(snapshot, args.out_path, args.key)
    how = "encrypted" if args.key else "plaintext"
    print(f"Wrote {len(snapshot['hosts'])} hosts / {len(snapshot['sensors'])} sensors "
          f"to {args.out_path} ({how})")

#!/usr/bin/env python3
"""Polls the Icinga2 REST API for hosts/services checked by specific
check sources (zones/satellites) and writes a sensors.json snapshot in the
schema galaxy-final.html expects. Runs once per invocation and exits —
schedule repeated runs externally (Windows Task Scheduler, cron, etc.).

Requires the "requests" package (pip install requests).

Icinga2 API filter reference:
https://icinga.com/docs/icinga-2/latest/doc/12-icinga2-api/#filters

Example:
    python poll_icinga.py --url https://icinga.example.com:5665 \\
        --username api-reader --check-source site-a --check-source site-b

Find your zone/check_source names via Icinga Web 2 ("Zones" under
Configuration), or by inspecting last_check_result.check_source on any
existing host/service in /v1/objects/hosts.
"""
import configargparse
import getpass
import json
import os
import re
import requests
import sys
from datetime import datetime


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def build_session(username, password, insecure):
    session = requests.Session()
    session.auth = (username, password)
    session.headers.update({"Accept": "application/json"})
    if insecure:
        session.verify = False
        requests.packages.urllib3.disable_warnings(  # user explicitly opted out of verification
            requests.packages.urllib3.exceptions.InsecureRequestWarning
        )

    return session


def icinga_query(session, base_url, object_type, attrs, check_sources, timeout):
    """POST + X-HTTP-Method-Override: GET, per Icinga2's documented approach
    for filtered queries — avoids URL-encoding pitfalls with the filter DSL."""
    url = f"{base_url.rstrip('/')}/v1/objects/{object_type}"
    body = {
        "attrs": attrs,
        "filter": "host.last_check_result.check_source in check_sources",
        "filter_vars": {"check_sources": check_sources},
    }
    resp = session.post(url, json=body, headers={"X-HTTP-Method-Override": "GET"}, timeout=timeout)
    resp.raise_for_status()
    return resp.json().get("results", [])


def build_snapshot(session, base_url, check_sources, icinga_groups, timeout):
    host_results = icinga_query(
        session, base_url, "hosts",
        attrs=["name", "state", "groups", "acknowledgement", "downtime_depth"],
        check_sources=check_sources, timeout=timeout,
    )

    hosts = []
    host_down = {}
    sensors = []
    for r in host_results:
        attrs = r["attrs"]
        name = attrs["name"]
        ack = attrs["acknowledgement"] if attrs['downtime_depth'] == 0 else attrs['downtime_depth']
        downtime = attrs['downtime_depth']
        groups = attrs.get("groups") or []
        down = int(attrs.get("state", 0)) != 0

        if(icinga_groups):
            # reduce to only intersected groups
            groups = sorted(set(groups) & set(icinga_groups))

        hosts.append({
            "id": name,
            "group": groups[0] if groups else "ungrouped",  # use first group
            "down": down,
        })
        host_down[name] = down

        # Every host gets its own "Host" sensor representing overall reachability,
        # independent of whatever services it does or doesn't have
        sensors.append({
            "id": f"{name}!host",
            "host": name,
            "service": "Host",
            "state": 2 if down else 0,
            "output": "Host is DOWN" if down else "Host is UP",
            "acknowledgement": ack,
            "offline": down,
        })

    if not hosts:
        print(f"Warning: no hosts matched check_source(s) {check_sources!r} — "
              "double check the zone names.", file=sys.stderr)

    service_results = icinga_query(
        session, base_url, "services",
        attrs=["name", "host_name", "state", "last_check_result", "acknowledgement", "downtime_depth"],
        check_sources=check_sources, timeout=timeout,
    )

    for r in service_results:
        attrs = r["attrs"]
        host_name = attrs["host_name"]
        if host_name not in host_down:
            continue  # host filtered out (shouldn't normally happen — same check_source filter)
        service_name = attrs["name"]
        service_ack = attrs["acknowledgement"] if attrs['downtime_depth'] == 0 else attrs['downtime_depth']
        offline = host_down[host_name]  # per spec: offline iff host is down; otherwise trust service.state
        last_check_result = attrs.get("last_check_result") or {}
        sensors.append({
            "id": f"{host_name}!{slug(service_name)}",
            "host": host_name,
            "service": service_name,
            "state": int(attrs.get("state", 3)),
            "output": last_check_result.get("output") or "",
            "acknowledgement": service_ack,
            "offline": offline,
        })

    return {"hosts": hosts, "sensors": sensors}


def resolve_password(args):
    result = None
    if args.password:
        result = args.password
    env_password = os.environ.get("ICINGA_PASSWORD")
    if env_password:
        result = env_password
    return result


def parse_args():
    parser = configargparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('-c', '--config', is_config_file=True, help='Path to custom config file')
    parser.add_argument("--url", required=True, help="Icinga2 API base URL, e.g. https://icinga.example.com:5665")
    parser.add_argument("--username", required=True)
    parser.add_argument("--password", help="If omitted, falls back to the ICINGA_PASSWORD env var")
    parser.add_argument("--check-source", dest="check_sources", action="append", required=True,
                         help="Zone/satellite name to include (repeatable: --check-source site-a --check-source site-b)")
    parser.add_argument("--groups", dest="groups", action="append", required=False,
                         help="Icinga group names to use for grouping, if included only these groups are used"
                               " if ommited then first group in host group list is used (repeatable, --group a --group b)")
    parser.add_argument("--out", default="sensors.json", help="Output path for the JSON snapshot (default: sensors.json)")
    parser.add_argument("--insecure", action="store_true", help="Skip TLS certificate verification (self-signed certs)")
    parser.add_argument("--timeout", type=float, default=30.0, help="HTTP request timeout in seconds (default: 30)")
    return parser.parse_args()


def main():
    args = parse_args()
    password = resolve_password(args)

    if(password is None):
        print("Password for Icinga could not be found")
        sys.exit(1)

    session = build_session(args.username, password, args.insecure)

    try:
        snapshot = build_snapshot(session, args.url, args.check_sources, args.groups, args.timeout)
    except requests.exceptions.HTTPError as e:
        detail = e.response.text if e.response is not None else str(e)
        print(f"Icinga API returned HTTP {e.response.status_code if e.response is not None else '?'}: {detail}",
              file=sys.stderr)
        sys.exit(1)
    except requests.exceptions.RequestException as e:
        print(f"Could not reach Icinga API at {args.url}: {e}", file=sys.stderr)
        sys.exit(1)

    # set the last update time
    snapshot["last_update"] = datetime.now().astimezone().isoformat(timespec="seconds")

    # write the output file
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, indent=2)
    print(f"Wrote {len(snapshot['hosts'])} hosts / {len(snapshot['sensors'])} sensors to {args.out}")


if __name__ == "__main__":
    main()

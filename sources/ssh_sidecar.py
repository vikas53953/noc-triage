#!/usr/bin/env python3
"""SSH sidecar — read-only CLI to directly-reachable network devices.

The Node side (sources/ssh-runner.js) spawns this once per command. It NEVER
receives credentials on the command line (that would leak them into process
listings). The whole request — including host/username/password — arrives as a
single JSON object on stdin. The reply is a single JSON object on stdout.

Prefers Scrapli (fast, purpose-built) and falls back to Netmiko when Scrapli
cannot drive the platform. Both are read-only here: this file re-checks the
command against the same show-class allowlist the Node guardrail enforces, so a
write can never reach the wire even if the caller is wrong.

Request  (stdin JSON): {
    "host": "sandbox-...", "port": 22, "username": "...", "password": "...",
    "platform": "iosxe" | "nxos" | "ios" | "iosxr" | "eos" | "junos",
    "command": "show version",
    "timeout": 30          # optional, seconds
}
Response (stdout JSON): {
    "ok": true, "output": "...", "elapsed": 2.4, "engine": "scrapli"
}   or on failure:
    "ok": false, "error": "auth failed", "kind": "auth"|"unreachable"|"blocked"|"error"

Exit code is always 0 — the failure is carried in the JSON, never a crash, so
the Node side can report an honest "auth failed / unreachable" instead of a
fabricated result.
"""
import json
import sys
import time

# The ONLY commands this sidecar may ever send. Mirrors sources/guardrails.js.
READ_VERBS = ("show", "ping", "traceroute", "dir", "more")
# Chaining / redirection characters turn a read into a write. Refused anywhere.
CHAIN_CHARS = set(";&|><`$\n\r")

# Scrapli core driver per platform. Fallback maps to a Netmiko device_type.
SCRAPLI_DRIVERS = {
    "iosxe": "IOSXEDriver",
    "ios": "IOSXEDriver",
    "nxos": "NXOSDriver",
    "iosxr": "IOSXRDriver",
    "eos": "EOSDriver",
    "junos": "JunosDriver",
}
NETMIKO_TYPES = {
    "iosxe": "cisco_xe",
    "ios": "cisco_ios",
    "nxos": "cisco_nxos",
    "iosxr": "cisco_xr",
    "eos": "arista_eos",
    "junos": "juniper_junos",
}


def check_read_only(command):
    """Belt-and-braces guardrail. Returns None if allowed, else a reason string."""
    cmd = (command or "").strip()
    if not cmd:
        return "empty command"
    if any(c in CHAIN_CHARS for c in cmd):
        return "command chains or redirects (; & | > < ` $) — refused"
    verb = cmd.split()[0].lower()
    if verb not in READ_VERBS:
        return f'"{verb}" is not a read-only command (allowed: {", ".join(READ_VERBS)})'
    return None


def classify(err_text):
    """Map a driver exception into a coarse, honest failure kind."""
    t = (err_text or "").lower()
    if "auth" in t or "password" in t or "permission denied" in t:
        return "auth"
    if ("timed out" in t or "timeout" in t or "unreachable" in t
            or "refused" in t or "reset" in t or "could not open" in t
            or "name or service" in t or "getaddrinfo" in t
            or "no route" in t or "connection" in t):
        return "unreachable"
    return "error"


def run_scrapli(req):
    from scrapli.driver.core import (  # noqa: F401
        IOSXEDriver, NXOSDriver, IOSXRDriver, EOSDriver, JunosDriver,
    )
    driver_name = SCRAPLI_DRIVERS[req["platform"]]
    Driver = locals()[driver_name]
    timeout = float(req.get("timeout", 30))
    conn = Driver(
        host=req["host"],
        port=int(req.get("port", 22)),
        auth_username=req["username"],
        auth_password=req["password"],
        auth_strict_key=False,
        transport="paramiko",
        timeout_socket=timeout,
        timeout_transport=timeout + 15,
        timeout_ops=timeout + 30,
    )
    conn.open()
    try:
        resp = conn.send_command(req["command"])
        return resp.result
    finally:
        try:
            conn.close()
        except Exception:
            pass


def run_netmiko(req):
    from netmiko import ConnectHandler
    timeout = float(req.get("timeout", 30))
    conn = ConnectHandler(
        device_type=NETMIKO_TYPES[req["platform"]],
        host=req["host"],
        port=int(req.get("port", 22)),
        username=req["username"],
        password=req["password"],
        fast_cli=False,
        conn_timeout=timeout,
        banner_timeout=timeout,
        auth_timeout=timeout,
    )
    try:
        return conn.send_command(req["command"])
    finally:
        try:
            conn.disconnect()
        except Exception:
            pass


def main():
    try:
        req = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"bad request: {e}", "kind": "error"}))
        return

    for field in ("host", "username", "password", "command"):
        if not req.get(field):
            print(json.dumps({"ok": False, "error": f"missing {field}", "kind": "error"}))
            return

    platform = (req.get("platform") or "iosxe").lower()
    if platform not in SCRAPLI_DRIVERS:
        print(json.dumps({"ok": False, "error": f"unknown platform {platform}", "kind": "error"}))
        return
    req["platform"] = platform

    reason = check_read_only(req["command"])
    if reason:
        print(json.dumps({"ok": False, "error": f"Blocked: {reason}", "kind": "blocked"}))
        return

    started = time.time()
    engine = "scrapli"
    try:
        output = run_scrapli(req)
    except Exception as scrapli_err:
        # Fall back to Netmiko unless the failure is clearly network/auth (no
        # point re-dialling a box that just rejected us or is unreachable).
        kind = classify(str(scrapli_err))
        if kind in ("auth", "unreachable"):
            print(json.dumps({
                "ok": False, "error": str(scrapli_err), "kind": kind,
                "engine": engine, "elapsed": round(time.time() - started, 2),
            }))
            return
        engine = "netmiko"
        try:
            output = run_netmiko(req)
        except Exception as nm_err:
            print(json.dumps({
                "ok": False, "error": str(nm_err), "kind": classify(str(nm_err)),
                "engine": engine, "elapsed": round(time.time() - started, 2),
            }))
            return

    print(json.dumps({
        "ok": True, "output": output, "engine": engine,
        "elapsed": round(time.time() - started, 2),
    }))


if __name__ == "__main__":
    main()

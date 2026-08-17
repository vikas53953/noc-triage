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
import os
import sys
import time

# The ONLY commands this sidecar may ever send. MIRRORS sources/guardrails.js.
# Drift between the two layers is caught by the parity check in
# sources/ssh-runner.smoke.js, which asks this file for its rules via
# `--selftest` and compares them to the Node originals. Change one, change both,
# or the smoke test fails.
READ_VERBS = ("show", "ping", "traceroute", "dir", "more")
# Chaining / redirection characters turn a read into a write. Refused anywhere.
CHAIN_CHARS = set(";&|><`$\n\r")
# Charset ALLOWLIST — printable ASCII only. A blacklist only blocks the
# characters we thought of; control/exotic-Unicode characters (NUL, ESC, VTAB,
# FORMFEED, BACKSPACE, NEL, U+2028/29) previously passed both layers. Everything
# legitimate is printable ASCII, so the allowlist loses nothing.
PRINTABLE_ASCII_MIN = 0x20
PRINTABLE_ASCII_MAX = 0x7E

# Hard ceiling on a single command's output (1 MB). "show tech-support" is a
# legal show-class read that runs to megabytes. Overridable per request.
DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024


def is_printable_ascii(s):
    return bool(s) and all(PRINTABLE_ASCII_MIN <= ord(c) <= PRINTABLE_ASCII_MAX for c in s)

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
    # Charset allowlist runs FIRST — refuse control characters outright.
    if not is_printable_ascii(cmd):
        return "command contains characters outside printable ASCII — refused"
    if any(c in CHAIN_CHARS for c in cmd):
        return "command chains or redirects (; & | > < ` $) — refused"
    verb = cmd.split()[0].lower()
    if verb not in READ_VERBS:
        return f'"{verb}" is not a read-only command (allowed: {", ".join(READ_VERBS)})'
    return None


# Name-resolution failures. Called out separately because a host that does not
# RESOLVE will never resolve for the second engine either — re-dialling through
# Netmiko just doubles the wait before the same (correct) verdict. These map to
# "unreachable" but stop the fallback.
DNS_MARKERS = (
    "name or service not known", "getaddrinfo", "nodename nor servname",
    "unknown host", "no address associated", "name does not resolve",
    "temporary failure in name resolution", "gaierror",
    "failed to resolve", "not known",
    # Scrapli's wording when the hostname does not resolve. Verified live:
    # ScrapliConnectionNotOpened("failed to determine socket address family for
    # host"). Without this the name failure fell through to a second Netmiko
    # dial that could only fail the same way, doubling the operator's wait.
    "failed to determine socket address family",
)

HOSTKEY_MARKERS = (
    "host key", "hostkey", "known_hosts", "not found in known hosts",
    "server not found in known", "bad host key", "host key verification",
)


def classify(err_text):
    """Map a driver exception into a coarse, honest failure kind."""
    t = (err_text or "").lower()
    # Host-key rejection is its own answer — telling the operator "auth failed"
    # when we actually refused an unrecognised fingerprint hides a possible
    # on-path attack behind a wrong-password message.
    if any(m in t for m in HOSTKEY_MARKERS):
        return "hostkey"
    if any(m in t for m in DNS_MARKERS):
        return "dns"
    if "auth" in t or "password" in t or "permission denied" in t:
        return "auth"
    if ("timed out" in t or "timeout" in t or "unreachable" in t
            or "refused" in t or "reset" in t or "could not open" in t
            or "no route" in t or "connection" in t):
        return "unreachable"
    return "error"


def strict_key_settings(req):
    """Decide whether this dial verifies the SSH host key.

    Default is AUTO: strict when we already have a known_hosts entry for the
    host, permissive on first contact. That way a public throwaway sandbox still
    works out of the box, but once a host is pinned an on-path impostor is
    refused instead of silently harvesting the credentials. SSH_STRICT_KEY=1
    forces strict everywhere (what you want the moment a REAL device credential
    goes into .env.local); SSH_STRICT_KEY=0 forces off.

    Returns (strict: bool, known_hosts_path: str|None).
    """
    mode = str(req.get("strict_key", "auto")).lower()
    known_hosts = req.get("known_hosts") or None

    if mode in ("1", "true", "yes", "on", "strict"):
        return True, known_hosts
    if mode in ("0", "false", "no", "off"):
        return False, known_hosts

    # AUTO — strict only if this host is already pinned in known_hosts.
    path = known_hosts or os.path.join(os.path.expanduser("~"), ".ssh", "known_hosts")
    if not os.path.exists(path):
        return False, known_hosts
    try:
        import paramiko
        hk = paramiko.hostkeys.HostKeys(path)
        host, port = req["host"], int(req.get("port", 22))
        # OpenSSH stores non-22 ports as "[host]:port".
        pinned = hk.lookup(host) or (hk.lookup(f"[{host}]:{port}") if port != 22 else None)
        return bool(pinned), known_hosts
    except Exception:
        return False, known_hosts


def run_scrapli(req):
    from scrapli.driver.core import (  # noqa: F401
        IOSXEDriver, NXOSDriver, IOSXRDriver, EOSDriver, JunosDriver,
    )
    driver_name = SCRAPLI_DRIVERS[req["platform"]]
    Driver = locals()[driver_name]
    timeout = float(req.get("timeout", 30))
    strict, known_hosts = strict_key_settings(req)
    extra = {}
    if known_hosts:
        extra["ssh_known_hosts_file"] = known_hosts
    conn = Driver(
        host=req["host"],
        port=int(req.get("port", 22)),
        auth_username=req["username"],
        auth_password=req["password"],
        auth_strict_key=strict,
        transport="paramiko",
        **extra,
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
    strict, known_hosts = strict_key_settings(req)
    extra = {}
    if strict:
        # Netmiko verifies against known_hosts only when asked to.
        extra["use_keys"] = False
        extra["ssh_strict"] = True
        extra["system_host_keys"] = True
        if known_hosts:
            extra["alt_host_keys"] = True
            extra["alt_key_file"] = known_hosts
    conn = ConnectHandler(
        device_type=NETMIKO_TYPES[req["platform"]],
        host=req["host"],
        port=int(req.get("port", 22)),
        username=req["username"],
        password=req["password"],
        fast_cli=False,
        **extra,
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


def selftest():
    """Emit this layer's guardrail rules so Node can parity-check them.

    Printed by `python ssh_sidecar.py --selftest`. The smoke test compares this
    to the Node originals in sources/guardrails.js and FAILS on drift, so the
    two copies of the allowlist can no longer diverge unnoticed.
    """
    probes = [
        "show version", "ping 8.8.8.8", "dir", "more nvram:startup-config",
        "configure terminal", "reload", "write erase", "show version; reload",
        "show version | include x", "show ver\x00sion", "show ver\x1bsion",
        "show ver\x0bsion", "show ver\x0csion", "show ver\x08sion",
        "show ver\x01sion", "show ver\x85sion", "show ver\u2028sion",
        "show ver\u2029sion",
    ]
    print(json.dumps({
        "read_verbs": list(READ_VERBS),
        "chain_chars": sorted(CHAIN_CHARS),
        "printable_ascii": [PRINTABLE_ASCII_MIN, PRINTABLE_ASCII_MAX],
        # verdict per probe: null = allowed, string = refusal reason
        "verdicts": {p: check_read_only(p) for p in probes},
    }))


def main():
    if "--selftest" in sys.argv[1:]:
        return selftest()
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
        # Fall back to Netmiko only when the first engine failed for a reason a
        # DIFFERENT driver might survive. A box that rejected our password, a
        # hostname that does not resolve, an unreachable socket, or a host key
        # we refused will fail identically on the second dial — re-trying just
        # doubles the operator's wait before the same, correct verdict.
        kind = classify(str(scrapli_err))
        if kind in ("auth", "unreachable", "dns", "hostkey"):
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

    # Cap the payload at the source. "show tech-support" is a show-class read
    # and runs to megabytes; an uncapped string would ride through the pipe into
    # chat, the activity log and persistence. Truncation is announced, never
    # silent — a trimmed transcript that claims to be whole is a lie.
    truncated = False
    max_bytes = int(req.get("max_output_bytes", DEFAULT_MAX_OUTPUT_BYTES))
    if max_bytes > 0 and len(output) > max_bytes:
        output = output[:max_bytes]
        truncated = True

    print(json.dumps({
        "ok": True, "output": output, "truncated": truncated,
        "strictKey": strict_key_settings(req)[0], "engine": engine,
        "elapsed": round(time.time() - started, 2),
    }))


if __name__ == "__main__":
    main()

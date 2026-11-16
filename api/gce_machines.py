"""Cloud CPU machines of Jupyter Code Workspaces on Google Compute Engine (code_workspaces.py; GPUs stay on RunPod).

A workspace's CPU machine is an e2-standard-<vCPUs> VM (Debian 12; Spot when the workspace chose the cheaper
"community" tier) named bluesandai-<workspace id>. Its startup script, run at every boot, installs JupyterLab and
ipykernel in /opt/jupyter once, downloads the platform client like a RunPod pod does (bootstrap.sh), and serves
Jupyter on port 8888 over TLS with a self-signed certificate made for the workspace: the API pins that certificate,
so no one between the API and the VM can read or change kernel traffic, and Jupyter's token guards the port. A
firewall rule (bluesandai-jupyter) opens 8888 to the VMs tagged bluesandai-jupyter, from GCP_COMPUTE_SOURCE_RANGES.

Settings (.env.local or the environment):
  GCP_COMPUTE_CREDENTIALS   path of a service account key with Compute Instance Admin (v1) and, to create the
                            firewall rule once, Compute Security Admin (or create the rule yourself)
  GCP_COMPUTE_PROJECT       the project (default: the key's project_id)
  GCP_COMPUTE_ZONE          default asia-southeast2-a (Jakarta)
  GCP_COMPUTE_SOURCE_RANGES comma-separated CIDRs allowed to reach port 8888 (default 0.0.0.0/0)
"""

from __future__ import annotations

import datetime
import json
import ssl
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import HTTPException

API = "https://compute.googleapis.com/compute/v1"
IMAGE = "projects/debian-cloud/global/images/family/debian-12"
TAG = "bluesandai-jupyter"
FIREWALL = "bluesandai-jupyter"
VCPUS = (2, 4, 8, 16, 32)
_session: dict[str, Any] = {}


def settings(env: Callable[[str], str]) -> Optional[dict]:
    """{credentials, project, zone, sources} when Compute Engine is configured, else None."""
    path = env("GCP_COMPUTE_CREDENTIALS")
    if not path or not Path(path).is_file():
        return None
    try:
        project = env("GCP_COMPUTE_PROJECT") or json.loads(Path(path).read_text("utf-8")).get("project_id", "")
    except (OSError, ValueError):
        return None
    if not project:
        return None
    sources = [s.strip() for s in (env("GCP_COMPUTE_SOURCE_RANGES") or "0.0.0.0/0").split(",") if s.strip()]
    return {"credentials": path, "project": project, "zone": env("GCP_COMPUTE_ZONE") or "asia-southeast2-a", "sources": sources}


def call(cfg: dict, method: str, path: str, body: Optional[dict] = None) -> Any:
    """One call to the Compute Engine REST API (replaced in tests)."""
    from google.auth.transport.requests import AuthorizedSession
    from google.oauth2 import service_account

    s = _session.get(cfg["credentials"])
    if s is None:
        creds = service_account.Credentials.from_service_account_file(cfg["credentials"], scopes=["https://www.googleapis.com/auth/compute"])
        s = _session[cfg["credentials"]] = AuthorizedSession(creds)
    try:
        r = s.request(method, f"{API}/projects/{cfg['project']}{path}", json=body, timeout=60)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Google Compute Engine could not be reached: {e}") from None
    if r.status_code == 404:
        raise HTTPException(404, "Compute Engine has no such machine")
    if r.status_code >= 400:
        try:
            msg = r.json()["error"]["message"]
        except Exception:  # noqa: BLE001
            msg = r.text[:400]
        raise HTTPException(502, f"Google Compute Engine refused the request ({r.status_code}): {msg}")
    return r.json() if r.content else None


def instance_name(wid: str) -> str:
    return f"bluesandai-{wid}"


def machine_type(vcpus: int) -> str:
    return f"e2-standard-{min(VCPUS, key=lambda v: abs(v - vcpus))}"


# ------------------------------------------------------------------------------------------------ TLS


def make_tls() -> dict:
    """A self-signed certificate (and key) for one workspace's Jupyter; the API trusts only this certificate."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "bluesandai-jupyter")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("bluesandai-jupyter")]), critical=False)
        .sign(key, hashes.SHA256())
    )
    return {"cert": cert.public_bytes(serialization.Encoding.PEM).decode(),
            "key": key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()}


def ssl_context(cert_pem: str) -> ssl.SSLContext:
    """Verifies the VM by its pinned certificate (the VM's address changes, so not by host name)."""
    ctx = ssl.create_default_context(cadata=cert_pem)
    ctx.check_hostname = False
    return ctx


# ------------------------------------------------------------------------------------------------ the VM

STARTUP = r"""#!/bin/bash
# BluesandAI Code Workspace machine: JupyterLab over TLS on port 8888 (runs at every boot)
M=http://metadata.google.internal/computeMetadata/v1/instance/attributes
md() { curl -fsS -H "Metadata-Flavor: Google" "$M/$1"; }
export BLUESANDAI_API_URL="$(md bluesandai-api-url)" BLUESANDAI_WORKSPACE_ID="$(md bluesandai-workspace-id)"
export BLUESANDAI_POD_URL="$(md bluesandai-pod-url)" BLUESANDAI_API_TOKEN="$(md bluesandai-api-token)"
TOKEN="$(md jupyter-token)"
mkdir -p /etc/bluesandai /workspace
md jupyter-cert > /etc/bluesandai/cert.pem
md jupyter-key > /etc/bluesandai/key.pem
chmod 600 /etc/bluesandai/key.pem
if [ ! -x /opt/jupyter/bin/jupyter-lab ]; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv python3-pip curl
  python3 -m venv /opt/jupyter
  /opt/jupyter/bin/pip install -q --upgrade pip
  /opt/jupyter/bin/pip install -q jupyterlab ipykernel pandas numpy matplotlib scikit-learn dill cloudpickle pyyaml
fi
export PATH=/opt/jupyter/bin:$PATH
(curl -fsSL -H "Authorization: Bearer $BLUESANDAI_API_TOKEN" "$BLUESANDAI_POD_URL/bootstrap.sh" | bash) || echo "BluesandAI bootstrap failed"
cd /workspace
nohup jupyter lab --ip=0.0.0.0 --port=8888 --no-browser --allow-root --ServerApp.root_dir=/ \
  --IdentityProvider.token="$TOKEN" --ServerApp.certfile=/etc/bluesandai/cert.pem --ServerApp.keyfile=/etc/bluesandai/key.pem \
  > /var/log/bluesandai-jupyter.log 2>&1 &
"""


def ensure_firewall(cfg: dict) -> None:
    """The rule opening port 8888 to workspace machines (created once)."""
    try:
        call(cfg, "GET", f"/global/firewalls/{FIREWALL}")
        return
    except HTTPException as e:
        if e.status_code != 404:
            raise
    call(cfg, "POST", "/global/firewalls", {
        "name": FIREWALL, "network": "global/networks/default", "direction": "INGRESS", "targetTags": [TAG], "sourceRanges": cfg["sources"],
        "allowed": [{"IPProtocol": "tcp", "ports": ["8888"]}], "description": "Jupyter (TLS, token) of BluesandAI Code Workspace machines",
    })


def create(cfg: dict, rec: dict, meta: dict[str, str]) -> dict:
    """Create the workspace's VM; meta are its metadata (Jupyter token and TLS, the platform's URLs and secret)."""
    ensure_firewall(cfg)
    c = rec["compute"]
    zone = cfg["zone"]
    body: dict = {
        "name": instance_name(rec["id"]),
        "machineType": f"zones/{zone}/machineTypes/{machine_type(c.get('vcpus', 4))}",
        "tags": {"items": [TAG]},
        "labels": {"app": "bluesandai", "workspace": rec["id"]},
        "disks": [{"boot": True, "autoDelete": True, "initializeParams": {"sourceImage": IMAGE, "diskSizeGb": str(max(10, c.get("disk_gb", 20))),
                                                                         "diskType": f"zones/{zone}/diskTypes/pd-balanced"}}],
        "networkInterfaces": [{"network": "global/networks/default", "accessConfigs": [{"type": "ONE_TO_ONE_NAT", "name": "External NAT"}]}],
        "metadata": {"items": [{"key": "startup-script", "value": STARTUP}] + [{"key": k, "value": v} for k, v in meta.items()]},
    }
    if c.get("cloud") == "COMMUNITY":
        # the cheaper tier: a Spot VM (Google may stop it when it needs the capacity; the disk is kept)
        body["scheduling"] = {"provisioningModel": "SPOT", "instanceTerminationAction": "STOP", "automaticRestart": False, "onHostMaintenance": "TERMINATE"}
    call(cfg, "POST", f"/zones/{zone}/instances", body)
    return {"id": instance_name(rec["id"]), "zone": zone, "machine_type": machine_type(c.get("vcpus", 4)), "spot": c.get("cloud") == "COMMUNITY"}


def get(cfg: dict, name: str, zone: str) -> dict:
    """{status: starting | running | stopped, ip}."""
    inst = call(cfg, "GET", f"/zones/{zone}/instances/{name}")
    s = inst.get("status", "")
    status = "running" if s == "RUNNING" else "stopped" if s in ("STOPPING", "STOPPED", "SUSPENDING", "SUSPENDED", "TERMINATED") else "starting"
    nic = (inst.get("networkInterfaces") or [{}])[0]
    ip = ((nic.get("accessConfigs") or [{}])[0]).get("natIP")
    return {"status": status, "ip": ip, "machine_type": inst.get("machineType", "").rsplit("/", 1)[-1]}


def start(cfg: dict, name: str, zone: str) -> None:
    call(cfg, "POST", f"/zones/{zone}/instances/{name}/start")


def stop(cfg: dict, name: str, zone: str) -> None:
    call(cfg, "POST", f"/zones/{zone}/instances/{name}/stop")


def delete(cfg: dict, name: str, zone: str) -> None:
    call(cfg, "DELETE", f"/zones/{zone}/instances/{name}")

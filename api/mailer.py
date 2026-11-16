"""Outgoing email: password reset links, invitations and Data Health alert emails.

Two ways to send, from the environment or .env.local:

* Resend (preferred): RESEND_API_KEY (re_…), and the sender in RESEND_FROM — an address on a domain verified in
  Resend (Domains), e.g. "BluesandAI <no-reply@mail.example.com>". Sent with Resend's HTTP API:
  POST {RESEND_API_URL, default https://api.resend.com}/emails with "Authorization: Bearer <key>" and
  {from, to, subject, text, html, reply_to}; an Idempotency-Key header makes retries safe. Before a domain is
  verified, Resend's test sender onboarding@resend.dev only delivers to the Resend account's own address.
* SMTP: BLUESANDAI_SMTP_HOST, _PORT (587; 465 = SSL), _USER, _PASSWORD, _FROM, _STARTTLS (on unless "0"/"off").
  Resend's SMTP works here too: host smtp.resend.com, user "resend", password the API key.

Without either nothing is sent: `send` returns False and the caller shows the link to an administrator instead.
"""

from __future__ import annotations

import logging
import os
import smtplib
import uuid
from email.message import EmailMessage
from pathlib import Path
from typing import Optional

log = logging.getLogger("bluesandai.mailer")
ROOT = Path(__file__).resolve().parent.parent
RESEND_API_URL = "https://api.resend.com"


def env(key: str, default: str = "") -> str:
    """A setting from the environment, else from .env.local at the repository root (or the working directory)."""
    v = os.environ.get(key)
    if v is not None and v.strip():
        return v.strip()
    for folder in (Path.cwd(), ROOT):
        f = folder / ".env.local"
        if f.is_file():
            for line in f.read_text("utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, val = line.split("=", 1)
                    if k.strip() == key:
                        return val.strip().strip("\"'") or default
            break
    return default


def provider() -> Optional[str]:
    """"resend", "smtp" or None (email is not configured)."""
    if env("RESEND_API_KEY"):
        return "resend"
    if env("BLUESANDAI_SMTP_HOST"):
        return "smtp"
    return None


def configured() -> bool:
    return provider() is not None


def sender() -> str:
    return env("RESEND_FROM") or env("BLUESANDAI_SMTP_FROM") or env("BLUESANDAI_SMTP_USER") or "BluesandAI <onboarding@resend.dev>"


class EmailError(RuntimeError):
    pass


def _send_resend(to: str, subject: str, text: str, html: Optional[str], reply_to: Optional[str], idempotency_key: Optional[str],
                 attachments: Optional[list] = None) -> None:
    import base64

    import requests

    body: dict = {"from": sender(), "to": [to], "subject": subject, "text": text}
    if html:
        body["html"] = html
    if attachments:
        body["attachments"] = [{"filename": a[0], "content": base64.b64encode(a[1]).decode(), **({"content_id": a[3]} if len(a) > 3 and a[3] else {})}
                               for a in attachments]
    if reply_to or env("RESEND_REPLY_TO"):
        body["reply_to"] = reply_to or env("RESEND_REPLY_TO")
    r = requests.post(f"{(env('RESEND_API_URL') or RESEND_API_URL).rstrip('/')}/emails", json=body, timeout=20,
                      headers={"Authorization": f"Bearer {env('RESEND_API_KEY')}", "Content-Type": "application/json",
                               "User-Agent": "bluesandai-mailer", "Idempotency-Key": idempotency_key or uuid.uuid4().hex})
    if r.status_code >= 300:
        try:
            err = r.json()
            detail = f"{err.get('name') or r.status_code}: {err.get('message') or r.text[:300]}"
        except ValueError:
            detail = f"{r.status_code}: {r.text[:300]}"
        raise EmailError(f"Resend refused the email ({detail})")
    log.info("emailed %r to %s with Resend (id %s)", subject, to, (r.json() or {}).get("id"))


def _send_smtp(to: str, subject: str, text: str, html: Optional[str], reply_to: Optional[str], attachments: Optional[list] = None) -> None:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender()
    msg["To"] = to
    if reply_to:
        msg["Reply-To"] = reply_to
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    for a in attachments or []:
        maintype, _, subtype = (a[2] if len(a) > 2 else "application/octet-stream").partition("/")
        if len(a) > 3 and a[3] and html:
            # an inline image the HTML shows with <img src="cid:...">
            msg.get_payload()[-1].add_related(a[1], maintype=maintype, subtype=subtype, cid=f"<{a[3]}>", filename=a[0])
        else:
            msg.add_attachment(a[1], maintype=maintype, subtype=subtype, filename=a[0])
    host = env("BLUESANDAI_SMTP_HOST")
    port = int(env("BLUESANDAI_SMTP_PORT", "587") or 587)
    with smtplib.SMTP_SSL(host, port, timeout=20) if port in (465, 2465) else smtplib.SMTP(host, port, timeout=20) as s:
        if port not in (465, 2465) and env("BLUESANDAI_SMTP_STARTTLS", "1").lower() not in ("0", "off", "false", "no"):
            s.starttls()
        if env("BLUESANDAI_SMTP_USER"):
            s.login(env("BLUESANDAI_SMTP_USER"), env("BLUESANDAI_SMTP_PASSWORD"))
        s.send_message(msg)


def send(to: str, subject: str, text: str, html: Optional[str] = None, reply_to: Optional[str] = None,
         idempotency_key: Optional[str] = None, attachments: Optional[list] = None) -> bool:
    """Send an email with Resend (or SMTP); False when email is not configured. Raises on a delivery error.
    `attachments`: (filename, bytes, mime type[, content id for an inline image])."""
    how = provider()
    if how is None:
        log.info("email not configured: not sending %r to %s", subject, to)
        return False
    if how == "resend":
        _send_resend(to, subject, text, html, reply_to, idempotency_key, attachments)
    else:
        _send_smtp(to, subject, text, html, reply_to, attachments)
    return True


def html_message(title: str, paragraphs: list[str], button: Optional[tuple[str, str]] = None, footer: str = "") -> str:
    """A small, inline-styled HTML email (clients ignore stylesheets): a title, paragraphs and an optional button."""
    import html as h

    parts = [f'<h2 style="margin:0 0 16px;font-size:20px;color:#0b1220">{h.escape(title)}</h2>']
    parts += [f'<p style="margin:0 0 12px;line-height:1.5;color:#334155">{h.escape(p)}</p>' for p in paragraphs]
    if button:
        label, url = button
        parts.append(f'<p style="margin:20px 0"><a href="{h.escape(url, quote=True)}" style="background:#3d8bfd;color:#ffffff;padding:10px 18px;'
                     f'border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">{h.escape(label)}</a></p>'
                     f'<p style="margin:0 0 12px;font-size:12px;color:#64748b">Or open this link: <a href="{h.escape(url, quote=True)}" '
                     f'style="color:#3d8bfd;word-break:break-all">{h.escape(url)}</a></p>')
    if footer:
        parts.append(f'<p style="margin:16px 0 0;font-size:12px;color:#94a3b8">{h.escape(footer)}</p>')
    return ('<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f1f5f9;padding:24px">'
            '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">'
            '<div style="font-weight:700;font-size:15px;margin-bottom:20px;color:#0b1220">Bluesand<span style="color:#e2b866">AI</span></div>'
            + "".join(parts) + "</div></div>")

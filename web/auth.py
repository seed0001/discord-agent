"""Password login with signed session-cookie tokens."""
import hashlib
import hmac
import secrets
import time

from fastapi import HTTPException, Request

import config

# If SECRET_KEY isn't set, generate one per process (sessions reset on restart).
_SECRET = (config.SECRET_KEY or secrets.token_hex(32)).encode()
TOKEN_TTL = 7 * 86400  # 7 days


def _sign(payload: str) -> str:
    return hmac.new(_SECRET, payload.encode(), hashlib.sha256).hexdigest()


def create_token() -> str:
    expiry = str(int(time.time()) + TOKEN_TTL)
    return f"{expiry}.{_sign(expiry)}"


def verify_token(token: str) -> bool:
    try:
        expiry, sig = token.split(".", 1)
    except ValueError:
        return False
    if not hmac.compare_digest(sig, _sign(expiry)):
        return False
    try:
        return int(expiry) > time.time()
    except ValueError:
        return False


def check_password(password: str) -> bool:
    if not config.DASHBOARD_PASSWORD:
        return False
    return hmac.compare_digest(password.encode(), config.DASHBOARD_PASSWORD.encode())


def require_auth(request: Request) -> None:
    token = request.cookies.get("session", "")
    if not verify_token(token):
        raise HTTPException(status_code=401, detail="Not authenticated")

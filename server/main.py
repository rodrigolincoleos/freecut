import asyncio
import logging
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import jwt
from pydantic import BaseModel
from jwt import PyJWKClient
from jwt.exceptions import InvalidTokenError, PyJWKClientConnectionError, PyJWKClientError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("freecut.transcription")

MAX_UPLOAD_BYTES = int(os.environ.get("FREECUT_MAX_UPLOAD_BYTES", 512 * 1024 * 1024))
MAX_SEGMENTS = 5000
MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
CPU_THREADS = int(os.environ.get("WHISPER_CPU_THREADS", "4"))
AUTH0_DOMAIN = os.environ.get("AUTH0_DOMAIN", "").strip()
AUTH0_AUDIENCE = os.environ.get("AUTH0_AUDIENCE", "").strip()
AUTH0_ISSUER = f"https://{AUTH0_DOMAIN}/" if AUTH0_DOMAIN else ""
AUTH0_REQUIRED_SCOPE = os.environ.get("AUTH0_REQUIRED_SCOPE", "transcribe:run").strip()
AUTH0_CLAIMS_NAMESPACE = "https://freecut.cincodadosrojos3d.cl/"
AUTH0_JWKS_CLIENT = PyJWKClient(f"https://{AUTH0_DOMAIN}/.well-known/jwks.json") if AUTH0_DOMAIN else None

app = FastAPI(title="FreeCut Transcription", docs_url=None, redoc_url=None, openapi_url=None)
bearer_scheme = HTTPBearer(auto_error=False)
transcription_lock = asyncio.Semaphore(1)
model_lock = threading.Lock()
model = None


class CaptionSegment(BaseModel):
    start: float
    end: float
    text: str


class TranscriptionResult(BaseModel):
    language: str | None
    segments: list[CaptionSegment]


class ModelInitializationError(Exception):
    pass


def verify_access_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=401,
            detail="Se requiere un access token Bearer válido.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not AUTH0_DOMAIN or not AUTH0_AUDIENCE or AUTH0_JWKS_CLIENT is None:
        logger.error("Auth0 API validation is not configured.")
        raise HTTPException(status_code=503, detail="La autenticación de la API no está configurada.")

    try:
        signing_key = AUTH0_JWKS_CLIENT.get_signing_key_from_jwt(credentials.credentials)
        claims = jwt.decode(
            credentials.credentials,
            signing_key.key,
            algorithms=["RS256"],
            audience=AUTH0_AUDIENCE,
            issuer=AUTH0_ISSUER,
            options={"require": ["exp", "iss", "aud", "sub"]},
        )
    except PyJWKClientConnectionError as error:
        logger.error("Could not retrieve Auth0 signing keys: %s", error)
        raise HTTPException(status_code=503, detail="No se pudo validar la sesión con Auth0.") from error
    except (InvalidTokenError, PyJWKClientError, ValueError):
        raise HTTPException(
            status_code=401,
            detail="El access token no es válido o expiró.",
            headers={"WWW-Authenticate": "Bearer"},
        ) from None

    if not isinstance(claims.get("sub"), str) or not claims["sub"]:
        raise HTTPException(
            status_code=401,
            detail="El access token no contiene una identidad válida.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return claims


def require_transcription_permission(claims: dict = Depends(verify_access_token)) -> dict:
    if claims.get(f"{AUTH0_CLAIMS_NAMESPACE}email_verified") is not True:
        raise HTTPException(status_code=403, detail="Debes verificar tu correo electrónico para transcribir.")
    roles = claims.get(f"{AUTH0_CLAIMS_NAMESPACE}roles", [])
    if not isinstance(roles, list) or not any(role in roles for role in ("USER", "ADMIN")):
        raise HTTPException(status_code=403, detail="Tu cuenta no tiene acceso a FreeCut.")
    scopes = set(claims.get("scope", "").split()) if isinstance(claims.get("scope", ""), str) else set()
    permissions = claims.get("permissions", [])
    if not isinstance(permissions, list):
        permissions = []
    if AUTH0_REQUIRED_SCOPE not in scopes and AUTH0_REQUIRED_SCOPE not in permissions:
        raise HTTPException(status_code=403, detail="No tienes permiso para transcribir videos.")
    return claims


def get_model():
    global model
    if model is not None:
        return model
    with model_lock:
        if model is not None:
            return model
        try:
            from faster_whisper import WhisperModel

            model = WhisperModel(
                MODEL_NAME,
                device="cpu",
                compute_type="int8",
                cpu_threads=CPU_THREADS,
            )
        except Exception as error:
            logger.exception("Could not load the local Whisper model.")
            raise ModelInitializationError from error
    return model


def transcribe_file(path: str, language: str | None) -> TranscriptionResult:
    engine = get_model()
    segments, info = engine.transcribe(
        path,
        language=language,
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=False,
        word_timestamps=False,
    )
    captions: list[CaptionSegment] = []
    for segment in segments:
        text = segment.text.strip()
        start = max(0.0, float(segment.start))
        end = max(start, float(segment.end))
        if text and end > start:
            captions.append(CaptionSegment(start=start, end=end, text=text[:2000]))
        if len(captions) > MAX_SEGMENTS:
            raise ValueError("El clip genera demasiados segmentos de subtítulo.")
    return TranscriptionResult(language=info.language, segments=captions)


@app.get("/health")
async def health():
    if not AUTH0_DOMAIN or not AUTH0_AUDIENCE or AUTH0_JWKS_CLIENT is None:
        raise HTTPException(status_code=503, detail="La autenticación de la API no está configurada.")
    return {"status": "ok"}


@app.post("/transcribe", response_model=TranscriptionResult)
async def transcribe(
    file: UploadFile = File(...),
    language: Literal["es", "en", "auto"] = Form("es"),
    token_claims: dict = Depends(require_transcription_permission),
):
    temporary_path: str | None = None
    try:
        async with transcription_lock:
            suffix = Path(file.filename or "").suffix.lower()
            if not re.fullmatch(r"\.[a-z0-9]{1,10}", suffix):
                suffix = ""

            size = 0
            with tempfile.NamedTemporaryFile(prefix="freecut-", suffix=suffix, delete=False) as target:
                temporary_path = target.name
                while True:
                    chunk = await file.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail="El archivo supera el límite de 512 MB.",
                        )
                    target.write(chunk)

            if size == 0:
                raise HTTPException(status_code=400, detail="El archivo está vacío.")

            try:
                return await asyncio.to_thread(
                    transcribe_file,
                    temporary_path,
                    None if language == "auto" else language,
                )
            except ModelInitializationError:
                raise HTTPException(
                    status_code=503,
                    detail="No se pudo cargar el modelo local de transcripción. Revisa la conexión del servidor y vuelve a intentar.",
                ) from None
            except Exception as error:
                logger.exception("Transcription failed.")
                raise HTTPException(
                    status_code=422,
                    detail="No se pudo leer o transcribir el audio de este archivo.",
                ) from error
    finally:
        await file.close()
        if temporary_path:
            try:
                os.unlink(temporary_path)
            except FileNotFoundError:
                pass
            except OSError:
                logger.exception("Could not remove a temporary transcription upload.")

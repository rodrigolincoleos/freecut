import asyncio
import logging
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("freecut.transcription")

MAX_UPLOAD_BYTES = int(os.environ.get("FREECUT_MAX_UPLOAD_BYTES", 512 * 1024 * 1024))
MAX_SEGMENTS = 5000
MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
CPU_THREADS = int(os.environ.get("WHISPER_CPU_THREADS", "4"))

app = FastAPI(title="FreeCut Transcription", docs_url=None, redoc_url=None, openapi_url=None)
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
    return {"status": "ok"}


@app.post("/transcribe", response_model=TranscriptionResult)
async def transcribe(
    file: UploadFile = File(...),
    language: Literal["es", "en", "auto"] = Form("es"),
    x_freecut_request: str = Header(..., alias="X-FreeCut-Request"),
):
    temporary_path: str | None = None
    try:
        if x_freecut_request != "transcribe":
            raise HTTPException(status_code=403, detail="Solicitud no autorizada.")
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

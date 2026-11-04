import asyncio
import io
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import av
from fastapi import HTTPException
from starlette.datastructures import UploadFile

import main


class TranscriptionTests(unittest.TestCase):
    def test_pyav_version_keeps_faster_whisper_decode_compatibility(self):
        self.assertLess(int(av.__version__.split(".")[0]), 19)

    def test_transcribe_file_maps_non_empty_segments(self):
        fake_model = SimpleNamespace(
            transcribe=lambda *_args, **_kwargs: (
                iter([
                    SimpleNamespace(start=0.25, end=1.5, text=" Hola "),
                    SimpleNamespace(start=2.0, end=2.0, text=""),
                ]),
                SimpleNamespace(language="es"),
            )
        )
        with patch.object(main, "model", fake_model):
            result = main.transcribe_file("unused.media", "es")
        self.assertEqual(result.language, "es")
        self.assertEqual(len(result.segments), 1)
        self.assertEqual(result.segments[0].text, "Hola")
        self.assertEqual(result.segments[0].start, 0.25)

    def test_transcribe_removes_temporary_upload(self):
        upload = UploadFile(filename="clip.mp4", file=io.BytesIO(b"video"))
        with patch.object(
            main,
            "transcribe_file",
            return_value=main.TranscriptionResult(language="es", segments=[]),
        ) as transcribe_file:
            asyncio.run(main.transcribe(upload, "es", "transcribe"))
        temporary_path = transcribe_file.call_args.args[0]
        self.assertFalse(Path(temporary_path).exists())
        self.assertTrue(upload.file.closed)

    def test_rejects_uploads_over_limit_and_cleans_up(self):
        upload = UploadFile(filename="clip.mp4", file=io.BytesIO(b"video"))
        with patch.object(main, "MAX_UPLOAD_BYTES", 4):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(main.transcribe(upload, "es", "transcribe"))
        self.assertEqual(error.exception.status_code, 413)
        self.assertTrue(upload.file.closed)

    def test_rejects_requests_without_same_origin_header(self):
        upload = UploadFile(filename="clip.mp4", file=io.BytesIO(b"video"))
        with self.assertRaises(HTTPException) as error:
            asyncio.run(main.transcribe(upload, "es", ""))
        self.assertEqual(error.exception.status_code, 403)
        self.assertTrue(upload.file.closed)


if __name__ == "__main__":
    unittest.main()

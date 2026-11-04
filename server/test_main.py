import asyncio
import io
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import av
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from jwt import InvalidTokenError
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
            asyncio.run(main.transcribe(upload, "es", {"sub": "auth0|tester"}))
        temporary_path = transcribe_file.call_args.args[0]
        self.assertFalse(Path(temporary_path).exists())
        self.assertTrue(upload.file.closed)

    def test_rejects_uploads_over_limit_and_cleans_up(self):
        upload = UploadFile(filename="clip.mp4", file=io.BytesIO(b"video"))
        with patch.object(main, "MAX_UPLOAD_BYTES", 4):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(main.transcribe(upload, "es", {"sub": "auth0|tester"}))
        self.assertEqual(error.exception.status_code, 413)
        self.assertTrue(upload.file.closed)


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.valid_user = {
            "sub": "auth0|tester",
            "scope": "transcribe:run",
            "https://freecut.cincodadosrojos3d.cl/email_verified": True,
            "https://freecut.cincodadosrojos3d.cl/roles": ["USER"],
        }

    def test_rejects_missing_bearer_token(self):
        with self.assertRaises(HTTPException) as error:
            main.verify_access_token(None)
        self.assertEqual(error.exception.status_code, 401)
        self.assertEqual(error.exception.headers["WWW-Authenticate"], "Bearer")

    def test_rejects_invalid_or_expired_access_token(self):
        jwks = Mock()
        jwks.get_signing_key_from_jwt.return_value = SimpleNamespace(key="public-key")
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="expired-token")
        with (
            patch.object(main, "AUTH0_DOMAIN", "tenant.auth0.com"),
            patch.object(main, "AUTH0_AUDIENCE", "https://api.freecut.cincodadosrojos3d.cl"),
            patch.object(main, "AUTH0_ISSUER", "https://tenant.auth0.com/"),
            patch.object(main, "AUTH0_JWKS_CLIENT", jwks),
            patch.object(main.jwt, "decode", side_effect=InvalidTokenError("expired")),
        ):
            with self.assertRaises(HTTPException) as error:
                main.verify_access_token(credentials)
        self.assertEqual(error.exception.status_code, 401)

    def test_validates_auth0_issuer_audience_and_rsa_algorithm(self):
        jwks = Mock()
        jwks.get_signing_key_from_jwt.return_value = SimpleNamespace(key="public-key")
        claims = {"sub": "auth0|tester", "scope": "transcribe:run"}
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials="valid-token")
        with (
            patch.object(main, "AUTH0_DOMAIN", "tenant.auth0.com"),
            patch.object(main, "AUTH0_AUDIENCE", "https://api.freecut.cincodadosrojos3d.cl"),
            patch.object(main, "AUTH0_ISSUER", "https://tenant.auth0.com/"),
            patch.object(main, "AUTH0_JWKS_CLIENT", jwks),
            patch.object(main.jwt, "decode", return_value=claims) as decode,
        ):
            result = main.verify_access_token(credentials)
        self.assertEqual(result["sub"], "auth0|tester")
        self.assertEqual(decode.call_args.kwargs["algorithms"], ["RS256"])
        self.assertEqual(decode.call_args.kwargs["audience"], "https://api.freecut.cincodadosrojos3d.cl")
        self.assertEqual(decode.call_args.kwargs["issuer"], "https://tenant.auth0.com/")
        self.assertEqual(decode.call_args.kwargs["options"]["require"], ["exp", "iss", "aud", "sub"])

    def test_rejects_missing_transcription_permission(self):
        with self.assertRaises(HTTPException) as error:
            main.require_transcription_permission({**self.valid_user, "scope": "openid profile"})
        self.assertEqual(error.exception.status_code, 403)

    def test_accepts_transcription_permission_from_scope_or_rbac_claim(self):
        claims = dict(self.valid_user)
        self.assertEqual(main.require_transcription_permission(claims), claims)
        admin = {
            **self.valid_user,
            "https://freecut.cincodadosrojos3d.cl/roles": ["USER", "ADMIN"],
        }
        self.assertEqual(main.require_transcription_permission(admin), admin)
        permissions = {
            **self.valid_user,
            "scope": "openid profile",
            "permissions": ["transcribe:run"],
        }
        self.assertEqual(main.require_transcription_permission(permissions), permissions)

    def test_rejects_unverified_email_and_accounts_without_app_roles(self):
        for claims in (
            {**self.valid_user, "https://freecut.cincodadosrojos3d.cl/email_verified": False},
            {**self.valid_user, "https://freecut.cincodadosrojos3d.cl/roles": []},
        ):
            with self.subTest(claims=claims):
                with self.assertRaises(HTTPException) as error:
                    main.require_transcription_permission(claims)
                self.assertEqual(error.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()

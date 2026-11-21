import subprocess
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch
from urllib.parse import unquote

from httpx import ASGITransport, AsyncClient

from mosecapy_youtube import app

ORIGIN = "https://tijoxa.github.io"
ROUTE = "/api/youtube-audio"
VIDEO = "https://youtu.be/abc123"


class YouTubeAudioTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8765")
        self.addAsyncCleanup(self.client.aclose)

    async def test_pages_preflight(self):
        response = await self.client.options(
            ROUTE,
            headers={
                "Origin": ORIGIN,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["access-control-allow-origin"], ORIGIN)

    @patch("mosecapy_youtube.subprocess.run")
    async def test_rejects_untrusted_origins_hosts_and_urls_before_starting_yt_dlp(self, run):
        for headers, url, expected_status in [
            ({}, VIDEO, 403),
            ({"Origin": "https://example.org"}, VIDEO, 403),
            ({"Origin": ORIGIN, "Host": "example.org"}, VIDEO, 400),
            ({"Origin": ORIGIN}, "https://youtube.com.example.org/watch?v=abc123", 400),
        ]:
            with self.subTest(headers=headers, url=url):
                response = await self.client.post(ROUTE, headers=headers, json={"url": url})
                self.assertEqual(response.status_code, expected_status)
        run.assert_not_called()

    @patch("mosecapy_youtube.subprocess.run")
    async def test_returns_mp3_and_cleans_up_after_the_response(self, run):
        directories = []

        def download(command, **kwargs):
            directory = Path(command[command.index("--paths") + 1])
            directories.append(directory)
            (directory / "Écouter [abc123].mp3").write_bytes(b"test mp3")
            return subprocess.CompletedProcess(command, 0, stderr="")

        run.side_effect = download
        response = await self.client.post(ROUTE, headers={"Origin": ORIGIN}, json={"url": VIDEO})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"test mp3")
        self.assertEqual(response.headers["content-type"], "audio/mpeg")
        self.assertEqual(response.headers["access-control-allow-origin"], ORIGIN)
        self.assertEqual(response.headers["access-control-expose-headers"], "X-Track-Filename")
        self.assertEqual(unquote(response.headers["x-track-filename"]), "Écouter [abc123].mp3")
        self.assertEqual(run.call_args.args[0][-2:], ["--", VIDEO])
        self.assertFalse(directories[0].exists())

    @patch("mosecapy_youtube.subprocess.run", side_effect=FileNotFoundError)
    async def test_reports_missing_yt_dlp_to_the_browser(self, run):
        response = await self.client.post(ROUTE, headers={"Origin": ORIGIN}, json={"url": VIDEO})

        self.assertEqual(response.status_code, 503)
        self.assertIn("uv tool install", response.json()["detail"])
        self.assertEqual(response.headers["access-control-allow-origin"], ORIGIN)

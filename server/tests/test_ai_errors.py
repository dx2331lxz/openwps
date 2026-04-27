from __future__ import annotations

import unittest
from unittest.mock import patch

from server.app.ai import _normalize_ai_api_error_detail
from server.app.models import ChatRequest


class AiErrorNormalizationTest(unittest.TestCase):
    def test_cloudflare_html_error_points_to_upstream_endpoint(self) -> None:
        body = ChatRequest(message="你好", providerId="custom-provider", model="gpt-5.4")
        html = (
            'Error code: 403 - "<!DOCTYPE html><html lang="en-US">'
            "<head><title>Just a moment...</title></head>"
            '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>'
            "</html>"
        )

        with patch(
            "server.app.ai._resolve_provider_and_model",
            return_value=(
                {"id": "custom-provider", "label": "sub2api", "endpoint": "https://example.invalid/v1"},
                "gpt-5.4",
            ),
        ):
            detail = _normalize_ai_api_error_detail(body, html)

        self.assertIn("Cloudflare", detail)
        self.assertIn("sub2api", detail)
        self.assertIn("不能被后端作为模型 API 直接调用", detail)
        self.assertNotIn("<!DOCTYPE", detail)


if __name__ == "__main__":
    unittest.main()

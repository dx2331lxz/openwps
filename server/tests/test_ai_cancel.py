from __future__ import annotations

import asyncio
import unittest

from server.app.ai import ReactGatewayRun, create_react_session, stream_react_gateway_run_events
from server.app.models import ChatRequest


class ReactGatewayCancelTest(unittest.TestCase):
    def test_stopped_by_client_marks_run_cancelled(self) -> None:
        async def run_case() -> None:
            session = create_react_session(ChatRequest(message="你好"))
            run = ReactGatewayRun(session=session)

            await run.append_event({"type": "done", "reason": "stopped_by_client"})

            self.assertEqual(run.status, "cancelled")
            self.assertEqual(run.snapshot()["status"], "cancelled")

        asyncio.run(run_case())

    def test_cancelled_run_event_stream_finishes(self) -> None:
        async def run_case() -> None:
            session = create_react_session(ChatRequest(message="你好"))
            run = ReactGatewayRun(session=session)
            from server.app import ai

            ai._react_gateway_runs[session.session_id] = run
            try:
                await run.append_event({"type": "done", "reason": "stopped_by_client"})
                events = []
                async for event in stream_react_gateway_run_events(session.session_id):
                    events.append(event)

                self.assertEqual(len(events), 1)
                self.assertEqual(events[0]["type"], "done")
                self.assertEqual(events[0]["reason"], "stopped_by_client")
            finally:
                ai._react_gateway_runs.pop(session.session_id, None)

        asyncio.run(run_case())


if __name__ == "__main__":
    unittest.main()

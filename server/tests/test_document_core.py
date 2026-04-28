from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
GENERATED_CORE = ROOT / "server" / "node" / ".generated" / "src" / "shared" / "document" / "tools.js"


def run_node_module(source: str) -> dict:
    if not GENERATED_CORE.exists():
        raise AssertionError("Generated document core missing. Run `npm run build:worker` first.")
    result = subprocess.run(
        ["node", "--input-type=module", "-e", source],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr or result.stdout)
    return json.loads(result.stdout)


class SharedDocumentCoreTest(unittest.TestCase):
    def test_shared_schema_parses_worker_doc_json(self) -> None:
        payload = run_node_module(
            """
            import { schema } from './server/node/.generated/src/shared/document/schema.js'
            const doc = schema.nodeFromJSON({
              type: 'doc',
              content: [{
                type: 'paragraph',
                attrs: { headingLevel: 1, align: 'center' },
                content: [{ type: 'text', text: '标题' }],
              }],
            })
            process.stdout.write(JSON.stringify({
              type: doc.type.name,
              text: doc.textContent,
              headingLevel: doc.child(0).attrs.headingLevel,
            }))
            """
        )

        self.assertEqual(payload, {"type": "doc", "text": "标题", "headingLevel": 1})

    def test_shared_core_tool_shapes_match_document_api(self) -> None:
        payload = run_node_module(
            """
            import { executeDocumentToolCore } from './server/node/.generated/src/shared/document/tools.js'
            const docJson = {
              type: 'doc',
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'hello world' }],
              }],
            }
            const search = await executeDocumentToolCore({ toolName: 'search_text', params: { text: 'hello' }, docJson })
            const styled = await executeDocumentToolCore({
              toolName: 'set_paragraph_style',
              params: { range: { type: 'paragraph', paragraphIndex: 0 }, headingLevel: 2 },
              docJson,
            })
            process.stdout.write(JSON.stringify({
              searchSuccess: search.success,
              matchCount: search.data.matchCount,
              styledSuccess: styled.success,
              headingLevel: styled.docJson.content[0].attrs.headingLevel,
            }))
            """
        )

        self.assertEqual(payload, {
            "searchSuccess": True,
            "matchCount": 1,
            "styledSuccess": True,
            "headingLevel": 2,
        })


if __name__ == "__main__":
    unittest.main()

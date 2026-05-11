import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from polaris_webhook_verify import VerifyInput, verify


class VectorTests(unittest.TestCase):
    def test_vectors(self):
        path = os.path.normpath(
            os.path.join(HERE, "..", "..", "test-vectors", "vectors.json")
        )
        with open(path) as f:
            vectors = json.load(f)["vectors"]
        for v in vectors:
            with self.subTest(v["name"]):
                r = verify(
                    VerifyInput(
                        direction=v["direction"],
                        method=v["method"],
                        path=v["path"],
                        query=v["query"],
                        headers={
                            "X-Polaris-Ts": v["ts"],
                            "X-Polaris-Nonce": v["nonce"],
                            "X-Polaris-Sig": v["expected_sig"],
                        },
                        body=v["body"].encode("utf-8"),
                        secret=v["secret"].encode("utf-8"),
                        now_ms=int(v["ts"]),
                    )
                )
                if v["must_verify"]:
                    self.assertTrue(r.ok, msg=f"vector {v['name']} got code={r.code} msg={r.message}")
                else:
                    self.assertFalse(r.ok)
                    expected = v.get("expected_error")
                    if expected:
                        self.assertEqual(r.code, expected)


if __name__ == "__main__":
    unittest.main()

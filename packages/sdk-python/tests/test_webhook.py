"""Verifier tests against the shared test-vectors fixture."""
import json
import os
import unittest

from polaris_sdk.webhook import VerifyInput, verify_webhook


HERE = os.path.dirname(__file__)
VECTORS_PATH = os.path.normpath(os.path.join(HERE, "..", "..", "test-vectors", "vectors.json"))


class TestVerifyWebhook(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(VECTORS_PATH) as f:
            cls.vectors = json.load(f)["vectors"]

    def test_shared_vectors(self):
        for v in self.vectors:
            with self.subTest(name=v["name"]):
                inp = VerifyInput(
                    direction=v["direction"],
                    method=v["method"],
                    path=v["path"],
                    query=v.get("query", ""),
                    headers={
                        "x-polaris-ts": v["ts"],
                        "x-polaris-nonce": v["nonce"],
                        "x-polaris-sig": v["expected_sig"],
                    },
                    body=v["body"].encode("utf-8"),
                    secret=v["secret"].encode("utf-8"),
                    now_ms=int(v["ts"]),
                )
                res = verify_webhook(inp)
                if v["must_verify"]:
                    self.assertTrue(res.ok, f"expected ok for {v['name']}: {res}")
                else:
                    self.assertFalse(res.ok, f"expected fail for {v['name']}: {res}")

    def test_v2_tag_accepted_by_default(self):
        v = next(x for x in self.vectors if x["must_verify"])
        v2_sig = "v2=" + v["expected_sig"][3:]
        inp = VerifyInput(
            direction=v["direction"],
            method=v["method"],
            path=v["path"],
            query=v.get("query", ""),
            headers={
                "x-polaris-ts": v["ts"],
                "x-polaris-nonce": v["nonce"],
                "x-polaris-sig": v2_sig,
            },
            body=v["body"].encode("utf-8"),
            secret=v["secret"].encode("utf-8"),
            now_ms=int(v["ts"]),
        )
        self.assertTrue(verify_webhook(inp).ok)


if __name__ == "__main__":
    unittest.main()

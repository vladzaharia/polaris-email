"""polaris-sdk — Python SDK for polaris-email.

Hand-written:
    - ``polaris_sdk.webhook.verify_webhook`` — verifies HMAC v2 webhook deliveries.

Generated (`pnpm --filter @polaris/sdk-codegen run generate`):
    - ``polaris_sdk.generated`` — httpx + Pydantic v2 client.

The generated package may be absent on machines that haven't run the codegen
toolchain; the webhook verifier has no dependency on it.
"""

from .webhook import verify_webhook, VerifyInput, VerifyResult

__all__ = ["verify_webhook", "VerifyInput", "VerifyResult"]

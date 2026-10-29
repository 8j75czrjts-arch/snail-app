"""Make a VAPID key pair for web push.   pip install pywebpush && python3 scripts/gen_vapid.py

Put the two printed values in Vercel as VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.
"""
import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
key = ec.generate_private_key(ec.SECP256R1())
raw_private = key.private_numbers().private_value.to_bytes(32, "big")
raw_public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
print("VAPID_PUBLIC_KEY =", b64(raw_public))
print("VAPID_PRIVATE_KEY =", b64(raw_private))

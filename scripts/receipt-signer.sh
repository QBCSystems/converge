#!/bin/sh
# converge's receipt signer outside the engine: the engine runs `receipt-signer.sh public` once (the Ed25519 public key,
# 64 hex) and `receipt-signer.sh sign` for each receipt (the bytes on stdin, the signature out as 128 hex), and checks
# every signature against that public key before it uses it. The private key stays in the key service.
#
#   CONVERGE_RECEIPT_SIGNER="sh scripts/receipt-signer.sh" npm run dev        (or converge-engine --receipt-signer ...)
#
# Backends (RECEIPT_SIGNER_BACKEND):
#   gcloud   Google Cloud KMS, an EC_SIGN_ED25519 key version:
#            RECEIPT_KMS_KEY=projects/P/locations/L/keyRings/R/cryptoKeys/K/cryptoKeyVersions/1
#   vault    HashiCorp Vault transit, an ed25519 key: RECEIPT_VAULT_KEY=<name> (VAULT_ADDR, VAULT_TOKEN as usual)
#   openssl  a PEM key file on this machine (RECEIPT_KEY_PEM): no key service, for trying the interface out
set -eu
op="${1:-}"
backend="${RECEIPT_SIGNER_BACKEND:-openssl}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

hex() { od -An -v -tx1 | tr -d ' \n'; }
# the last 32 bytes of an Ed25519 SubjectPublicKeyInfo (DER) are the raw key
raw_pub_from_pem() { openssl pkey -pubin -in "$1" -outform DER | tail -c 32 | hex; }

case "$backend:$op" in
  openssl:public)
    openssl pkey -in "${RECEIPT_KEY_PEM:?RECEIPT_KEY_PEM: the key file}" -pubout -outform DER | tail -c 32 | hex ;;
  openssl:sign)
    cat > "$tmp/msg"
    openssl pkeyutl -sign -inkey "${RECEIPT_KEY_PEM:?}" -rawin -in "$tmp/msg" | hex ;;
  gcloud:public)
    gcloud kms keys versions get-public-key "${RECEIPT_KMS_KEY:?RECEIPT_KMS_KEY: the key version}" --output-file "$tmp/pub.pem" >/dev/null
    raw_pub_from_pem "$tmp/pub.pem" ;;
  gcloud:sign)
    cat > "$tmp/msg"
    gcloud kms asymmetric-sign --version "${RECEIPT_KMS_KEY:?}" --input-file "$tmp/msg" --signature-file "$tmp/sig" >/dev/null
    hex < "$tmp/sig" ;;
  vault:public)
    vault read -field=keys -format=json "transit/keys/${RECEIPT_VAULT_KEY:?RECEIPT_VAULT_KEY: the transit key}" \
      | sed -n 's/.*"public_key": *"\([^"]*\)".*/\1/p' | tail -n 1 | base64 -d | hex ;;
  vault:sign)
    vault write -field=signature "transit/sign/${RECEIPT_VAULT_KEY:?}" input="$(base64 | tr -d '\n')" \
      | sed 's/^vault:v[0-9]*://' | base64 -d | hex ;;
  *)
    echo "usage: receipt-signer.sh public|sign   (RECEIPT_SIGNER_BACKEND=openssl|gcloud|vault)" >&2
    exit 2 ;;
esac

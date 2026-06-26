#!/usr/bin/env bash
#---------------------------------------------------------------------------------------------
#  Copyright (c) Microsoft Corporation. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
#--------------------------------------------------------------------------------------------

# Creates a temporary keychain containing a freshly generated self-signed
# code signing certificate and prints the resulting code signing identity
# (SHA-1) on stdout.
#
# This avoids depending on an Apple Developer certificate pulled from KeyVault.
# The signature produced with this certificate is only used to apply the
# hardened runtime entitlements to the binaries before they are properly
# re-signed and notarized by ESRP later in the pipeline.

set -e

TEMP_DIR="$1"
if [ -z "$TEMP_DIR" ]; then
	echo "Usage: $0 <temp-directory>" >&2
	exit 1
fi

KEYCHAIN="$TEMP_DIR/buildagent.keychain"
KEYCHAIN_PASSWORD="pwd"
CERT_NAME="VSCode Self-Signed Codesign"

# Create and activate a dedicated keychain.
security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >&2
security default-keychain -s "$KEYCHAIN" >&2
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >&2

# Generate a self-signed certificate that is valid for code signing.
cat > "$TEMP_DIR/codesign.cnf" <<EOF
[ req ]
distinguished_name = req_distinguished_name
x509_extensions = codesign_extensions
prompt = no

[ req_distinguished_name ]
CN = $CERT_NAME

[ codesign_extensions ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes \
	-keyout "$TEMP_DIR/codesign-key.pem" \
	-out "$TEMP_DIR/codesign-cert.pem" \
	-days 365 \
	-config "$TEMP_DIR/codesign.cnf" >&2

# Import the private key and the certificate as separate PEM files. We avoid a
# PKCS#12 bundle on purpose: depending on which `openssl` is first on PATH (the
# build agents may resolve to OpenSSL 3.x), the generated PKCS#12 uses a MAC
# algorithm that Apple's `security` tool cannot verify, which fails the import
# with "MAC verification failed". Importing the PEM files individually sidesteps
# this entirely; the keychain pairs the key and certificate into a usable
# identity automatically once both are present.
security import "$TEMP_DIR/codesign-key.pem" -k "$KEYCHAIN" -T /usr/bin/codesign >&2
security import "$TEMP_DIR/codesign-cert.pem" -k "$KEYCHAIN" -T /usr/bin/codesign >&2
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >&2

# Trust the self-signed certificate for code signing so that it is reported as a
# valid identity by `security find-identity -v -p codesigning`.
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TEMP_DIR/codesign-cert.pem" >&2

# Remove the intermediate key material now that it lives in the keychain.
rm -f "$TEMP_DIR/codesign-key.pem" "$TEMP_DIR/codesign-cert.pem" "$TEMP_DIR/codesign.cnf"

# Emit the code signing identity (SHA-1) for the caller to consume.
security find-identity -v -p codesigning "$KEYCHAIN" | grep -oEi "([0-9A-F]{40})" | head -n 1

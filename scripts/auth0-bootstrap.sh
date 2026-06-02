#!/usr/bin/env bash
#
# Auth0 bootstrap for the CobbleCompanion Pulumi stack.
#
# Automates the parts of infra/README.md "Auth0 manual bootstrap" that are pure
# Management-API calls (steps 3-6): creates (or reuses) the Pulumi M2M app,
# authorizes it for the Management API, fetches its client-grant id, and checks
# the google-oauth2 connection. Idempotent — safe to re-run.
#
# Two things this CANNOT do (they're account-level / browser-based, not
# Management-API operations):
#   1. Create the tenant       — do it in the dashboard first (infra/README.md step 1)
#   2. `auth0 login`           — interactive browser auth; run it yourself
#
# Prereqs: auth0 CLI (`brew install auth0/auth0-cli/auth0`) + jq, logged in to
# the target tenant (`auth0 login` then `auth0 tenants use <domain>`).
#
# Usage:
#   scripts/auth0-bootstrap.sh [--domain <tenant-domain>] [--app-name <name>]
#
# Env equivalents: AUTH0_DOMAIN, M2M_APP_NAME.

set -euo pipefail

APP_NAME="${M2M_APP_NAME:-Pulumi-IaC}"
DOMAIN="${AUTH0_DOMAIN:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --app-name) APP_NAME="$2"; shift 2 ;;
    -h|--help) grep -E '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

# -- Preflight ---------------------------------------------------------------
command -v auth0 >/dev/null || { echo "auth0 CLI not found — brew install auth0/auth0-cli/auth0" >&2; exit 1; }
command -v jq    >/dev/null || { echo "jq not found — brew install jq" >&2; exit 1; }

# Confirm we're logged in (any Management API read works as a probe).
if ! auth0 api get connections >/dev/null 2>&1; then
  echo "Not logged in to Auth0. Run: auth0 login   (then: auth0 tenants use <domain>)" >&2
  exit 1
fi

# Resolve the tenant domain if not supplied.
if [ -z "$DOMAIN" ]; then
  DOMAIN="$(auth0 tenants list 2>/dev/null | grep -oE '[a-zA-Z0-9._-]+\.auth0\.com' | head -1 || true)"
fi
if [ -z "$DOMAIN" ]; then
  echo "Could not determine the tenant domain. Pass --domain <tenant>.us.auth0.com" >&2
  exit 1
fi
MGMT_AUDIENCE="https://${DOMAIN}/api/v2/"
echo "→ tenant: ${DOMAIN}"

# Scopes the Pulumi provider needs — keep in sync with infra/auth0/src/m2m.ts.
SCOPES_JSON='[
  "read:clients","create:clients","update:clients","delete:clients",
  "read:client_grants","create:client_grants","update:client_grants","delete:client_grants",
  "read:resource_servers","create:resource_servers","update:resource_servers","delete:resource_servers",
  "read:connections","create:connections","update:connections","delete:connections",
  "read:users","create:users","update:users","delete:users",
  "read:actions","create:actions","update:actions","delete:actions"
]'

# -- Step 3: create or reuse the M2M app -------------------------------------
CLIENT_ID="$(auth0 apps list --json 2>/dev/null \
  | jq -r --arg n "$APP_NAME" '.[] | select(.name==$n) | .client_id' | head -1)"

if [ -n "$CLIENT_ID" ]; then
  echo "→ reusing existing app \"$APP_NAME\" ($CLIENT_ID)"
else
  echo "→ creating M2M app \"$APP_NAME\""
  CREATE_JSON="$(auth0 apps create \
    --name "$APP_NAME" \
    --type m2m \
    --description "M2M app used by Pulumi to manage the Auth0 tenant" \
    --reveal-secrets --json)"
  CLIENT_ID="$(echo "$CREATE_JSON" | jq -r '.client_id')"
fi

# Read the secret (always via apps show so the reuse path also gets it).
CLIENT_SECRET="$(auth0 apps show "$CLIENT_ID" --reveal-secrets --json | jq -r '.client_secret')"

# -- Step 4: authorize for the Management API (create grant if missing) ------
GRANT_ID="$(auth0 api get client-grants 2>/dev/null \
  | jq -r --arg c "$CLIENT_ID" --arg a "$MGMT_AUDIENCE" \
      '.[] | select(.client_id==$c and .audience==$a) | .id' | head -1)"

if [ -n "$GRANT_ID" ]; then
  echo "→ Management API grant already exists ($GRANT_ID)"
else
  echo "→ granting Management API scopes"
  GRANT_JSON="$(jq -n \
    --arg c "$CLIENT_ID" --arg a "$MGMT_AUDIENCE" --argjson s "$SCOPES_JSON" \
    '{client_id:$c, audience:$a, scope:$s}')"
  auth0 api post client-grants --data "$GRANT_JSON" >/dev/null
  GRANT_ID="$(auth0 api get client-grants \
    | jq -r --arg c "$CLIENT_ID" --arg a "$MGMT_AUDIENCE" \
        '.[] | select(.client_id==$c and .audience==$a) | .id' | head -1)"
fi

# -- Step 6: verify the google-oauth2 connection exists ----------------------
if auth0 api get connections | jq -e '.[] | select(.name=="google-oauth2")' >/dev/null; then
  echo "→ google-oauth2 connection present"
else
  echo "⚠ google-oauth2 connection NOT found — create it under Authentication → Social → Google" >&2
fi

# -- Summary + next steps ----------------------------------------------------
cat <<SUMMARY

──────────────────────────────────────────────────────────────────────────────
Auth0 bootstrap complete. Save these to 1Password (the secret won't reprint):

  tenant domain    : ${DOMAIN}
  M2M client id    : ${CLIENT_ID}
  M2M client secret: ${CLIENT_SECRET}
  M2M grant id     : ${GRANT_ID}

Next — from infra/auth0/ (see infra/auth0/README.md Phase B–C):

  export PULUMI_CONFIG_PASSPHRASE='<reuse CobbleBrowse's>'
  pulumi login s3://<shared-state-bucket>
  pnpm install --ignore-workspace
  pulumi stack init dev --secrets-provider passphrase

  pulumi config set         auth0:domain       ${DOMAIN}
  pulumi config set         auth0:clientId     ${CLIENT_ID}
  pulumi config set --secret auth0:clientSecret ${CLIENT_SECRET}
  pulumi config set         cobblecompanion-auth0:apiAudience https://api.cobblecompanion.local
  pulumi config set --path  'cobblecompanion-auth0:allowedEmails[0]' cobblestamp@gmail.com

  pulumi import auth0:index/client:Client          pulumi-iac       ${CLIENT_ID}
  pulumi import auth0:index/clientGrant:ClientGrant pulumi-iac-grant ${GRANT_ID}

  pulumi up
──────────────────────────────────────────────────────────────────────────────
SUMMARY

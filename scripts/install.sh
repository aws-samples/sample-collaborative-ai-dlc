#!/usr/bin/env bash
set -euo pipefail
umask 077
export AWS_PAGER=""

APP_NAME="collaborative-ai-dlc"
DEFAULT_REPOSITORY="https://github.com/aws-samples/sample-collaborative-ai-dlc.git"
DATA_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/$APP_NAME"
CONFIG_ROOT="${XDG_CONFIG_HOME:-$HOME/.config}/$APP_NAME"
RELEASES_DIR="$DATA_ROOT/releases"
CHECKOUTS_DIR="$DATA_ROOT/checkouts"
CURRENT_LINK="$DATA_ROOT/current"
CONFIG_FILE="$CONFIG_ROOT/install.conf"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

COMMAND="${1:-}"
[[ -n "$COMMAND" ]] && shift || true

VERSION="${AIDLC_VERSION:-}"
REF="${AIDLC_REF:-}"
ENVIRONMENT="${AIDLC_ENVIRONMENT:-dev}"
REGION="${AIDLC_REGION:-${AWS_REGION:-us-east-1}}"
PROFILE="${AIDLC_AWS_PROFILE:-${AWS_PROFILE:-}}"
ADMIN_USERNAME="${AIDLC_ADMIN_USERNAME:-}"
REPOSITORY_URL="${AIDLC_REPOSITORY_URL:-$DEFAULT_REPOSITORY}"
APP_DOMAIN="${AIDLC_APP_DOMAIN:-}"
APP_DOMAIN_ALIASES="${AIDLC_APP_DOMAIN_ALIASES:-}"
ACM_CERTIFICATE_ARN="${AIDLC_ACM_CERTIFICATE_ARN:-}"
ROUTE53_ZONE_ID="${AIDLC_ROUTE53_ZONE_ID:-}"
AUTH_MODE="${AIDLC_AUTH_MODE:-local}"
SSO_CONFIG_FILE="${AIDLC_SSO_CONFIG_FILE:-}"
SSO_PROVIDERS_JSON="${AIDLC_SSO_PROVIDERS_JSON:-}"
[[ -n "$SSO_PROVIDERS_JSON" ]] || SSO_PROVIDERS_JSON="{}"
ENVIRONMENT_EXPLICIT="${AIDLC_ENVIRONMENT+x}"
REGION_EXPLICIT="${AIDLC_REGION+x}"
PROFILE_EXPLICIT="${AIDLC_AWS_PROFILE+x}"
ADMIN_EXPLICIT="${AIDLC_ADMIN_USERNAME+x}"
REPOSITORY_EXPLICIT="${AIDLC_REPOSITORY_URL+x}"
VERSION_EXPLICIT="${AIDLC_VERSION+x}"
REF_EXPLICIT="${AIDLC_REF+x}"
APP_DOMAIN_EXPLICIT="${AIDLC_APP_DOMAIN+x}"
APP_DOMAIN_ALIASES_EXPLICIT="${AIDLC_APP_DOMAIN_ALIASES+x}"
ACM_CERTIFICATE_ARN_EXPLICIT="${AIDLC_ACM_CERTIFICATE_ARN+x}"
ROUTE53_ZONE_ID_EXPLICIT="${AIDLC_ROUTE53_ZONE_ID+x}"
DOMAIN_OPTION_EXPLICIT=0
NO_DOMAIN_EXPLICIT=0
AUTH_MODE_EXPLICIT="${AIDLC_AUTH_MODE+x}"
SSO_CONFIG_EXPLICIT="${AIDLC_SSO_CONFIG_FILE+x}"
PERSISTED_AUTH_MODE="local"
SOURCE=""
ASSUME_YES="${AIDLC_YES:-0}"
ALLOW_DOWNGRADE="${AIDLC_ALLOW_DOWNGRADE:-0}"
# Binary checked by require_commands; image builds select their daemon with DOCKER_HOST.
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

usage() {
    cat <<'EOF'
Usage: install.sh <command> [options]

Commands:
  versions                     List available release versions
  install                      Install a tagged release
  adopt --source <path>        Adopt an existing v1 deployment
  update                       Update the managed deployment
  status                       Show managed installation status
  destroy                      Permanently destroy the managed environment

Options:
  --version VERSION            Select a release (default: latest SemVer)
  --ref BRANCH                 Track a branch for non-release testing
  --environment NAME           Terraform environment (default: dev)
  --region REGION              AWS region (default: us-east-1)
  --profile PROFILE            AWS CLI profile
  --admin EMAIL                Initial or existing administrator
  --repo-url URL               Release git repository
  --include-prereleases        Compatibility option; prereleases are included
  --allow-prerelease           Compatibility option; prereleases are allowed
  --allow-downgrade            Permit an explicit downgrade
  --yes                        Accept non-secret prompts

Authentication:
  --auth-mode MODE             local, hybrid, or sso-only (default: local)
  --sso-config FILE            OIDC/SAML provider configuration JSON
  --no-sso                     Set local mode and remove configured providers

Custom domain (all optional; omit every flag to serve on the CloudFront domain):
  --domain HOST                Canonical hostname, e.g. aidlc.example.com
  --domain-alias HOST          Additional hostname; repeat for more than one
  --certificate-arn ARN        Existing us-east-1 ACM certificate covering all
                               hostnames. Use this when certificates are managed
                               centrally or DNS lives outside Route53.
  --hosted-zone-id ID          Route53 hosted zone in this account. Terraform
                               creates the DNS records and, without
                               --certificate-arn, requests the certificate.
  --no-domain                  Remove a previously configured custom domain
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version) VERSION="${2:?--version requires a value}"; VERSION_EXPLICIT=1; shift 2 ;;
        --ref) REF="${2:?--ref requires a branch name}"; REF_EXPLICIT=1; shift 2 ;;
        --environment) ENVIRONMENT="${2:?--environment requires a value}"; ENVIRONMENT_EXPLICIT=1; shift 2 ;;
        --region) REGION="${2:?--region requires a value}"; REGION_EXPLICIT=1; shift 2 ;;
        --profile) PROFILE="${2:?--profile requires a value}"; PROFILE_EXPLICIT=1; shift 2 ;;
        --admin) ADMIN_USERNAME="${2:?--admin requires a value}"; ADMIN_EXPLICIT=1; shift 2 ;;
        --repo-url) REPOSITORY_URL="${2:?--repo-url requires a value}"; REPOSITORY_EXPLICIT=1; shift 2 ;;
        --source) SOURCE="${2:?--source requires a path}"; shift 2 ;;
        --auth-mode) AUTH_MODE="${2:?--auth-mode requires a value}"; AUTH_MODE_EXPLICIT=1; shift 2 ;;
        --sso-config) SSO_CONFIG_FILE="${2:?--sso-config requires a file}"; SSO_CONFIG_EXPLICIT=1; shift 2 ;;
        --no-sso)
            AUTH_MODE="local"; SSO_CONFIG_FILE=""; SSO_PROVIDERS_JSON="{}"
            AUTH_MODE_EXPLICIT=1; SSO_CONFIG_EXPLICIT=1
            shift
            ;;
        --domain) APP_DOMAIN="${2:?--domain requires a hostname}"; APP_DOMAIN_EXPLICIT=1; DOMAIN_OPTION_EXPLICIT=1; shift 2 ;;
        --domain-alias)
            APP_DOMAIN_ALIASES="${APP_DOMAIN_ALIASES:+$APP_DOMAIN_ALIASES,}${2:?--domain-alias requires a hostname}"
            APP_DOMAIN_ALIASES_EXPLICIT=1
            DOMAIN_OPTION_EXPLICIT=1
            shift 2
            ;;
        --certificate-arn) ACM_CERTIFICATE_ARN="${2:?--certificate-arn requires an ACM ARN}"; ACM_CERTIFICATE_ARN_EXPLICIT=1; DOMAIN_OPTION_EXPLICIT=1; shift 2 ;;
        --hosted-zone-id) ROUTE53_ZONE_ID="${2:?--hosted-zone-id requires a Route53 zone ID}"; ROUTE53_ZONE_ID_EXPLICIT=1; DOMAIN_OPTION_EXPLICIT=1; shift 2 ;;
        --no-domain)
            APP_DOMAIN=""; APP_DOMAIN_ALIASES=""; ACM_CERTIFICATE_ARN=""; ROUTE53_ZONE_ID=""
            APP_DOMAIN_EXPLICIT=1; APP_DOMAIN_ALIASES_EXPLICIT=1
            ACM_CERTIFICATE_ARN_EXPLICIT=1; ROUTE53_ZONE_ID_EXPLICIT=1
            NO_DOMAIN_EXPLICIT=1
            shift
            ;;
        --yes) ASSUME_YES=1; shift ;;
        --include-prereleases|--allow-prerelease) shift ;;
        --allow-downgrade) ALLOW_DOWNGRADE=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done
if [[ "$NO_DOMAIN_EXPLICIT" == 1 && "$DOMAIN_OPTION_EXPLICIT" == 1 ]]; then
    echo "--no-domain cannot be combined with --domain, --domain-alias, --certificate-arn, or --hosted-zone-id." >&2
    exit 2
fi
if [[ -n "$VERSION" && -n "$REF" ]]; then
    echo "--version and --ref are mutually exclusive." >&2
    exit 2
fi

is_semver() {
    node -e '
      const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
      process.exit(semver.test(process.argv[1]) ? 0 : 1);
    ' "$1"
}

remote_versions() {
    if [[ -n "${AIDLC_TAGS_FILE:-}" ]]; then
        sed -E 's/^v//' "$AIDLC_TAGS_FILE"
        return
    fi
    git ls-remote --tags "$REPOSITORY_URL" |
        sed -nE 's#.*refs/tags/v([^{}]+)(\^\{\})?$#\1#p' |
        sort -u
}

sorted_versions() {
    remote_versions |
        node -e '
          const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
          const parse = (version) => {
            const [withoutBuild] = version.split("+");
            const separator = withoutBuild.indexOf("-");
            const core = separator === -1 ? withoutBuild : withoutBuild.slice(0, separator);
            const prerelease = separator === -1 ? undefined : withoutBuild.slice(separator + 1);
            return { version, core: core.split(".").map(Number), pre: prerelease?.split(".") };
          };
          const compare = (a, b) => {
            let result = a.core[0] - b.core[0] || a.core[1] - b.core[1] || a.core[2] - b.core[2];
            if (!result && a.pre && !b.pre) result = -1;
            if (!result && !a.pre && b.pre) result = 1;
            if (!result && a.pre && b.pre) {
              for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
                if (a.pre[i] === undefined) { result = -1; break; }
                if (b.pre[i] === undefined) { result = 1; break; }
                if (a.pre[i] === b.pre[i]) continue;
                const an = /^\d+$/.test(a.pre[i]);
                const bn = /^\d+$/.test(b.pre[i]);
                result = an && bn
                  ? Number(a.pre[i]) - Number(b.pre[i])
                  : an ? -1 : bn ? 1 : a.pre[i].localeCompare(b.pre[i]);
                break;
              }
            }
            return result;
          };
          let input = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => { input += chunk; });
          process.stdin.on("end", () => {
            const versions = [...new Set(input.split(/\r?\n/).filter((version) => semver.test(version)))];
            process.stdout.write(versions.map(parse).sort(compare).map(({ version }) => version).join("\n"));
            if (versions.length) process.stdout.write("\n");
          });
        '
}

latest_version() {
    sorted_versions | tail -n 1
}

version_cmp() {
    node -e '
      const parse = (v) => {
        const [withoutBuild] = v.split("+");
        const separator = withoutBuild.indexOf("-");
        const core = separator === -1 ? withoutBuild : withoutBuild.slice(0, separator);
        const prerelease = separator === -1 ? undefined : withoutBuild.slice(separator + 1);
        return { core: core.split(".").map(Number), pre: prerelease?.split(".") };
      };
      const a=parse(process.argv[1]), b=parse(process.argv[2]);
      let result=a.core[0]-b.core[0] || a.core[1]-b.core[1] || a.core[2]-b.core[2];
      if (!result && a.pre && !b.pre) result=-1;
      if (!result && !a.pre && b.pre) result=1;
      if (!result && a.pre && b.pre) {
        for (let i=0; i<Math.max(a.pre.length,b.pre.length); i++) {
          if (a.pre[i] === undefined) { result=-1; break; }
          if (b.pre[i] === undefined) { result=1; break; }
          if (a.pre[i] === b.pre[i]) continue;
          const an=/^\d+$/.test(a.pre[i]), bn=/^\d+$/.test(b.pre[i]);
          result=an && bn ? Number(a.pre[i])-Number(b.pre[i]) : an ? -1 : bn ? 1 : a.pre[i].localeCompare(b.pre[i]);
          break;
        }
      }
      console.log(Math.sign(result));
    ' "$1" "$2"
}

load_config() {
    if [[ -f "$CONFIG_FILE" ]]; then
        local requested_ref="$REF"
        local requested_environment="$ENVIRONMENT"
        local requested_region="$REGION"
        local requested_profile="$PROFILE"
        local requested_admin="$ADMIN_USERNAME"
        local requested_repository="$REPOSITORY_URL"
        local requested_app_domain="$APP_DOMAIN"
        local requested_app_domain_aliases="$APP_DOMAIN_ALIASES"
        local requested_certificate_arn="$ACM_CERTIFICATE_ARN"
        local requested_zone_id="$ROUTE53_ZONE_ID"
        local requested_auth_mode="$AUTH_MODE"
        local requested_sso_config="$SSO_CONFIG_FILE"
        local requested_sso_providers="$SSO_PROVIDERS_JSON"
        # The file is written by write_config using shell-escaped values.
        # shellcheck disable=SC1090
        source "$CONFIG_FILE"
        PERSISTED_AUTH_MODE="${AIDLC_AUTH_MODE:-local}"
        ENVIRONMENT="${AIDLC_ENVIRONMENT:-$requested_environment}"
        REGION="${AIDLC_REGION:-$requested_region}"
        PROFILE="${AIDLC_AWS_PROFILE:-$requested_profile}"
        ADMIN_USERNAME="${AIDLC_ADMIN_USERNAME:-$requested_admin}"
        REPOSITORY_URL="${AIDLC_REPOSITORY_URL:-$requested_repository}"
        REF="${AIDLC_REF:-$requested_ref}"
        APP_DOMAIN="${AIDLC_APP_DOMAIN:-$requested_app_domain}"
        APP_DOMAIN_ALIASES="${AIDLC_APP_DOMAIN_ALIASES:-$requested_app_domain_aliases}"
        ACM_CERTIFICATE_ARN="${AIDLC_ACM_CERTIFICATE_ARN:-$requested_certificate_arn}"
        ROUTE53_ZONE_ID="${AIDLC_ROUTE53_ZONE_ID:-$requested_zone_id}"
        AUTH_MODE="${AIDLC_AUTH_MODE:-$requested_auth_mode}"
        SSO_PROVIDERS_JSON="${AIDLC_SSO_PROVIDERS_JSON:-$requested_sso_providers}"
        SSO_CONFIG_FILE="$requested_sso_config"
        [[ -n "$ENVIRONMENT_EXPLICIT" ]] && ENVIRONMENT="$requested_environment"
        [[ -n "$REGION_EXPLICIT" ]] && REGION="$requested_region"
        [[ -n "$PROFILE_EXPLICIT" ]] && PROFILE="$requested_profile"
        [[ -n "$ADMIN_EXPLICIT" ]] && ADMIN_USERNAME="$requested_admin"
        [[ -n "$REPOSITORY_EXPLICIT" ]] && REPOSITORY_URL="$requested_repository"
        [[ -n "$REF_EXPLICIT" ]] && REF="$requested_ref"
        [[ -n "$APP_DOMAIN_EXPLICIT" ]] && APP_DOMAIN="$requested_app_domain"
        [[ -n "$APP_DOMAIN_ALIASES_EXPLICIT" ]] && APP_DOMAIN_ALIASES="$requested_app_domain_aliases"
        [[ -n "$ACM_CERTIFICATE_ARN_EXPLICIT" ]] && ACM_CERTIFICATE_ARN="$requested_certificate_arn"
        [[ -n "$ROUTE53_ZONE_ID_EXPLICIT" ]] && ROUTE53_ZONE_ID="$requested_zone_id"
        [[ -n "$AUTH_MODE_EXPLICIT" ]] && AUTH_MODE="$requested_auth_mode"
        if [[ -n "$SSO_CONFIG_EXPLICIT" ]]; then
            SSO_CONFIG_FILE="$requested_sso_config"
            [[ -z "$requested_sso_config" ]] && SSO_PROVIDERS_JSON="$requested_sso_providers"
        fi
        if [[ -n "$VERSION_EXPLICIT" && -z "$REF_EXPLICIT" ]]; then
            REF=""
        fi
    fi
}

write_config() {
    mkdir -p "$CONFIG_ROOT"
    {
        printf 'AIDLC_ENVIRONMENT=%q\n' "$ENVIRONMENT"
        printf 'AIDLC_REGION=%q\n' "$REGION"
        printf 'AIDLC_AWS_PROFILE=%q\n' "$PROFILE"
        printf 'AIDLC_ADMIN_USERNAME=%q\n' "$ADMIN_USERNAME"
        printf 'AIDLC_REPOSITORY_URL=%q\n' "$REPOSITORY_URL"
        printf 'AIDLC_REF=%q\n' "$REF"
        printf 'AIDLC_APP_DOMAIN=%q\n' "$APP_DOMAIN"
        printf 'AIDLC_APP_DOMAIN_ALIASES=%q\n' "$APP_DOMAIN_ALIASES"
        printf 'AIDLC_ACM_CERTIFICATE_ARN=%q\n' "$ACM_CERTIFICATE_ARN"
        printf 'AIDLC_ROUTE53_ZONE_ID=%q\n' "$ROUTE53_ZONE_ID"
        printf 'AIDLC_AUTH_MODE=%q\n' "$AUTH_MODE"
        printf 'AIDLC_SSO_PROVIDERS_JSON=%q\n' "$SSO_PROVIDERS_JSON"
    } > "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
}

validate_sso_config() {
    local checkout="${1:-}" validator="$SCRIPT_DIR/sso-config.mjs"
    if [[ "$AUTH_MODE" != "local" && "$AUTH_MODE" != "hybrid" && "$AUTH_MODE" != "sso-only" ]]; then
        echo "Invalid auth mode '$AUTH_MODE'. Use local, hybrid, or sso-only." >&2
        exit 2
    fi
    if [[ "${VERSION%%.*}" -lt 2 && ( "$AUTH_MODE" != "local" || "$SSO_PROVIDERS_JSON" != "{}" || -n "$SSO_CONFIG_FILE" ) ]]; then
        echo "Enterprise SSO requires AI-DLC v2 or newer; the selected release is v$VERSION." >&2
        exit 2
    fi
    if [[ -n "$SSO_CONFIG_FILE" ]]; then
        [[ -f "$SSO_CONFIG_FILE" ]] || {
            echo "SSO configuration file not found: $SSO_CONFIG_FILE" >&2
            exit 2
        }
        if [[ -n "$checkout" && -f "$checkout/scripts/sso-config.mjs" ]]; then
            validator="$checkout/scripts/sso-config.mjs"
        fi
        [[ -f "$validator" ]] || {
            echo "The selected release does not contain the SSO configuration validator." >&2
            exit 2
        }
        SSO_PROVIDERS_JSON="$(node "$validator" "$SSO_CONFIG_FILE" "$AUTH_MODE")"
    elif [[ "$AUTH_MODE" == "local" ]]; then
        SSO_PROVIDERS_JSON="{}"
    elif [[ "$SSO_PROVIDERS_JSON" == "{}" || -z "$SSO_PROVIDERS_JSON" ]]; then
        echo "$AUTH_MODE authentication requires --sso-config or persisted provider configuration." >&2
        exit 2
    fi
}

# Canonical hostname followed by any aliases. Bash 3.2 has no namerefs, so a
# well-known global is the portable way to hand an array back to the caller.
DOMAIN_HOSTS=()

collect_domain_hosts() {
    DOMAIN_HOSTS=()
    [[ -z "$APP_DOMAIN" ]] && return 0
    DOMAIN_HOSTS=("$APP_DOMAIN")
    [[ -z "$APP_DOMAIN_ALIASES" ]] && return 0
    local host
    # Newline-splitting via read avoids the glob expansion that unquoted
    # comma-splitting on IFS would perform.
    while IFS= read -r host; do
        [[ -n "$host" && "$host" != "$APP_DOMAIN" ]] && DOMAIN_HOSTS+=("$host")
    done <<<"${APP_DOMAIN_ALIASES//,/$'\n'}"
    return 0
}

# Renders the alias list as an HCL list literal for the tfvars file.
domain_aliases_hcl() {
    local rendered="" count index=1
    collect_domain_hosts
    count=${#DOMAIN_HOSTS[@]}
    # Index 0 is the canonical hostname, which Terraform takes separately.
    # Index-based iteration keeps values out of word splitting and globbing.
    while [[ "$index" -lt "$count" ]]; do
        rendered="${rendered:+$rendered, }\"${DOMAIN_HOSTS[$index]}\""
        index=$((index + 1))
    done
    printf '[%s]' "$rendered"
}

domain_configured() {
    [[ -n "$APP_DOMAIN" ]]
}

# A cleared canonical hostname leaves nothing for aliases, certificate or zone
# to attach to, and Terraform rejects that combination. --no-domain clears all
# four, but an operator may have cleared only AIDLC_APP_DOMAIN.
normalize_domain_config() {
    if ! domain_configured; then
        APP_DOMAIN_ALIASES=""
        ACM_CERTIFICATE_ARN=""
        ROUTE53_ZONE_ID=""
    fi
}

# Reports whether an ACM certificate domain entry covers a hostname, honouring
# single-label wildcards: *.example.com matches a.example.com but not a.b.example.com.
certificate_domain_covers() {
    local pattern="$1" host="$2" suffix
    [[ "$pattern" == "$host" ]] && return 0
    if [[ "$pattern" == '*.'* ]]; then
        suffix="${pattern#\*.}"
        [[ "$host" == *".$suffix" && "${host%.$suffix}" != *.* ]] && return 0
    fi
    return 1
}

# Fails fast on custom domain mistakes that AWS would otherwise surface minutes
# into a CloudFront apply, or not at all (a certificate stuck in
# PENDING_VALIDATION never blocks the plan, it just never becomes usable).
validate_domain_config() {
    local checkout="${1:-}" host
    normalize_domain_config
    domain_configured || return 0
    collect_domain_hosts

    if [[ "${VERSION%%.*}" -lt 2 ]]; then
        echo "Custom domains require AI-DLC v2 or newer; the selected release is v$VERSION." >&2
        exit 2
    fi

    for host in "${DOMAIN_HOSTS[@]}"; do
        if ! printf '%s' "$host" | grep -qE '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'; then
            echo "Invalid hostname '$host'. Use a bare lowercase hostname without scheme, port or path (e.g. aidlc.example.com)." >&2
            exit 2
        fi
    done

    if [[ -z "$ACM_CERTIFICATE_ARN" && -z "$ROUTE53_ZONE_ID" ]]; then
        cat >&2 <<EOF
Custom domain '$APP_DOMAIN' needs a certificate. Choose one of:

  --certificate-arn ARN    Use an existing us-east-1 ACM certificate covering
                           the hostname. DNS can be managed anywhere; the
                           records to create are printed after the deployment.

  --hosted-zone-id ID      Let Terraform request and DNS-validate the
                           certificate and create the records. Requires the
                           Route53 hosted zone to be in this account.

Both may be combined to use an existing certificate with Route53-managed DNS.
EOF
        exit 2
    fi

    [[ "${AIDLC_TEST_MODE:-0}" == 1 ]] && return 0

    [[ -n "$ACM_CERTIFICATE_ARN" ]] && validate_certificate
    [[ -n "$ROUTE53_ZONE_ID" ]] && validate_hosted_zone
    validate_alias_availability "$checkout"
    return 0
}

validate_certificate() {
    local describe status covered="" host pattern match
    if [[ "$ACM_CERTIFICATE_ARN" != arn:aws*:acm:us-east-1:* ]]; then
        echo "Certificate '$ACM_CERTIFICATE_ARN' is not in us-east-1. CloudFront accepts viewer certificates from that region only." >&2
        exit 2
    fi

    # Pinned to us-east-1: the certificate cannot live anywhere else.
    if ! describe="$(aws acm describe-certificate --certificate-arn "$ACM_CERTIFICATE_ARN" \
        --region us-east-1 --output json 2>/dev/null)"; then
        echo "Cannot read certificate '$ACM_CERTIFICATE_ARN' in us-east-1." >&2
        echo "Check the ARN, the AWS profile (${PROFILE:-default credential chain}) and that acm:DescribeCertificate is permitted." >&2
        exit 2
    fi

    status="$(printf '%s' "$describe" | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        process.stdout.write(JSON.parse(s).Certificate?.Status ?? "");
      });
    ')"
    if [[ "$status" != "ISSUED" ]]; then
        echo "Certificate '$ACM_CERTIFICATE_ARN' is $status, not ISSUED." >&2
        if [[ "$status" == "PENDING_VALIDATION" ]]; then
            echo "Complete its DNS validation first; CloudFront rejects certificates that are not yet issued." >&2
            printf '%s' "$describe" | node -e '
              let s = "";
              process.stdin.on("data", (d) => (s += d)).on("end", () => {
                for (const o of JSON.parse(s).Certificate?.DomainValidationOptions ?? []) {
                  const r = o.ResourceRecord;
                  if (r) console.error(`  ${o.DomainName}: ${r.Type} ${r.Name} -> ${r.Value}`);
                }
              });
            ' || true
        fi
        exit 2
    fi

    covered="$(printf '%s' "$describe" | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const c = JSON.parse(s).Certificate ?? {};
        const names = [c.DomainName, ...(c.SubjectAlternativeNames ?? [])].filter(Boolean);
        process.stdout.write([...new Set(names)].join(" "));
      });
    ')"

    for host in "${DOMAIN_HOSTS[@]}"; do
        match=0
        for pattern in $covered; do
            if certificate_domain_covers "$pattern" "$host"; then
                match=1
                break
            fi
        done
        if [[ "$match" == 0 ]]; then
            echo "Certificate '$ACM_CERTIFICATE_ARN' does not cover '$host'." >&2
            echo "It covers: $covered" >&2
            echo "Reissue the certificate including the missing name, or drop the hostname." >&2
            exit 2
        fi
    done
}

validate_hosted_zone() {
    local zone_name host
    if ! zone_name="$(aws route53 get-hosted-zone --id "$ROUTE53_ZONE_ID" \
        --query 'HostedZone.Name' --output text 2>/dev/null)"; then
        echo "Cannot read Route53 hosted zone '$ROUTE53_ZONE_ID'." >&2
        echo "Check the zone ID and that it lives in this account (${PROFILE:-default credential chain})." >&2
        echo "To manage DNS elsewhere, drop --hosted-zone-id and pass --certificate-arn instead." >&2
        exit 2
    fi
    zone_name="${zone_name%.}"

    for host in "${DOMAIN_HOSTS[@]}"; do
        if [[ "$host" != "$zone_name" && "$host" != *".$zone_name" ]]; then
            echo "Hostname '$host' is not inside hosted zone '$zone_name'." >&2
            echo "Use a zone that covers every hostname, or manage DNS externally with --certificate-arn only." >&2
            exit 2
        fi
    done
}

# CloudFront aliases are globally unique. Without this check a collision only
# surfaces as CNAMEAlreadyExists partway through a multi-minute distribution
# update, and the apply has to be rerun.
validate_alias_availability() {
    local checkout="${1:-}" distributions distribution_id current_id="" host
    if ! distributions="$(aws cloudfront list-distributions --output json 2>/dev/null)"; then
        echo "Warning: could not list CloudFront distributions to check hostname availability; continuing." >&2
        return 0
    fi
    if [[ -n "$checkout" && -d "$checkout/terraform" ]]; then
        current_id="$(terraform -chdir="$checkout/terraform" output -raw cloudfront_distribution_id 2>/dev/null || true)"
    fi

    for host in "${DOMAIN_HOSTS[@]}"; do
        distribution_id="$(printf '%s' "$distributions" | node -e '
          const host = process.argv[1];
          let s = "";
          process.stdin.on("data", (d) => (s += d)).on("end", () => {
            const items = JSON.parse(s).DistributionList?.Items ?? [];
            const hit = items.find((d) => (d.Aliases?.Items ?? []).includes(host));
            process.stdout.write(hit ? hit.Id : "");
          });
        ' "$host")"
        if [[ -n "$distribution_id" && "$distribution_id" != "$current_id" ]]; then
            echo "Hostname '$host' is already an alias of CloudFront distribution $distribution_id." >&2
            echo "CloudFront aliases are globally unique. Remove it there first, or choose another hostname." >&2
            exit 2
        fi
    done
}

require_terraform_version() {
    local version
    if ! version="$(terraform version -json 2>/dev/null | node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        try {
          const version = JSON.parse(input).terraform_version;
          if (typeof version !== "string") process.exit(1);
          process.stdout.write(version);
        } catch {
          process.exit(1);
        }
      });
    ')"; then
        echo "Could not determine the Terraform version; Terraform 1.4 or later is required." >&2
        return 1
    fi
    if ! is_semver "$version"; then
        echo "Could not parse Terraform version '$version'; Terraform 1.4 or later is required." >&2
        return 1
    fi
    if [[ "$(version_cmp "$version" "1.4.0")" -lt 0 ]]; then
        echo "Terraform 1.4 or later is required; found $version." >&2
        return 1
    fi
}

require_commands() {
    local missing=0 command
    local commands="git node npm terraform aws $CONTAINER_RUNTIME"
    [[ "${AIDLC_TEST_MODE:-0}" == 1 ]] && commands="git node"
    for command in $commands; do
        if ! command -v "$command" >/dev/null 2>&1; then
            echo "Missing required command: $command" >&2
            missing=1
        fi
    done
    [[ "$missing" == 0 ]] || return 1
    [[ "${AIDLC_TEST_MODE:-0}" == 1 ]] || require_terraform_version
}

require_destroy_commands() {
    [[ "${AIDLC_TEST_MODE:-0}" == 1 ]] && return
    if ! command -v terraform >/dev/null 2>&1; then
        echo "Missing required command: terraform" >&2
        return 1
    fi
}

confirm() {
    local prompt="$1" answer
    [[ "$ASSUME_YES" == 1 ]] && return 0
    read -r -p "$prompt [y/N] " answer
    [[ "$answer" == "y" || "$answer" == "Y" ]]
}

confirm_destroy() {
    local answer
    [[ "$ASSUME_YES" == 1 ]] && return 0
    if [[ ! -t 0 ]]; then
        echo "Destruction requires an interactive terminal or --yes." >&2
        return 1
    fi
    echo "WARNING: This permanently destroys all AI-DLC resources and application data"
    echo "for environment '$ENVIRONMENT'. Local configuration and the state bucket are retained."
    read -r -p "Type the environment name '$ENVIRONMENT' to continue: " answer
    [[ "$answer" == "$ENVIRONMENT" ]]
}

prompt_admin() {
    if [[ -z "$ADMIN_USERNAME" ]]; then
        if [[ ! -t 0 ]]; then
            echo "Administrator email required; pass --admin or AIDLC_ADMIN_USERNAME." >&2
            exit 1
        fi
        read -r -p "Administrator email: " ADMIN_USERNAME
    fi
}

prompt_password() {
    if [[ -n "${AIDLC_ADMIN_PASSWORD:-}" ]]; then
        ADMIN_PASSWORD="$AIDLC_ADMIN_PASSWORD"
        return
    fi
    if [[ ! -t 0 ]]; then
        echo "Administrator password required; set AIDLC_ADMIN_PASSWORD for automation." >&2
        exit 1
    fi
    local verify
    read -r -s -p "Permanent Cognito password: " ADMIN_PASSWORD
    printf '\n'
    read -r -s -p "Confirm permanent Cognito password: " verify
    printf '\n'
    if [[ "$ADMIN_PASSWORD" != "$verify" ]]; then
        echo "Passwords do not match." >&2
        exit 1
    fi
}

select_version() {
    if [[ -z "$VERSION" ]]; then
        VERSION="$(latest_version)"
    fi
    if [[ -z "$VERSION" ]] || ! is_semver "$VERSION"; then
        echo "No valid release version selected." >&2
        exit 1
    fi
}

clone_checkout() (
    # The installer keeps a restrictive umask for credentials and generated
    # configuration. Source checkouts are build inputs, though: Docker COPY
    # preserves their modes, and runtime images execute as an unprivileged user.
    # Clone with normal source permissions so regular files are readable.
    umask 022
    git clone "$@"
)

checkout_release() {
    local version="$1" destination="$RELEASES_DIR/v$1" temporary
    mkdir -p "$RELEASES_DIR"
    if [[ ! -d "$destination/.git" ]]; then
        temporary="$destination.tmp.$$"
        rm -rf "$temporary"
        clone_checkout --quiet --depth 1 --branch "v$version" "$REPOSITORY_URL" "$temporary"
        mv "$temporary" "$destination"
    fi
    local local_commit local_tag_commit remote_commit
    local_commit="$(git -C "$destination" rev-parse HEAD)"
    local_tag_commit="$(git -C "$destination" rev-parse "v$version^{}" 2>/dev/null || true)"
    if [[ -z "$local_tag_commit" || "$local_commit" != "$local_tag_commit" ]]; then
        echo "Release checkout is not exactly tag v$version: $destination" >&2
        exit 1
    fi
    remote_commit="$(
        git ls-remote "$REPOSITORY_URL" "refs/tags/v$version^{}" "refs/tags/v$version" |
            awk '/\^\{\}$/ { print $1; found=1; exit } !found { direct=$1 } END { if (!found) print direct }'
    )"
    if [[ -z "$remote_commit" || "$local_commit" != "$remote_commit" ]]; then
        echo "Release checkout does not match remote tag v$version." >&2
        exit 1
    fi
    local manifest_version
    manifest_version="$(node -p "require(process.argv[1]).version || ''" "$destination/package.json")"
    if [[ "$manifest_version" != "$version" && ! ( "$version" == "1.1.0" && -z "$manifest_version" ) ]]; then
        echo "Tag v$version contains package version $manifest_version; refusing install." >&2
        exit 1
    fi
    printf '%s\n' "$destination"
}

checkout_ref() {
    local ref="$1" commit destination temporary local_commit manifest_version
    if ! git check-ref-format --branch "$ref" >/dev/null 2>&1; then
        echo "Invalid branch name: $ref" >&2
        exit 1
    fi
    commit="$(git ls-remote --heads "$REPOSITORY_URL" "refs/heads/$ref" | awk 'NR == 1 { print $1 }')"
    if [[ -z "$commit" ]]; then
        echo "Remote branch not found: $ref" >&2
        exit 1
    fi

    destination="$CHECKOUTS_DIR/$commit"
    mkdir -p "$CHECKOUTS_DIR"
    if [[ ! -d "$destination/.git" ]]; then
        temporary="$destination.tmp.$$"
        rm -rf "$temporary"
        clone_checkout --quiet --depth 1 --branch "$ref" "$REPOSITORY_URL" "$temporary"
        local_commit="$(git -C "$temporary" rev-parse HEAD)"
        if [[ "$local_commit" != "$commit" ]]; then
            echo "Branch $ref changed while cloning; rerun the installer." >&2
            rm -rf "$temporary"
            exit 1
        fi
        git -C "$temporary" checkout --quiet --detach "$commit"
        mv "$temporary" "$destination"
    fi
    local_commit="$(git -C "$destination" rev-parse HEAD)"
    if [[ "$local_commit" != "$commit" ]]; then
        echo "Branch checkout does not match $ref at $commit." >&2
        exit 1
    fi

    manifest_version="$(node -p "require(process.argv[1]).version || ''" "$destination/package.json")"
    if ! is_semver "$manifest_version"; then
        echo "Branch $ref has no valid root package version." >&2
        exit 1
    fi
    VERSION="$manifest_version"
    RESOLVED_COMMIT="$commit"
    TARGET_CHECKOUT="$destination"
}

select_checkout() {
    if [[ -n "$REF" ]]; then
        checkout_ref "$REF"
        return
    fi
    select_version
    TARGET_CHECKOUT="$(checkout_release "$VERSION")"
    RESOLVED_COMMIT="$(git -C "$TARGET_CHECKOUT" rev-parse HEAD)"
}

target_description() {
    if [[ -n "$REF" ]]; then
        printf 'AI-DLC v%s from %s@%s' "$VERSION" "$REF" "${RESOLVED_COMMIT:0:12}"
    else
        printf 'AI-DLC v%s' "$VERSION"
    fi
}

# Renders a string in the JSON-compatible quoted syntax accepted by HCL.
hcl_string() {
    node -e 'process.stdout.write(JSON.stringify(process.argv[1]));' "$1"
}

# Sets a single HCL assignment in a tfvars file: rewrites the value in place if
# the key is present, appends the assignment otherwise. sed alone cannot insert,
# and the file is no longer written only once, so both paths are needed for
# installations whose tfvars predate a variable.
tfvars_upsert() {
    local file="$1" key="$2" value="$3" warn_on_change="${4:-0}" escaped_value existing
    if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
        echo "Refusing to write a multiline value for '$key' to $file." >&2
        return 1
    fi
    if grep -qE "^[[:space:]]*${key}[[:space:]]*=" "$file"; then
        existing="$(grep -m 1 -E "^[[:space:]]*${key}[[:space:]]*=" "$file")"
        if [[ "$warn_on_change" == 1 && "$existing" != "$key = $value" ]]; then
            echo "Warning: managed installer is updating '$key' in $file to match installer configuration." >&2
        fi
        # Backslash, ampersand and the delimiter are special in a sed replacement.
        escaped_value="$(printf '%s' "$value" | sed 's/[\\&|]/\\&/g')"
        sed -i.bak -E "s|^[[:space:]]*${key}[[:space:]]*=.*|${key} = ${escaped_value}|" "$file"
        rm -f "$file.bak"
    else
        printf '%s = %s\n' "$key" "$value" >> "$file"
    fi
}

configure_environment() {
    local checkout="$1" tfvars sso_tfvars backend tfvars_existed=1
    mkdir -p "$CONFIG_ROOT/terraform/environments" "$DATA_ROOT/backups" "$DATA_ROOT/plans"
    tfvars="$CONFIG_ROOT/terraform/environments/$ENVIRONMENT.tfvars"
    sso_tfvars="$CONFIG_ROOT/terraform/environments/$ENVIRONMENT.sso.tfvars.json"
    backend="$CONFIG_ROOT/terraform/environments/$ENVIRONMENT.s3.tfbackend"
    if [[ ! -f "$tfvars" ]]; then
        cp "$checkout/terraform/environments/dev.tfvars.example" "$tfvars"
        tfvars_existed=0
    fi
    tfvars_upsert "$tfvars" environment "$(hcl_string "$ENVIRONMENT")" "$tfvars_existed"
    tfvars_upsert "$tfvars" aws_region "$(hcl_string "$REGION")" "$tfvars_existed"
    node -e '
      const [mode, providers] = process.argv.slice(1);
      process.stdout.write(JSON.stringify({
        auth_mode: mode,
        sso_providers: JSON.parse(providers),
      }, null, 2) + "\n");
    ' "$AUTH_MODE" "$SSO_PROVIDERS_JSON" > "$sso_tfvars"
    chmod 600 "$sso_tfvars"

    normalize_domain_config
    # Written whenever a domain is configured, and whenever the keys are already
    # present so an update can change or clear them. Skipped otherwise, which
    # keeps the tfvars of releases predating these variables clean.
    if domain_configured || grep -qE '^[[:space:]]*app_domain[[:space:]]*=' "$tfvars"; then
        tfvars_upsert "$tfvars" app_domain "$(hcl_string "$APP_DOMAIN")" "$tfvars_existed"
        tfvars_upsert "$tfvars" app_domain_aliases "$(domain_aliases_hcl)" "$tfvars_existed"
        tfvars_upsert "$tfvars" acm_certificate_arn "$(hcl_string "$ACM_CERTIFICATE_ARN")" "$tfvars_existed"
        tfvars_upsert "$tfvars" route53_zone_id "$(hcl_string "$ROUTE53_ZONE_ID")" "$tfvars_existed"
    fi

    if [[ ! -f "$backend" ]]; then
        AIDLC_CONFIG_DIR="$CONFIG_ROOT/terraform" AWS_REGION="$REGION" \
            "$checkout/scripts/bootstrap.sh" "$ENVIRONMENT"
    fi
}

aws_environment() {
    export AWS_REGION="$REGION"
    if [[ -n "$PROFILE" ]]; then export AWS_PROFILE="$PROFILE"; else unset AWS_PROFILE || true; fi
}

terraform_init() {
    local checkout="$1"
    terraform -chdir="$checkout/terraform" init -reconfigure \
        -backend-config="$CONFIG_ROOT/terraform/environments/$ENVIRONMENT.s3.tfbackend"
}

backup_state() {
    local checkout="$1" backup
    backup="$DATA_ROOT/backups/terraform-$(date -u +%Y%m%dT%H%M%SZ).tfstate"
    terraform_init "$checkout" >/dev/null
    terraform -chdir="$checkout/terraform" state pull > "$backup"
    chmod 600 "$backup"
    echo "Terraform state backup: $backup"
}

deploy_v1() {
    local checkout="$1" plan="$2" tfvars backend plan_json
    tfvars="$CONFIG_ROOT/terraform/environments/$ENVIRONMENT.tfvars"
    backend="$CONFIG_ROOT/terraform/environments/$ENVIRONMENT.s3.tfbackend"
    (cd "$checkout" && npm ci)
    terraform -chdir="$checkout/terraform" init -reconfigure -backend-config="$backend"
    terraform -chdir="$checkout/terraform" plan -var-file="$tfvars" -out="$plan"
    plan_json="$plan.json"
    terraform -chdir="$checkout/terraform" show -json "$plan" > "$plan_json"
    node -e '
      const fs = require("node:fs");
      const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const protectedTypes = new Set([
        "aws_cognito_user_pool", "aws_neptune_cluster", "aws_neptune_cluster_instance",
        "aws_s3_bucket", "aws_dynamodb_table"
      ]);
      const rejected = (plan.resource_changes || []).filter((item) =>
        item.change?.actions?.includes("delete") &&
        protectedTypes.has(item.type) &&
        !(item.type === "aws_dynamodb_table" && /agent[_-]?pool/i.test(item.address))
      );
      if (rejected.length) {
        console.error("Refusing Terraform plan: protected persistent resources would be destroyed:");
        for (const item of rejected) console.error(`  - ${item.address}`);
        process.exit(1);
      }
    ' "$plan_json"
    rm -f "$plan_json"
    terraform -chdir="$checkout/terraform" apply "$plan"
    rm -f "$plan"
}

deploy_v2() {
    local checkout="$1" plan="$2"
    AIDLC_CONFIG_DIR="$CONFIG_ROOT/terraform" AIDLC_MANAGED_INSTALL=1 \
        "$checkout/scripts/deploy-terraform.sh" "$ENVIRONMENT" --phase plan --plan-file "$plan"
    AIDLC_CONFIG_DIR="$CONFIG_ROOT/terraform" AIDLC_MANAGED_INSTALL=1 \
        "$checkout/scripts/deploy-terraform.sh" "$ENVIRONMENT" --phase apply --plan-file "$plan"
}

deploy_frontend() {
    local checkout="$1"
    if [[ "${VERSION%%.*}" -ge 2 ]]; then
        AIDLC_CONFIG_DIR="$CONFIG_ROOT/terraform" "$checkout/scripts/deploy-frontend.sh" "$ENVIRONMENT"
        return
    fi
    local tf="$checkout/terraform" frontend="$checkout/frontend" pool client domain bucket distribution
    # Frozen v1 path. v1 has no custom domain support, so this deliberately
    # keeps building the endpoints from the CloudFront domain and omits
    # VITE_APP_ORIGIN. v2 goes through scripts/deploy-frontend.sh above.
    pool="$(terraform -chdir="$tf" output -raw user_pool_id)"
    client="$(terraform -chdir="$tf" output -raw user_pool_client_id)"
    domain="$(terraform -chdir="$tf" output -raw cloudfront_domain_name)"
    bucket="$(terraform -chdir="$tf" output -raw s3_bucket_name)"
    distribution="$(terraform -chdir="$tf" output -raw cloudfront_distribution_id 2>/dev/null || true)"
    cat > "$frontend/.env" <<EOF
VITE_AWS_REGION=$REGION
VITE_AWS_USER_POOL_ID=$pool
VITE_AWS_USER_POOL_CLIENT_ID=$client
VITE_API_BASE_URL="https://$domain/api"
VITE_WEBSOCKET_URL=wss://$domain/ws
VITE_YJS_SERVER_URL=wss://$domain/yjs
VITE_ENVIRONMENT=$ENVIRONMENT
EOF
    (cd "$frontend" && npm ci && npm run build)
    aws s3 sync "$frontend/dist/" "s3://$bucket" --delete
    if [[ -n "$distribution" ]]; then
        aws cloudfront create-invalidation --distribution-id "$distribution" --paths '/*' >/dev/null
    fi
}

configure_administrator() {
    local checkout="$1" role="$2" create_user="$3" pool pool_region caller_account profile_label
    pool="$(terraform -chdir="$checkout/terraform" output -raw user_pool_id)"
    pool_region="$(terraform -chdir="$checkout/terraform" output -raw aws_region)"
    if ! aws cognito-idp describe-user-pool \
        --user-pool-id "$pool" --region "$pool_region" >/dev/null 2>&1; then
        caller_account="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || printf 'unknown')"
        profile_label="${PROFILE:-default credential chain}"
        echo "Cognito user pool '$pool' from Terraform state is not accessible." >&2
        echo "  Terraform region: $pool_region" >&2
        echo "  AWS profile:      $profile_label" >&2
        echo "  Caller account:   $caller_account" >&2
        echo "Verify that the installer profile points to the AWS account containing this deployment." >&2
        return 1
    fi
    if [[ "$create_user" == 1 ]]; then
        if ! aws cognito-idp admin-get-user \
            --user-pool-id "$pool" --username "$ADMIN_USERNAME" \
            --region "$pool_region" >/dev/null 2>&1; then
            aws cognito-idp admin-create-user \
                --user-pool-id "$pool" --username "$ADMIN_USERNAME" \
                --temporary-password "$ADMIN_PASSWORD" --message-action SUPPRESS \
                --user-attributes "Name=email,Value=$ADMIN_USERNAME" "Name=email_verified,Value=true" \
                --region "$pool_region" >/dev/null
        fi
        aws cognito-idp admin-set-user-password \
            --user-pool-id "$pool" --username "$ADMIN_USERNAME" \
            --password "$ADMIN_PASSWORD" --permanent --region "$pool_region" >/dev/null
    fi
    aws cognito-idp admin-add-user-to-group \
        --user-pool-id "$pool" --username "$ADMIN_USERNAME" --group-name "$role" \
        --region "$pool_region"
}

switch_current() {
    local checkout="$1"
    ln -sfn "$checkout" "$CURRENT_LINK"
}

current_checkout() {
    [[ -L "$CURRENT_LINK" ]] && readlink "$CURRENT_LINK"
}

current_version() {
    local checkout
    checkout="$(current_checkout)"
    [[ -n "$checkout" && -f "$checkout/package.json" ]] || return 1
    local version
    version="$(node -p "require(process.argv[1]).version || ''" "$checkout/package.json")"
    if [[ -n "$version" ]]; then
        printf '%s\n' "$version"
    else
        basename "$checkout" | sed 's/^v//'
    fi
}

application_url() {
    local checkout="$1" url domain
    url="$(terraform -chdir="$checkout/terraform" output -raw application_url 2>/dev/null || true)"
    if [[ -z "$url" ]]; then
        domain="$(terraform -chdir="$checkout/terraform" output -raw cloudfront_domain_name 2>/dev/null || true)"
        [[ -n "$domain" ]] && url="https://$domain"
    fi
    printf '%s\n' "$url"
}

print_managed_summary() {
    local operation="$1" checkout="$2" url="" oidc_callback="" saml_acs="" saml_entity_id=""
    if [[ "${AIDLC_TEST_MODE:-0}" != 1 ]]; then
        url="$(application_url "$checkout")"
        if [[ "${VERSION%%.*}" -ge 2 ]]; then
            oidc_callback="$(terraform -chdir="$checkout/terraform" output -raw oidc_idp_callback_url 2>/dev/null || true)"
            saml_acs="$(terraform -chdir="$checkout/terraform" output -raw saml_acs_url 2>/dev/null || true)"
            saml_entity_id="$(terraform -chdir="$checkout/terraform" output -raw saml_entity_id 2>/dev/null || true)"
        fi
    fi

    echo ""
    echo "$operation complete"
    printf '  Release:         %s\n' "$(target_description)"
    printf '  Environment:     %s\n' "$ENVIRONMENT"
    printf '  Region:          %s\n' "$REGION"
    if [[ -n "$url" ]]; then
        printf '  Application URL: %s\n' "$url"
    else
        echo "  Application URL: unavailable; run the status command after Terraform is initialized."
    fi
    if domain_configured; then
        printf '  Custom domain:   %s\n' "$APP_DOMAIN"
        [[ -n "$APP_DOMAIN_ALIASES" ]] && printf '  Also serving:    %s\n' "${APP_DOMAIN_ALIASES//,/, }"
        print_dns_instructions "$checkout"
    fi
    printf '  Authentication:  %s\n' "$AUTH_MODE"
    if [[ "$AUTH_MODE" != "local" ]]; then
        printf '  SSO providers:   %s\n' "$(printf '%s' "$SSO_PROVIDERS_JSON" | node -e '
          let s = "";
          process.stdin.on("data", (d) => (s += d)).on("end", () => {
            process.stdout.write(Object.values(JSON.parse(s)).map((p) => p.display_name).join(", "));
          });
        ')"
    fi
    [[ -n "$oidc_callback" ]] && printf '  OIDC callback:   %s\n' "$oidc_callback"
    [[ -n "$saml_acs" ]] && printf '  SAML ACS:        %s\n' "$saml_acs"
    [[ -n "$saml_entity_id" ]] && printf '  SAML entity ID:  %s\n' "$saml_entity_id"
    printf '  Status:          bash %q status\n' "$SCRIPT_DIR/install.sh"
}

# With an external DNS provider nothing points at the distribution until the
# operator creates the records, so the deployment is not reachable on the custom
# domain until this is done.
print_dns_instructions() {
    local checkout="$1" target host
    [[ -n "$ROUTE53_ZONE_ID" ]] && return 0
    [[ "${AIDLC_TEST_MODE:-0}" == 1 ]] && return 0
    target="$(terraform -chdir="$checkout/terraform" output -raw dns_target 2>/dev/null || true)"
    [[ -z "$target" ]] && return 0

    echo ""
    echo "  DNS is managed outside this deployment. Create these records:"
    collect_domain_hosts
    for host in "${DOMAIN_HOSTS[@]}"; do
        printf '    %s  A     -> %s\n' "$host" "$target"
        printf '    %s  AAAA  -> %s\n' "$host" "$target"
    done
    echo "    Use an alias/ANAME record where your provider supports it, otherwise a"
    echo "    CNAME. Apex domains require alias records; a CNAME is not valid there."
}

install_command() {
    require_commands
    [[ ! -L "$CURRENT_LINK" ]] || {
        echo "A managed installation already exists. Use update instead." >&2
        exit 1
    }
    aws_environment
    local checkout plan role plan_id
    select_checkout
    checkout="$TARGET_CHECKOUT"
    if [[ -n "$REF" ]]; then
        echo "Warning: --ref tracks mutable branch '$REF'; this is a non-release test deployment."
    fi
    validate_domain_config
    validate_sso_config "$checkout"
    [[ "$AUTH_MODE" == "sso-only" ]] || prompt_admin
    confirm "Install $(target_description) into AWS environment $ENVIRONMENT?" || exit 1
    [[ "$AUTH_MODE" == "sso-only" ]] || prompt_password
    configure_environment "$checkout"
    plan_id="v$VERSION"
    [[ -n "$REF" ]] && plan_id="${REF//\//-}-${RESOLVED_COMMIT:0:12}"
    plan="$DATA_ROOT/plans/$plan_id.tfplan"
    if [[ "${AIDLC_TEST_MODE:-0}" != 1 ]]; then
        if [[ "${VERSION%%.*}" -ge 2 ]]; then deploy_v2 "$checkout" "$plan"; else deploy_v1 "$checkout" "$plan"; fi
        role="owner"
        [[ "${VERSION%%.*}" -ge 2 ]] && role="platform-admin"
        [[ "$AUTH_MODE" == "sso-only" ]] || configure_administrator "$checkout" "$role" 1
        deploy_frontend "$checkout"
    fi
    write_config
    switch_current "$checkout"
    unset ADMIN_PASSWORD AIDLC_ADMIN_PASSWORD || true
    print_managed_summary "Installation" "$checkout"
}

adopt_command() {
    require_commands
    [[ ! -L "$CURRENT_LINK" ]] || {
        echo "A managed installation already exists. Use update instead." >&2
        exit 1
    }
    [[ -n "$SOURCE" ]] || { echo "adopt requires --source <existing-v1-checkout>" >&2; exit 2; }
    SOURCE="$(cd "$SOURCE" && pwd)"
    [[ -d "$SOURCE/terraform" ]] || { echo "Invalid v1 checkout: $SOURCE" >&2; exit 1; }
    REF=""
    VERSION="${VERSION:-1.1.0}"
    [[ "$VERSION" == 1.* ]] || { echo "adopt only supports a v1 release" >&2; exit 1; }
    prompt_admin
    aws_environment
    local checkout source_tfvars source_backend
    checkout="$(checkout_release "$VERSION")"
    confirm "Adopt the v1 deployment from $SOURCE?" || exit 1
    mkdir -p "$CONFIG_ROOT/terraform/environments"
    source_tfvars="$SOURCE/terraform/environments/$ENVIRONMENT.tfvars"
    source_backend="$SOURCE/terraform/environments/$ENVIRONMENT.s3.tfbackend"
    [[ -f "$source_tfvars" && -f "$source_backend" ]] || {
        echo "Missing v1 tfvars or backend file for environment $ENVIRONMENT." >&2
        exit 1
    }
    cp "$source_tfvars" "$CONFIG_ROOT/terraform/environments/$ENVIRONMENT.tfvars"
    cp "$source_backend" "$CONFIG_ROOT/terraform/environments/$ENVIRONMENT.s3.tfbackend"
    if [[ "${AIDLC_TEST_MODE:-0}" != 1 ]]; then
        terraform_init "$checkout" >/dev/null
        terraform -chdir="$checkout/terraform" output -raw user_pool_id >/dev/null
        configure_administrator "$checkout" owner 0
    fi
    write_config
    switch_current "$checkout"
    echo "Adopted v1 deployment as managed AI-DLC v$VERSION."
}

update_command() {
    require_commands
    load_config
    aws_environment
    local old_checkout old_version old_commit checkout plan cmp plan_id create_local_admin=0
    old_checkout="$(current_checkout)"
    [[ -n "$old_checkout" ]] || { echo "No managed installation. Run install or adopt first." >&2; exit 1; }
    old_version="$(current_version)"
    old_commit="$(git -C "$old_checkout" rev-parse HEAD)"
    select_checkout
    checkout="$TARGET_CHECKOUT"
    cmp="$(version_cmp "$VERSION" "$old_version")"
    if [[ "$cmp" -lt 0 && "$ALLOW_DOWNGRADE" != 1 ]]; then
        echo "Refusing downgrade from $old_version to $VERSION; pass --allow-downgrade to override." >&2
        exit 1
    fi
    if [[ -n "$REF" ]]; then
        [[ "$RESOLVED_COMMIT" != "$old_commit" ]] || {
            echo "Already on $(target_description)."
            exit 0
        }
    else
        if [[ "$VERSION" == "$old_version" &&
              -z "$AUTH_MODE_EXPLICIT$SSO_CONFIG_EXPLICIT$APP_DOMAIN_EXPLICIT$APP_DOMAIN_ALIASES_EXPLICIT$ACM_CERTIFICATE_ARN_EXPLICIT$ROUTE53_ZONE_ID_EXPLICIT" ]]; then
            echo "Already on AI-DLC v$VERSION."
            exit 0
        fi
    fi
    validate_sso_config "$checkout"
    if [[ "$AUTH_MODE" != "sso-only" ]]; then
        prompt_admin
        if [[ "$PERSISTED_AUTH_MODE" == "sso-only" ]]; then
            prompt_password
            create_local_admin=1
        fi
    fi
    if [[ -n "$REF" ]]; then
        echo "Warning: update is following mutable branch '$REF'."
    fi
    validate_domain_config "$old_checkout"
    confirm "Update AI-DLC from v$old_version to $(target_description)?" || exit 1
    configure_environment "$checkout"
    plan_id="v$old_version-to-v$VERSION"
    [[ -n "$REF" ]] && plan_id="${REF//\//-}-${RESOLVED_COMMIT:0:12}"
    plan="$DATA_ROOT/plans/$plan_id.tfplan"
    if [[ "${AIDLC_TEST_MODE:-0}" != 1 ]]; then
        backup_state "$checkout"
        if [[ "${VERSION%%.*}" -ge 2 ]]; then deploy_v2 "$checkout" "$plan"; else deploy_v1 "$checkout" "$plan"; fi
        local role="owner"
        [[ "${VERSION%%.*}" -ge 2 ]] && role="platform-admin"
        [[ "$AUTH_MODE" == "sso-only" ]] || configure_administrator "$checkout" "$role" "$create_local_admin"
        deploy_frontend "$checkout"
    fi
    write_config
    switch_current "$checkout"
    print_managed_summary "Update from AI-DLC v$old_version" "$checkout"
}

destroy_command() {
    require_destroy_commands
    load_config
    aws_environment

    local checkout version destroy_script
    checkout="$(current_checkout)"
    [[ -n "$checkout" ]] || {
        echo "No managed installation to destroy." >&2
        exit 1
    }
    version="$(current_version)"
    destroy_script="$checkout/scripts/destroy.sh"
    [[ -f "$destroy_script" ]] || {
        echo "Release checkout does not provide a destroy script: $destroy_script" >&2
        exit 1
    }

    if ! confirm_destroy; then
        echo "Destruction aborted."
        exit 0
    fi

    if [[ "${AIDLC_TEST_MODE:-0}" != 1 ]]; then
        AIDLC_CONFIG_DIR="$CONFIG_ROOT/terraform" \
            AIDLC_BACKUP_DIR="$DATA_ROOT/backups" \
            AIDLC_YES=1 \
            bash "$destroy_script" "$ENVIRONMENT" --yes
    fi

    rm -f "$CURRENT_LINK"
    echo ""
    echo "Managed environment destroyed"
    printf '  Release:      AI-DLC v%s\n' "$version"
    printf '  Environment:  %s\n' "$ENVIRONMENT"
    printf '  Local config: %s (retained)\n' "$CONFIG_ROOT"
    printf '  Checkouts:    %s (retained)\n' "$DATA_ROOT"
}

status_command() {
    load_config
    local checkout version url="" commit oidc_callback="" saml_acs="" saml_entity_id=""
    checkout="$(current_checkout)"
    if [[ -z "$checkout" ]]; then
        echo "AI-DLC is not managed on this machine."
        exit 1
    fi
    version="$(current_version)"
    if command -v terraform >/dev/null 2>&1; then
        url="$(application_url "$checkout")"
        if [[ "${version%%.*}" -ge 2 ]]; then
            oidc_callback="$(terraform -chdir="$checkout/terraform" output -raw oidc_idp_callback_url 2>/dev/null || true)"
            saml_acs="$(terraform -chdir="$checkout/terraform" output -raw saml_acs_url 2>/dev/null || true)"
            saml_entity_id="$(terraform -chdir="$checkout/terraform" output -raw saml_entity_id 2>/dev/null || true)"
        fi
    fi
    echo "Version:     $version"
    echo "Environment: $ENVIRONMENT"
    echo "Region:      $REGION"
    echo "Checkout:    $checkout"
    echo "Config:      $CONFIG_ROOT"
    echo "Auth:        $AUTH_MODE"
    if [[ "$AUTH_MODE" != "local" ]]; then
        echo "SSO:         $(printf '%s' "$SSO_PROVIDERS_JSON" | node -e '
          let s = "";
          process.stdin.on("data", (d) => (s += d)).on("end", () => {
            try {
              process.stdout.write(Object.values(JSON.parse(s)).map((p) => p.display_name).join(", "));
            } catch {
              process.stdout.write("invalid configuration");
            }
          });
        ')"
    fi
    if [[ -n "$REF" ]]; then
        commit="$(git -C "$checkout" rev-parse --short=12 HEAD)"
        echo "Source:      $REF@$commit (non-release)"
    else
        echo "Source:      v$version"
    fi
    if domain_configured; then
        echo "Domain:      $APP_DOMAIN"
        [[ -n "$APP_DOMAIN_ALIASES" ]] && echo "Aliases:     ${APP_DOMAIN_ALIASES//,/, }"
        if [[ -n "$ROUTE53_ZONE_ID" ]]; then
            echo "DNS:         Route53 zone $ROUTE53_ZONE_ID (managed by Terraform)"
        else
            echo "DNS:         managed externally"
        fi
    else
        echo "Domain:      CloudFront default (no custom domain)"
    fi
    [[ -n "$url" ]] && echo "URL:         $url"
    [[ -n "$oidc_callback" ]] && echo "OIDC callback: $oidc_callback"
    [[ -n "$saml_acs" ]] && echo "SAML ACS:      $saml_acs"
    [[ -n "$saml_entity_id" ]] && echo "SAML entity:   $saml_entity_id"
    return 0
}

case "$COMMAND" in
    versions)
        sorted_versions
        ;;
    install) install_command ;;
    adopt) adopt_command ;;
    update) update_command ;;
    status) status_command ;;
    destroy) destroy_command ;;
    ""|-h|--help|help) usage ;;
    *) echo "Unknown command: $COMMAND" >&2; usage >&2; exit 2 ;;
esac

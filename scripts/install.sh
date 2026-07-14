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
REGION="${AWS_REGION:-${AIDLC_REGION:-us-east-1}}"
PROFILE="${AWS_PROFILE:-${AIDLC_AWS_PROFILE:-}}"
ADMIN_USERNAME="${AIDLC_ADMIN_USERNAME:-}"
REPOSITORY_URL="${AIDLC_REPOSITORY_URL:-$DEFAULT_REPOSITORY}"
ENVIRONMENT_EXPLICIT="${AIDLC_ENVIRONMENT+x}"
REGION_EXPLICIT="${AWS_REGION+x}${AIDLC_REGION+x}"
PROFILE_EXPLICIT="${AWS_PROFILE+x}${AIDLC_AWS_PROFILE+x}"
ADMIN_EXPLICIT="${AIDLC_ADMIN_USERNAME+x}"
REPOSITORY_EXPLICIT="${AIDLC_REPOSITORY_URL+x}"
VERSION_EXPLICIT="${AIDLC_VERSION+x}"
REF_EXPLICIT="${AIDLC_REF+x}"
SOURCE=""
ASSUME_YES="${AIDLC_YES:-0}"
ALLOW_DOWNGRADE="${AIDLC_ALLOW_DOWNGRADE:-0}"

usage() {
    cat <<'EOF'
Usage: install.sh <command> [options]

Commands:
  versions                     List available release versions
  install                      Install a tagged release
  adopt --source <path>        Adopt an existing v1 deployment
  update                       Update the managed deployment
  status                       Show managed installation status

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
        --yes) ASSUME_YES=1; shift ;;
        --include-prereleases|--allow-prerelease) shift ;;
        --allow-downgrade) ALLOW_DOWNGRADE=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done
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
        # The file is written by write_config using shell-escaped values.
        # shellcheck disable=SC1090
        source "$CONFIG_FILE"
        ENVIRONMENT="${AIDLC_ENVIRONMENT:-$requested_environment}"
        REGION="${AIDLC_REGION:-$requested_region}"
        PROFILE="${AIDLC_AWS_PROFILE:-$requested_profile}"
        ADMIN_USERNAME="${AIDLC_ADMIN_USERNAME:-$requested_admin}"
        REPOSITORY_URL="${AIDLC_REPOSITORY_URL:-$requested_repository}"
        REF="${AIDLC_REF:-$requested_ref}"
        [[ -n "$ENVIRONMENT_EXPLICIT" ]] && ENVIRONMENT="$requested_environment"
        [[ -n "$REGION_EXPLICIT" ]] && REGION="$requested_region"
        [[ -n "$PROFILE_EXPLICIT" ]] && PROFILE="$requested_profile"
        [[ -n "$ADMIN_EXPLICIT" ]] && ADMIN_USERNAME="$requested_admin"
        [[ -n "$REPOSITORY_EXPLICIT" ]] && REPOSITORY_URL="$requested_repository"
        [[ -n "$REF_EXPLICIT" ]] && REF="$requested_ref"
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
    } > "$CONFIG_FILE"
    chmod 600 "$CONFIG_FILE"
}

require_commands() {
    local missing=0 command
    local commands="git node npm terraform aws docker"
    [[ "${AIDLC_TEST_MODE:-0}" == 1 ]] && commands="git node"
    for command in $commands; do
        if ! command -v "$command" >/dev/null 2>&1; then
            echo "Missing required command: $command" >&2
            missing=1
        fi
    done
    [[ "$missing" == 0 ]]
}

confirm() {
    local prompt="$1" answer
    [[ "$ASSUME_YES" == 1 ]] && return 0
    read -r -p "$prompt [y/N] " answer
    [[ "$answer" == "y" || "$answer" == "Y" ]]
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

checkout_release() {
    local version="$1" destination="$RELEASES_DIR/v$1" temporary
    mkdir -p "$RELEASES_DIR"
    if [[ ! -d "$destination/.git" ]]; then
        temporary="$destination.tmp.$$"
        rm -rf "$temporary"
        git clone --quiet --depth 1 --branch "v$version" "$REPOSITORY_URL" "$temporary"
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
        git clone --quiet --depth 1 --branch "$ref" "$REPOSITORY_URL" "$temporary"
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

configure_environment() {
    local checkout="$1"
    mkdir -p "$CONFIG_ROOT/terraform/environments" "$DATA_ROOT/backups" "$DATA_ROOT/plans"
    local tfvars="$CONFIG_ROOT/terraform/environments/$ENVIRONMENT.tfvars"
    local backend="$CONFIG_ROOT/terraform/environments/$ENVIRONMENT.s3.tfbackend"
    if [[ ! -f "$tfvars" ]]; then
        cp "$checkout/terraform/environments/dev.tfvars.example" "$tfvars"
        sed -i.bak -E \
            -e "s/^environment[[:space:]]*=.*/environment = \"$ENVIRONMENT\"/" \
            -e "s/^aws_region[[:space:]]*=.*/aws_region  = \"$REGION\"/" \
            "$tfvars"
        rm -f "$tfvars.bak"
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
    AIDLC_CONFIG_DIR="$CONFIG_ROOT/terraform" \
        "$checkout/scripts/deploy-terraform.sh" "$ENVIRONMENT" --phase plan --plan-file "$plan"
    AIDLC_CONFIG_DIR="$CONFIG_ROOT/terraform" \
        "$checkout/scripts/deploy-terraform.sh" "$ENVIRONMENT" --phase apply --plan-file "$plan"
}

deploy_frontend() {
    local checkout="$1"
    if [[ "${VERSION%%.*}" -ge 2 ]]; then
        AIDLC_CONFIG_DIR="$CONFIG_ROOT/terraform" "$checkout/scripts/deploy-frontend.sh" "$ENVIRONMENT"
        return
    fi
    local tf="$checkout/terraform" frontend="$checkout/frontend" pool client domain bucket distribution
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
    local checkout="$1" role="$2" create_user="$3" pool
    pool="$(terraform -chdir="$checkout/terraform" output -raw user_pool_id)"
    if [[ "$create_user" == 1 ]]; then
        if ! aws cognito-idp admin-get-user --user-pool-id "$pool" --username "$ADMIN_USERNAME" >/dev/null 2>&1; then
            aws cognito-idp admin-create-user \
                --user-pool-id "$pool" --username "$ADMIN_USERNAME" \
                --temporary-password "$ADMIN_PASSWORD" --message-action SUPPRESS \
                --user-attributes "Name=email,Value=$ADMIN_USERNAME" "Name=email_verified,Value=true" >/dev/null
        fi
        aws cognito-idp admin-set-user-password \
            --user-pool-id "$pool" --username "$ADMIN_USERNAME" \
            --password "$ADMIN_PASSWORD" --permanent >/dev/null
    fi
    aws cognito-idp admin-add-user-to-group \
        --user-pool-id "$pool" --username "$ADMIN_USERNAME" --group-name "$role"
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

install_command() {
    require_commands
    [[ ! -L "$CURRENT_LINK" ]] || {
        echo "A managed installation already exists. Use update instead." >&2
        exit 1
    }
    prompt_admin
    aws_environment
    local checkout plan role plan_id
    select_checkout
    checkout="$TARGET_CHECKOUT"
    if [[ -n "$REF" ]]; then
        echo "Warning: --ref tracks mutable branch '$REF'; this is a non-release test deployment."
    fi
    confirm "Install $(target_description) into AWS environment $ENVIRONMENT?" || exit 1
    prompt_password
    configure_environment "$checkout"
    plan_id="v$VERSION"
    [[ -n "$REF" ]] && plan_id="${REF//\//-}-${RESOLVED_COMMIT:0:12}"
    plan="$DATA_ROOT/plans/$plan_id.tfplan"
    if [[ "${AIDLC_TEST_MODE:-0}" != 1 ]]; then
        if [[ "${VERSION%%.*}" -ge 2 ]]; then deploy_v2 "$checkout" "$plan"; else deploy_v1 "$checkout" "$plan"; fi
        role="owner"
        [[ "${VERSION%%.*}" -ge 2 ]] && role="platform-admin"
        configure_administrator "$checkout" "$role" 1
        deploy_frontend "$checkout"
    fi
    write_config
    switch_current "$checkout"
    unset ADMIN_PASSWORD AIDLC_ADMIN_PASSWORD || true
    echo "Installed $(target_description). Current checkout: $CURRENT_LINK"
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
    local old_checkout old_version old_commit checkout plan cmp plan_id
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
        [[ "$VERSION" != "$old_version" ]] || { echo "Already on AI-DLC v$VERSION."; exit 0; }
    fi
    prompt_admin
    if [[ -n "$REF" ]]; then
        echo "Warning: update is following mutable branch '$REF'."
    fi
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
        configure_administrator "$checkout" "$role" 0
        deploy_frontend "$checkout"
    fi
    write_config
    switch_current "$checkout"
    echo "Updated AI-DLC from v$old_version to $(target_description)."
}

status_command() {
    load_config
    local checkout version url="" commit
    checkout="$(current_checkout)"
    if [[ -z "$checkout" ]]; then
        echo "AI-DLC is not managed on this machine."
        exit 1
    fi
    version="$(current_version)"
    if command -v terraform >/dev/null 2>&1; then
        url="$(terraform -chdir="$checkout/terraform" output -raw cloudfront_domain_name 2>/dev/null || true)"
    fi
    echo "Version:     $version"
    echo "Environment: $ENVIRONMENT"
    echo "Region:      $REGION"
    echo "Checkout:    $checkout"
    echo "Config:      $CONFIG_ROOT"
    if [[ -n "$REF" ]]; then
        commit="$(git -C "$checkout" rev-parse --short=12 HEAD)"
        echo "Source:      $REF@$commit (non-release)"
    else
        echo "Source:      v$version"
    fi
    [[ -n "$url" ]] && echo "URL:         https://$url"
}

case "$COMMAND" in
    versions)
        sorted_versions
        ;;
    install) install_command ;;
    adopt) adopt_command ;;
    update) update_command ;;
    status) status_command ;;
    ""|-h|--help|help) usage ;;
    *) echo "Unknown command: $COMMAND" >&2; usage >&2; exit 2 ;;
esac

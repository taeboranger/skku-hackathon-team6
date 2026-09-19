#!/usr/bin/env bash
# Build, package and deploy the Campus app to AWS via CloudFormation.
#
#   ./aws/deploy.sh
#
# Override anything with environment variables:
#   STACK_NAME=my-stack REGION=ap-northeast-2 INSTANCE_TYPE=t3.small ./aws/deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STACK_NAME="${STACK_NAME:-skku-team6-campus}"
REGION="${REGION:-ap-northeast-2}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.small}"
VOLUME_SIZE_GB="${VOLUME_SIZE_GB:-20}"
ENV_FILE="${ENV_FILE:-aws/.env.aws}"
ENV_PARAM="${ENV_PARAM:-/campus/${STACK_NAME}/env}"
STAGE="$ROOT/.aws-build"

info() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 0. Preflight ──────────────────────────────────────────────────────
command -v aws >/dev/null || die "aws CLI not found. Install AWS CLI v2."
command -v corepack >/dev/null || die "corepack not found. Install Node.js 24."
aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 \
  || die "AWS credentials are not configured for region $REGION."

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text --region "$REGION")"
BUCKET="${BUCKET:-${STACK_NAME}-bundle-${ACCOUNT_ID}}"
BUNDLE_KEY="bundles/campus-$(date +%Y%m%d%H%M%S).tar.gz"

if [ ! -f "$ENV_FILE" ]; then
  if [ -f .dev.vars ]; then
    warn "$ENV_FILE not found; falling back to .dev.vars (local test values)."
    ENV_FILE=.dev.vars
  else
    die "No $ENV_FILE and no .dev.vars. Copy aws/.env.aws.example to $ENV_FILE and fill it in."
  fi
fi

info "Stack      : $STACK_NAME"
info "Region     : $REGION"
info "Instance   : $INSTANCE_TYPE"
info "Bundle S3  : s3://$BUCKET/$BUNDLE_KEY"
info "Config SSM : $ENV_PARAM  (from $ENV_FILE)"

# ── 1. Build ──────────────────────────────────────────────────────────
info "Installing dependencies"
corepack pnpm install --frozen-lockfile

info "Building server, web and WAM"
corepack pnpm build:cloudflare

# ── 2. Package ────────────────────────────────────────────────────────
info "Assembling deployment bundle"
rm -rf "$STAGE"
mkdir -p "$STAGE/cloudflare" "$STAGE/aws"

# pnpm deploy resolves the workspace dependency and produces a real,
# non-symlinked node_modules the instance can run as-is.
corepack pnpm deploy --filter=@tutorial/server --prod "$STAGE/server"

cp -R cloudflare/static "$STAGE/cloudflare/static"
cp -R cloudflare/migrations "$STAGE/cloudflare/migrations"
cp aws/server.mjs "$STAGE/aws/server.mjs"

BUNDLE="$ROOT/.aws-bundle.tar.gz"
rm -f "$BUNDLE"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$BUNDLE" -C "$STAGE" . 2>/dev/null \
  || tar -czf "$BUNDLE" -C "$STAGE" .
info "Bundle size: $(du -h "$BUNDLE" | cut -f1)"

# ── 3. Upload ─────────────────────────────────────────────────────────
if ! aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1; then
  info "Creating bundle bucket $BUCKET"
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  aws s3api put-public-access-block --bucket "$BUCKET" --region "$REGION" \
    --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
fi
info "Uploading bundle"
aws s3 cp "$BUNDLE" "s3://$BUCKET/$BUNDLE_KEY" --region "$REGION" >/dev/null

# ── 4. Application config -> SSM SecureString ─────────────────────────
# Secrets never enter the template, UserData or the CloudFormation console.
info "Publishing application config to SSM"
CONFIG="$(grep -Ev '^\s*(#|$)' "$ENV_FILE" || true)"
[ -n "$CONFIG" ] || die "$ENV_FILE has no values."
aws ssm put-parameter --name "$ENV_PARAM" --type SecureString \
  --value "$CONFIG" --overwrite --region "$REGION" >/dev/null

# ── 5. Network ────────────────────────────────────────────────────────
VPC_ID="${VPC_ID:-$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text --region "$REGION")}"
[ "$VPC_ID" != "None" ] && [ -n "$VPC_ID" ] \
  || die "No default VPC in $REGION. Set VPC_ID and SUBNET_ID explicitly."

SUBNET_ID="${SUBNET_ID:-$(aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=$VPC_ID" Name=map-public-ip-on-launch,Values=true \
  --query 'Subnets[0].SubnetId' --output text --region "$REGION")}"
[ "$SUBNET_ID" != "None" ] && [ -n "$SUBNET_ID" ] \
  || die "No public subnet in $VPC_ID. Set SUBNET_ID explicitly."
info "Network    : $VPC_ID / $SUBNET_ID"

# ── 6. Deploy the stack ───────────────────────────────────────────────
info "Deploying CloudFormation stack (first run takes ~5-10 min)"
aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file aws/cloudformation.yaml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "VpcId=$VPC_ID" \
    "SubnetId=$SUBNET_ID" \
    "BundleBucket=$BUCKET" \
    "BundleKey=$BUNDLE_KEY" \
    "EnvParameterName=$ENV_PARAM" \
    "InstanceType=$INSTANCE_TYPE" \
    "VolumeSizeGb=$VOLUME_SIZE_GB"

output() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
APP_URL="$(output AppUrl)"
INSTANCE_ID="$(output InstanceId)"

# ── 7. Pin APP_ORIGIN to the CloudFront domain ────────────────────────
# The app's CSRF check compares the browser Origin header against APP_ORIGIN,
# and the CloudFront domain only exists once the stack is up - so it is written
# back here and the service restarted.
if ! printf '%s\n' "$CONFIG" | grep -q "^APP_ORIGIN=$APP_URL$"; then
  info "Setting APP_ORIGIN=$APP_URL and restarting the service"
  CONFIG="$(printf '%s\n' "$CONFIG" | grep -v '^APP_ORIGIN=' || true)"
  CONFIG="$(printf '%s\nAPP_ORIGIN=%s\n' "$CONFIG" "$APP_URL")"
  aws ssm put-parameter --name "$ENV_PARAM" --type SecureString \
    --value "$CONFIG" --overwrite --region "$REGION" >/dev/null

  CMD_ID="$(aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --region "$REGION" \
    --parameters "commands=[\"aws ssm get-parameter --name '$ENV_PARAM' --with-decryption --region $REGION --query Parameter.Value --output text > /etc/campus.env\",\"chmod 600 /etc/campus.env\",\"systemctl restart campus.service\"]" \
    --query Command.CommandId --output text)"
  aws ssm wait command-executed --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --region "$REGION" 2>/dev/null || warn "Restart command did not report success; check the instance."
fi

# ── 8. Verify ─────────────────────────────────────────────────────────
info "Waiting for the app to answer through CloudFront"
for attempt in $(seq 1 40); do
  HEALTH="$(curl -fsS --max-time 10 "$APP_URL/api/health" 2>/dev/null || true)"
  if [ "$HEALTH" = '{"ok":true}' ]; then
    READY="$(curl -fsS --max-time 10 "$APP_URL/api/ready" 2>/dev/null || true)"
    printf '\n'
    info "Deployed"
    info "  URL        : $APP_URL"
    info "  /api/health: $HEALTH"
    info "  /api/ready : ${READY:-unavailable}"
    info "  Instance   : aws ssm start-session --target $INSTANCE_ID --region $REGION"
    info "  Logs       : sudo journalctl -u campus -f"
    exit 0
  fi
  printf '.'
  sleep 15
done

printf '\n'
warn "App did not answer at $APP_URL within ~10 minutes."
warn "CloudFront can take a few minutes to propagate on a first deploy."
warn "Check the instance: aws ssm start-session --target $INSTANCE_ID --region $REGION"
warn "Then: sudo journalctl -u campus -n 100 --no-pager; sudo cat /var/log/campus-bootstrap.log"
exit 1

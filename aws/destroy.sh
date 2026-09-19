#!/usr/bin/env bash
# Tear down the throwaway AWS deployment created by aws/deploy.sh.
set -euo pipefail

STACK_NAME="${STACK_NAME:-skku-team6-campus}"
REGION="${REGION:-ap-northeast-2}"
ENV_PARAM="${ENV_PARAM:-/campus/${STACK_NAME}/env}"

info() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text --region "$REGION")"
BUCKET="${BUCKET:-${STACK_NAME}-bundle-${ACCOUNT_ID}}"

cat <<WARNING

  This permanently deletes:
    - CloudFormation stack : $STACK_NAME  ($REGION)
    - the EC2 instance and its EBS volume, including the SQLite database
    - the CloudFront distribution and its URL
    - the SSM parameter    : $ENV_PARAM
    - the bundle bucket    : s3://$BUCKET

WARNING
read -r -p "Type the stack name to confirm: " confirm
[ "$confirm" = "$STACK_NAME" ] || { echo "Aborted."; exit 1; }

info "Deleting stack (CloudFront can take ~15 minutes)"
aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION"

info "Deleting SSM parameter"
aws ssm delete-parameter --name "$ENV_PARAM" --region "$REGION" 2>/dev/null || true

info "Emptying and deleting bundle bucket"
aws s3 rm "s3://$BUCKET" --recursive --region "$REGION" >/dev/null 2>&1 || true
aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null || true

info "Done."

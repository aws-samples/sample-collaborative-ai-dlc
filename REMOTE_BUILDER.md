# Option A — Native amd64 Remote Buildx Builder

Solves the agents image build failing on Apple Silicon with `exit code 139` (SIGSEGV) during `uv python install 3.12`. Root cause: the Terraform build pins `platform = "linux/amd64"` (`terraform/modules/compute/agents/main.tf:88`), and building amd64 on an arm64 Mac goes through QEMU emulation, which segfaults on the `uv`/Python installer.

Fix: run the actual build on a **native amd64 host** via a remote `docker buildx` builder, so no emulation happens. Fargate stays x86 (no architecture change to the running service). This is base-infrastructure tooling — unrelated to the Bitbucket feature, which is already verified at the code (Level 2) and infra-provisioning (Level 3: all Bitbucket API Gateway resources created) levels.

---

## Approach: remote buildx builder on an amd64 EC2 instance

`docker buildx` can execute a build on a remote Docker engine. Point it at a small amd64 EC2 instance; buildx builds natively there and pushes to ECR. Locally you only orchestrate — Podman/QEMU is not involved in the amd64 build anymore.

### Prerequisites

- AWS CLI + profile (you have this), region **eu-central-1**.
- An SSH keypair in eu-central-1 (or create one below).
- Local Docker/Podman CLI with `buildx` (Podman ships buildx-compatible tooling; if `docker buildx version` fails locally, install Docker CLI + buildx, or use Docker Desktop's `docker` which coexists with Podman).

---

## Step 1 — Launch an amd64 build host

```bash
# Amazon Linux 2023, amd64, in eu-central-1. Adjust key name / SG / subnet.
aws ec2 run-instances \
  --region eu-central-1 \
  --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --instance-type c7i.large \
  --key-name <your-keypair> \
  --security-group-ids <sg-allowing-your-ip-on-22> \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=amd64-buildx}]' \
  --query 'Instances[0].InstanceId' --output text

```

Get its public IP once running:

```bash
aws ec2 describe-instances --region eu-central-1 \
  --filters Name=tag:Name,Values=amd64-buildx Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].PublicIpAddress' --output text

```

## Step 2 — Install Docker on the build host

```bash
ssh ec2-user@<ip> '
  sudo dnf install -y docker &&
  sudo systemctl enable --now docker &&
  sudo usermod -aG docker ec2-user
'
# reconnect so the docker group applies
ssh ec2-user@<ip> 'docker version'

```

## Step 3 — Create a remote buildx builder locally

```bash
# A docker context that points at the remote engine over SSH
docker context create amd64-ec2 --docker "host=ssh://ec2-user@<ip>"

# A buildx builder that uses that context (native amd64, no emulation)
docker buildx create --name amd64-remote --driver docker-container --use amd64-ec2
docker buildx inspect --bootstrap amd64-remote   # should report platform linux/amd64

```

## Step 4 — Give the build host push access to ECR

The build uses `--push`. buildx resolves registry auth from your **local** Docker config, so logging in locally is normally enough:

```bash
aws ecr get-login-password --region eu-central-1 \
  | docker login --username AWS --password-stdin \
    "$(aws sts get-caller-identity --query Account --output text).dkr.ecr.eu-central-1.amazonaws.com"

```

> If pushes fail with auth errors, the alternative is to attach an IAM role with ECR push permissions to the EC2 instance and `docker login` on the host itself.

## Step 5 — Point Terraform at the remote builder

In `terraform/modules/compute/agents/main.tf` (and the equivalent yjs-server build if it also fails), change the builder name:

```hcl
-  builder = "default"
+  builder = "amd64-remote"

```

Leave `platform = "linux/amd64"` as-is — the remote host is amd64, so it builds natively.

## Step 6 — Re-deploy

```bash
cd /Users/smoell/development/kiro/sample-collaborative-ai-dlc
./scripts/deploy-terraform.sh dev

```

The agents (and yjs-server) images now build on the EC2 host without QEMU, push to ECR, and the rest of the apply proceeds.

## Step 7 — Tear down the builder when done (cost control)

```bash
docker buildx rm amd64-remote
docker context rm amd64-ec2
aws ec2 terminate-instances --region eu-central-1 --instance-ids <instance-id>

```

---

## Caveats / honesty

- **Registry auth forwarding** (Step 4) is the part most likely to need the IAM-role fallback; if `--push` fails, switch to instance-role auth on the host.
- The **yjs-server** image (`lambda/yjs-server/Dockerfile`) may build fine locally (it's lighter), but if it also segfaults, apply the same `builder` change to its module.
- This is **base-infrastructure setup**, not part of the Bitbucket feature. It should NOT go into the Bitbucket branch/PR.
- Simpler alternative if this proves fiddly: build the agents image in **AWS CodeBuild** (native amd64) and have Terraform reference the pre-built ECR image instead of building it — a larger restructuring, but fully cloud-native with no local Docker at all.
